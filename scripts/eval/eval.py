#!/usr/bin/env python3
"""RAGAS evaluation harness for Memory Bank. Calls live API, fetches chunk text from Postgres, runs RAGAS metrics."""

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table
from rich import box
from ragas import evaluate, EvaluationDataset
from ragas.dataset_schema import SingleTurnSample
from ragas.metrics import (
    _Faithfulness as Faithfulness,
    _AnswerRelevancy as AnswerRelevancy,
    _LLMContextPrecisionWithReference as ContextPrecision,
    _LLMContextRecall as ContextRecall,
    _AnswerCorrectness as AnswerCorrectness,
)
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from langchain_openai import ChatOpenAI, OpenAIEmbeddings


@dataclass
class TestCase:
    """One row in dataset.json: the question, group, tags, fixture docs, and optional ground truth."""

    id: str
    group: int
    tags: list[str]
    question: str
    fixture_docs: list[str]
    ground_truth: Optional[str]
    notes: str


@dataclass
class RunResult:
    """Collected outputs for a single test case: the API answer, retrieved contexts, RAGAS scores, and any error."""

    test_case_id: str
    question: str
    answer: str
    contexts: list[str]
    ground_truth: Optional[str]
    sources: list[dict]
    metrics: dict = field(default_factory=dict)
    error: Optional[str] = None
    duration_ms: int = 0


def build_arg_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser.

    Returns:
        argparse.ArgumentParser: Parser configured with --base-url, --db-url,
            --dataset, --output, and --tags flags.
    """
    parser = argparse.ArgumentParser(
        description="RAGAS evaluation harness for Memory Bank"
    )
    parser.add_argument(
        "--base-url",
        default="http://localhost:3000",
        help="Base URL of the Memory Bank API (default: http://localhost:3000)",
    )
    parser.add_argument(
        "--db-url",
        default=None,
        help="PostgreSQL connection URL (default: DATABASE_URL env var)",
    )
    parser.add_argument(
        "--dataset",
        default=str(Path(__file__).parent / "dataset.json"),
        help="Path to the dataset JSON file",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output JSON file path (default: eval_results_{timestamp}.json)",
    )
    parser.add_argument(
        "--tags",
        nargs="*",
        help="Filter test cases by tag (keep cases matching ANY of the given tags)",
    )
    return parser


def load_dataset(path: Path, tag_filter: list[str]) -> list[TestCase]:
    """Load and parse dataset.json into TestCase objects.

    Args:
        path (Path): Path to the dataset JSON file.
        tag_filter (list[str]): If non-empty, keep only cases whose tags
            overlap this set.

    Returns:
        list[TestCase]: Parsed test cases, filtered by tag when tag_filter
            is non-empty.

    Raises:
        FileNotFoundError: If the dataset file does not exist.
        ValueError: If the JSON root is not an array.
    """
    if not path.exists():
        raise FileNotFoundError(f"Dataset file not found: {path}")

    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    if not isinstance(raw, list):
        raise ValueError(f"Dataset must be a JSON array, got {type(raw).__name__}")

    cases = []
    for entry in raw:
        tc = TestCase(
            id=entry["id"],
            group=entry["group"],
            tags=entry.get("tags", []),
            question=entry["question"],
            fixture_docs=entry.get("fixture_docs", []),
            ground_truth=entry.get("ground_truth"),
            notes=entry.get("notes", ""),
        )
        cases.append(tc)

    if tag_filter:
        tag_set = set(tag_filter)
        cases = [tc for tc in cases if any(t in tag_set for t in tc.tags)]

    return cases


def create_session(base_url: str, client: httpx.Client) -> str:
    """Create a new chat session via POST /api/chat/sessions.

    Args:
        base_url (str): Base URL of the Memory Bank API.
        client (httpx.Client): Shared HTTP client.

    Returns:
        str: The new session ID.

    Raises:
        RuntimeError: If the API returns a non-201 status code.
    """
    url = f"{base_url}/api/chat/sessions"
    response = client.post(url, json={"title": "ragas-eval"})
    if response.status_code != 201:
        raise RuntimeError(
            f"Failed to create session: {response.status_code} {response.text}"
        )
    response_json = response.json()
    return response_json["data"]["id"]


def send_message(
    base_url: str,
    session_id: str,
    question: str,
    client: httpx.Client,
    timeout_s: float = 120.0,
) -> tuple[str, list[dict]]:
    """Send a question to the chat API and consume the SSE stream.

    Args:
        base_url (str): Base URL of the Memory Bank API.
        session_id (str): ID of the chat session to post to.
        question (str): User question to send.
        client (httpx.Client): Shared HTTP client.
        timeout_s (float): Request timeout in seconds.

    Returns:
        tuple[str, list[dict]]: Full answer text and the list of source
            objects from the ``done`` SSE event.

    Raises:
        RuntimeError: If the SSE stream contains an ``error`` event.
    """
    url = f"{base_url}/api/chat/sessions/{session_id}/messages"

    buffer = ""
    answer = ""
    sources = []
    done = False

    with client.stream(
        "POST", url, json={"message": question}, timeout=timeout_s
    ) as r:
        r.raise_for_status()
        for raw_bytes in r.iter_bytes():
            buffer += raw_bytes.decode("utf-8", errors="replace")
            while "\n\n" in buffer:
                block, buffer = buffer.split("\n\n", 1)
                for line in block.splitlines():
                    if line.startswith("data: "):
                        payload = json.loads(line[6:])
                        if payload["type"] == "delta":
                            answer += payload["content"]
                        elif payload["type"] == "done":
                            sources = payload.get("sources", [])
                            done = True
                        elif payload["type"] == "error":
                            raise RuntimeError(
                                f"API stream error: {payload.get('message')}"
                            )

    return answer, sources


def fetch_chunk_contents(db_url: str, chunk_ids: list[str]) -> dict[str, str]:
    """Fetch chunk text from Postgres for a list of chunk UUIDs.

    Args:
        db_url (str): PostgreSQL connection URL.
        chunk_ids (list[str]): Chunk UUIDs to look up.

    Returns:
        dict[str, str]: Mapping of chunk ID to content text.
    """
    conn = None
    try:
        conn = psycopg2.connect(db_url)
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                "SELECT id::text, content FROM chunks WHERE id = ANY(%s::uuid[])",
                (chunk_ids,),
            )
            rows = cur.fetchall()
        return {row["id"]: row["content"] for row in rows}
    finally:
        if conn is not None:
            conn.close()


def build_contexts(
    sources: list[dict], chunk_contents: dict[str, str]
) -> list[str]:
    """Map SSE source objects to their chunk text.

    Args:
        sources (list[dict]): Source objects from the SSE ``done`` event,
            ordered by relevance score.
        chunk_contents (dict[str, str]): Chunk ID to content mapping.

    Returns:
        list[str]: Chunk texts in source order; entries whose ID is absent
            from chunk_contents are skipped.
    """
    contexts = []
    for source in sources:
        chunk_id = source.get("chunkId")
        if chunk_id and chunk_id in chunk_contents:
            contexts.append(chunk_contents[chunk_id])
    return contexts


def run_test_case(
    tc: TestCase,
    base_url: str,
    db_url: str,
    client: httpx.Client,
) -> RunResult:
    """Execute one test case end-to-end against the live API.

    Creates a session, sends the question, fetches chunk text from Postgres,
    and packages the result. All exceptions are caught and stored in
    ``RunResult.error`` rather than propagated.

    Args:
        tc (TestCase): The test case to run.
        base_url (str): Base URL of the Memory Bank API.
        db_url (str): PostgreSQL connection URL.
        client (httpx.Client): Shared HTTP client.

    Returns:
        RunResult: Populated result including answer, contexts, and duration.
            On failure, ``error`` is set and other fields are empty.
    """
    start_ms = int(time.time() * 1000)
    try:
        session_id = create_session(base_url, client)
        answer, sources = send_message(base_url, session_id, tc.question, client)

        chunk_ids = [s["chunkId"] for s in sources if "chunkId" in s]
        chunk_contents = fetch_chunk_contents(db_url, chunk_ids) if chunk_ids else {}
        contexts = build_contexts(sources, chunk_contents)

        duration_ms = int(time.time() * 1000) - start_ms
        return RunResult(
            test_case_id=tc.id,
            question=tc.question,
            answer=answer,
            contexts=contexts,
            ground_truth=tc.ground_truth,
            sources=sources,
            duration_ms=duration_ms,
        )
    except Exception as e:
        duration_ms = int(time.time() * 1000) - start_ms
        return RunResult(
            test_case_id=tc.id,
            question=tc.question,
            answer="",
            contexts=[],
            ground_truth=tc.ground_truth,
            sources=[],
            error=str(e),
            duration_ms=duration_ms,
        )


def build_ragas_llm_and_embeddings(openai_api_key: str):
    """Construct the LLM and embeddings wrappers used by RAGAS metrics.

    Args:
        openai_api_key (str): OpenAI API key.

    Returns:
        tuple[LangchainLLMWrapper, LangchainEmbeddingsWrapper]: GPT-4o LLM
            wrapper and text-embedding-3-large embeddings wrapper.
    """
    llm = LangchainLLMWrapper(
        ChatOpenAI(model="gpt-4o", api_key=openai_api_key, temperature=0)
    )
    embeddings = LangchainEmbeddingsWrapper(
        OpenAIEmbeddings(model="text-embedding-3-large", api_key=openai_api_key)
    )
    return llm, embeddings


def evaluate_group(
    results: list[RunResult],
    metrics: list,
    has_ground_truth: bool,
) -> list[RunResult]:
    """Run RAGAS evaluate() over a batch of results and attach scores in-place.

    Args:
        results (list[RunResult]): Results to evaluate; errored entries are
            skipped.
        metrics (list): RAGAS metric instances to compute.
        has_ground_truth (bool): Whether to populate the ``reference`` field
            for metrics that require ground truth.

    Returns:
        list[RunResult]: The same list with ``metrics`` dicts populated on
            successful entries.
    """
    valid = [(i, r) for i, r in enumerate(results) if r.error is None]
    if not valid:
        return results

    indices, valid_results = zip(*valid)

    samples = [
        SingleTurnSample(
            user_input=r.question,
            response=r.answer,
            retrieved_contexts=r.contexts,
            reference=r.ground_truth if has_ground_truth else None,
        )
        for r in valid_results
    ]
    dataset = EvaluationDataset(samples=samples)

    eval_result = evaluate(dataset, metrics=metrics)

    scores_df = eval_result.to_pandas()
    non_data_cols = {"user_input", "response", "retrieved_contexts", "reference"}

    for row_idx, result_idx in enumerate(indices):
        row = scores_df.iloc[row_idx]
        metric_scores = {}
        for col in scores_df.columns:
            if col not in non_data_cols:
                val = row[col]
                if val is not None and not (isinstance(val, float) and val != val):
                    metric_scores[col] = float(val)
        results[result_idx].metrics = metric_scores

    return results


def compute_aggregate_stats(results: list[RunResult]) -> dict:
    """Compute per-metric aggregate statistics across all successful results.

    Args:
        results (list[RunResult]): All run results; errored entries are
            excluded.

    Returns:
        dict: Mapping of metric name to ``{"mean": float, "min": float,
            "max": float}``.
    """
    metric_values: dict[str, list[float]] = {}
    for r in results:
        if r.error is not None:
            continue
        for metric_name, value in r.metrics.items():
            metric_values.setdefault(metric_name, []).append(value)

    stats = {}
    for metric_name, values in metric_values.items():
        stats[metric_name] = {
            "mean": sum(values) / len(values),
            "min": min(values),
            "max": max(values),
        }
    return stats


def _score_style(score: Optional[float]) -> str:
    """Return a Rich colour name for a metric score.

    Args:
        score (Optional[float]): Metric score, or None.

    Returns:
        str: ``"green"`` for score >= 0.7, ``"yellow"`` for >= 0.4,
            ``"red"`` for < 0.4, ``"white"`` for None.
    """
    if score is None:
        return "white"
    if score >= 0.7:
        return "green"
    if score >= 0.4:
        return "yellow"
    return "red"


def _fmt_score(score: Optional[float], dash: bool = False) -> str:
    """Format a metric score for table display.

    Args:
        score (Optional[float]): Metric score, or None.
        dash (bool): If True, return ``"—"`` regardless of score.

    Returns:
        str: ``"—"`` when dash is True, ``"n/a"`` when score is None,
            otherwise the score formatted to two decimal places.
    """
    if dash:
        return "—"
    if score is None:
        return "n/a"
    return f"{score:.2f}"


def print_results_table(results: list[RunResult], console: Console) -> None:
    """Render a colour-coded Rich table of evaluation results to the console.

    Args:
        results (list[RunResult]): Results to display.
        console (Console): Rich console to print to.
    """
    table = Table(
        box=box.SIMPLE_HEAVY,
        show_header=True,
        header_style="bold cyan",
        title="RAGAS Evaluation Results",
    )

    table.add_column("ID", style="bold", min_width=6)
    table.add_column("Question", max_width=50)
    table.add_column("G", justify="center", min_width=3)
    table.add_column("Faithful", justify="right", min_width=8)
    table.add_column("AnsRel", justify="right", min_width=7)
    table.add_column("CtxPrec", justify="right", min_width=8)
    table.add_column("CtxRecall", justify="right", min_width=9)
    table.add_column("AnsCorr", justify="right", min_width=8)
    table.add_column("Error", style="red", min_width=10)

    for r in results:
        group = getattr(r, "_group", 0)
        question_display = r.question[:47] + "..." if len(r.question) > 50 else r.question

        if r.error is not None:
            table.add_row(
                r.test_case_id,
                question_display,
                str(group),
                "—", "—", "—", "—", "—",
                f"[red]{r.error[:60]}[/red]",
            )
            continue

        is_group1 = group == 1

        faithful = r.metrics.get("faithfulness")
        ans_rel = r.metrics.get("answer_relevancy")
        ctx_prec = r.metrics.get("context_precision")
        ctx_recall = r.metrics.get("context_recall")
        ans_corr = r.metrics.get("answer_correctness")

        table.add_row(
            r.test_case_id,
            question_display,
            str(group),
            f"[{_score_style(faithful)}]{_fmt_score(faithful)}[/]",
            f"[{_score_style(ans_rel)}]{_fmt_score(ans_rel)}[/]",
            f"[{_score_style(ctx_prec)}]{_fmt_score(ctx_prec, dash=is_group1)}[/]",
            f"[{_score_style(ctx_recall)}]{_fmt_score(ctx_recall, dash=is_group1)}[/]",
            f"[{_score_style(ans_corr)}]{_fmt_score(ans_corr, dash=is_group1)}[/]",
            "",
        )

    console.print(table)


def write_output_json(
    results: list[RunResult],
    output_path: Path,
    metadata: dict,
) -> None:
    """Serialise results and aggregate stats to a JSON file.

    Args:
        results (list[RunResult]): All run results to include.
        output_path (Path): Destination file path.
        metadata (dict): Run metadata with keys ``run_at``, ``base_url``,
            and ``dataset``.
    """
    aggregate = compute_aggregate_stats(results)
    skipped = sum(1 for r in results if r.error is not None)

    output = {
        "run_at": metadata.get("run_at", datetime.now(timezone.utc).isoformat()),
        "base_url": metadata.get("base_url", ""),
        "dataset": metadata.get("dataset", ""),
        "total_cases": len(results),
        "skipped_cases": skipped,
        "results": [
            {
                "test_case_id": r.test_case_id,
                "question": r.question,
                "answer": r.answer,
                "contexts": r.contexts,
                "ground_truth": r.ground_truth,
                "sources": r.sources,
                "metrics": r.metrics,
                "error": r.error,
                "duration_ms": r.duration_ms,
            }
            for r in results
        ],
        "aggregate": aggregate,
    }

    output_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    """Parse arguments, run all test cases, evaluate with RAGAS, and write output.

    Exits with status 1 if DATABASE_URL or OPENAI_API_KEY are missing.
    """
    load_dotenv()

    parser = build_arg_parser()
    args = parser.parse_args()

    db_url = args.db_url or os.environ.get("DATABASE_URL")
    if not db_url:
        print(
            "ERROR: No database URL provided. Use --db-url or set DATABASE_URL.",
            file=sys.stderr,
        )
        sys.exit(1)

    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        print("ERROR: OPENAI_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    console = Console()

    console.print("[bold cyan]Building RAGAS LLM and embeddings...[/bold cyan]")
    llm, embeddings = build_ragas_llm_and_embeddings(openai_api_key)

    dataset_path = Path(args.dataset)
    tag_filter = args.tags or []

    console.print(f"[bold cyan]Loading dataset from {dataset_path}...[/bold cyan]")
    test_cases = load_dataset(dataset_path, tag_filter)
    console.print(f"Loaded [bold]{len(test_cases)}[/bold] test case(s)")

    run_at = datetime.now(timezone.utc).isoformat()

    if args.output:
        output_path = Path(args.output)
    else:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        output_path = Path(__file__).parent / "eval_results" / f"eval_results_{timestamp}.json"

    console.print(
        f"\n[bold cyan]Running {len(test_cases)} test case(s) against {args.base_url}...[/bold cyan]\n"
    )

    all_results: list[RunResult] = []
    group_map: dict[str, int] = {tc.id: tc.group for tc in test_cases}

    with httpx.Client(timeout=None) as client:
        for i, tc in enumerate(test_cases, 1):
            console.print(
                f"  [{i}/{len(test_cases)}] [bold]{tc.id}[/bold] — {tc.question[:60]}..."
                if len(tc.question) > 60
                else f"  [{i}/{len(test_cases)}] [bold]{tc.id}[/bold] — {tc.question}"
            )
            result = run_test_case(tc, args.base_url, db_url, client)
            result._group = tc.group  # type: ignore[attr-defined]
            all_results.append(result)

            if result.error:
                console.print(f"    [red]ERROR: {result.error}[/red]")
            else:
                console.print(
                    f"    [green]OK[/green] — {len(result.contexts)} context(s), {result.duration_ms}ms"
                )

    group1_results = [r for r in all_results if group_map.get(r.test_case_id) == 1]
    group2_results = [r for r in all_results if group_map.get(r.test_case_id) == 2]

    if group1_results:
        console.print("\n[bold cyan]Evaluating Group 1 (no ground truth)...[/bold cyan]")
        group1_metrics = [
            Faithfulness(llm=llm),
            AnswerRelevancy(llm=llm, embeddings=embeddings),
        ]
        group1_results = evaluate_group(
            group1_results,
            metrics=group1_metrics,
            has_ground_truth=False,
        )

    if group2_results:
        console.print("\n[bold cyan]Evaluating Group 2 (with ground truth)...[/bold cyan]")
        group2_metrics = [
            Faithfulness(llm=llm),
            AnswerRelevancy(llm=llm, embeddings=embeddings),
            ContextPrecision(llm=llm),
            ContextRecall(llm=llm),
            AnswerCorrectness(llm=llm, embeddings=embeddings),
        ]
        group2_results = evaluate_group(
            group2_results,
            metrics=group2_metrics,
            has_ground_truth=True,
        )

    combined: list[RunResult] = []
    g1_map = {r.test_case_id: r for r in group1_results}
    g2_map = {r.test_case_id: r for r in group2_results}
    for r in all_results:
        if r.test_case_id in g1_map:
            combined.append(g1_map[r.test_case_id])
        elif r.test_case_id in g2_map:
            combined.append(g2_map[r.test_case_id])
        else:
            combined.append(r)

    console.print()
    print_results_table(combined, console)

    metadata = {
        "run_at": run_at,
        "base_url": args.base_url,
        "dataset": "/" + str(dataset_path.resolve().relative_to(Path(__file__).resolve().parents[2])),
    }
    write_output_json(combined, output_path, metadata)

    successful = sum(1 for r in combined if r.error is None)
    skipped = len(combined) - successful
    console.print(
        f"\n[bold green]Done.[/bold green] {successful}/{len(combined)} cases succeeded"
        + (f", {skipped} skipped" if skipped else "")
        + f". Results written to [bold]{output_path}[/bold]"
    )


if __name__ == "__main__":
    main()

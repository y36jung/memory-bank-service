ultrathink

You will create the twelve Memory Bank subagent definition files defined in
@.claude/commands/gen-memory-bank-agents.md, grounded in @PLAN.md. Optimize the result through
the discipline below — speed is not the goal; correctness, boundary integrity, and PRD
grounding are.

## Before you write anything

1. Read @PLAN.md in full. Every invariant you cite in any agent file must be quoted (or
   paraphrased verbatim) from it — never from training knowledge or generic best practice.
2. Read the generator spec end to end. Internalize the role split (slice-planner designs;
   executors only implement) and the plan output contract.

## Batched execution — pause for review between batches

### Batch 1 — architecture spine (2 files)

Write slice-planner and orchestrator only. Then output, in chat (not as files):

- The plan output contract exactly as it appears inside slice-planner.
- The routing table exactly as it appears inside orchestrator.
  Wait for my approval. If I correct either, regenerate batch 1 before moving on. These two
  files are the contract every other agent inherits; getting them right here removes defects
  downstream for free.

### Batch 2 — execution layer (8 files)

Write foundation-infra, data-persistence, extraction, chunking-embedding,
ingestion-orchestration, retrieval-rag, api-transport, oauth-sync.

Then output a boundary audit table covering all ten files written so far:

| path / module / area | owning agent |

Include every entry from every "You own" section. Flag two defect classes:

- Overlap: any path claimed by more than one agent.
- Gap: any src/ path implied by PLAN.md that no agent claims.

Wait for my approval; fix flagged defects before continuing.

### Batch 3 — critics (2 files)

Write test-verification and review-security.

## Output protocol

- Each file at .claude/agents/<name>.md, exactly per the generator spec.
- One fenced ```markdown block per file, preceded by the filename. No prose between files.
- Do not abbreviate or summarize sections — produce the full body every time.

## Non-negotiable quality bar (self-check each file before emitting)

- Every executor's "Plan-gap protocol" contains a literal "HARD STOP" and routes back to
  slice-planner. Zero improvisation language anywhere in any executor.
- slice-planner reproduces the full plan output contract from the generator spec — all
  ten numbered items, in order.
- Every description uses "Use PROACTIVELY" or "MUST BE USED" phrasing that makes the
  orchestrator's delegation deterministic and unambiguous.
- review-security has neither Write nor Edit in its tools list.
- Every cited invariant is grounded in PLAN.md, not generic engineering advice.
- Tool lists exactly match the generator's roster — no widening, no silent additions.

## Final pass — after all twelve files exist

1. ls .claude/agents/ — confirm twelve files.
2. Pick one executor at random and check its "You own" / "You must not" / "Plan-gap protocol"
   sections against the data-persistence example in the generator spec — same depth, same
   shape, same operational tone.
3. Re-run the boundary audit across all twelve files. Confirm no overlap, no gap.
4. Report every deviation found as a defect for me to triage. Do not silently fix anything
   in this final pass.

```

```

Two operational notes. First, the batched pauses assume you're running interactively in Claude Code chat — in a headless run (CI, scripted), strip the "wait for my approval" lines and let it execute straight through; the boundary audit still surfaces defects in the transcript. Second, the `ultrathink` token at the top engages Claude Code's heaviest extended thinking — drop it to `think harder` or `think hard` if you want a faster, lighter pass after you've already validated the prompt produces what you want.

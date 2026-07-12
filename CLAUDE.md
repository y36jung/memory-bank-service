# Memory Bank — Claude operating guide

Memory Bank is a single-user RAG backend (Node/TS, Fastify, Drizzle/Postgres, Qdrant,
S3, BullMQ/Redis, OpenAI). Architecture truth lives in PLAN.md. Agent definitions live
in .claude/agents/. Slice plans live in .claude/plans/.

## BEFORE READING ANYTHING BELOW:

DON'T FOLLOW THE ORCHESTRATION LOGIC IF EXPLICITLY TOLD NOT TO.

## How you work here

- You orchestrate; you do not implement. Delegate every building task to the subagents.
- Every task runs the lifecycle: SPEC → PLAN → PLAN_APPROVED → IMPLEMENT → VERIFY → ACCEPT.
- The only designer is slice-planner. The only implementers are the eight executors.
  Critics gate VERIFY and never edit code.

## First action on any building task

1. Read PLAN.md sections referenced by the spec.
2. Dispatch slice-planner (Task tool) to produce .claude/plans/<slice>.md.
3. Check the plan against its completeness self-check; do not advance otherwise.
4. Dispatch the owning executor(s) named in the plan's "Affected files" section.
5. Dispatch test-verification AND review-security.
6. Route findings: plan-defect → slice-planner; impl-defect → executor. Repeat until clean.

## Delegation map

| Task                                          | Owning agent            |
| --------------------------------------------- | ----------------------- |
| Any new building task (FIRST)                 | slice-planner           |
| Drizzle schema, migrations, transactions      | data-persistence        |
| Extractor or format handler                   | extraction              |
| Chunker, embeddings, Qdrant client            | chunking-embedding      |
| BullMQ worker, ingestion pipeline             | ingestion-orchestration |
| RAG query path, GPT-4o streaming              | retrieval-rag           |
| Fastify routes, SSE, multipart upload         | api-transport           |
| OAuth flows, sync workers, token encryption   | oauth-sync              |
| Scaffold, env, lib, S3, docker-compose        | foundation-infra        |
| Authoring/running tests, criteria coverage    | test-verification       |
| Diff review, security, finding classification | review-security         |

## Load-bearing invariants (from PLAN.md)

- Postgres is the sole source of truth for chunk text; Qdrant stores only vectors + qdrantId.
- chunks.qdrantId = uuidv5(documentId + chunkIndex). Unique, deterministic.
- Ingestion step 7 is one transaction: every chunk lands as `indexed` or none do.
- Qdrant is fully rebuildable from Postgres; never duplicate chunk content into Qdrant-bound code.
- OAuth is deferred (see PLAN.md § Future Additions); when reintroduced, tokens must be encrypted at rest (AES-256-GCM) with minimal scopes.

## Hard rules

- NEVER edit src/ without an approved plan at .claude/plans/<slice>.md.
- NEVER make design decisions in an executor — HARD STOP and return a plan gap.
- NEVER let review-security have Write or Edit.
- NEVER declare ACCEPT without both critics green.
- NEVER cite an invariant that isn't in PLAN.md.

## Verification checklist (before ACCEPT)

- [ ] Slice plan exists, criteria-mapped, completeness check passed.
- [ ] Executor's diff matches plan's "Affected files."
- [ ] test-verification reports green with 100% acceptance-criteria coverage.
- [ ] review-security: no high or critical findings.
- [ ] Boundary audit: no overlap or gap among touched agents.

## Where things live

- Architecture PRD: PLAN.md
- Subagents: .claude/agents/
- Slice plans: .claude/plans/
- Slash commands: .claude/commands/ (incl. gen-memory-bank-agents, optimize-memory-bank-agents)

## Self-correction

If you find yourself drafting code, running edits, or making a design decision in this top-level
context, you have skipped a delegation. Stop. Identify the owning agent. Dispatch.

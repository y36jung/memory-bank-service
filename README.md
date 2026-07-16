# 🧠 Memory Bank

A RAG backend that lets you chat with your personal knowledge base — uploaded documents, emails, and cloud files.

## 🤔 Problems

### 1. Siloed knowledge base

Personal knowledge is scattered across physical notes, local files, email inboxes, and cloud storage. There is no unified way to search across all of it, and keyword search fails to surface contextually relevant information when you don't know the exact words used.

### 2. Document organisation

Organising documents, dates, reminders manually are too much of a hassle from time to time, especially when piled with work. For environments with an AI-first mindset, pace of work will be faster than before. In order to keep up with this pace, more cognitive resources should be allocated to work that "actually matters".

### 3. Flawed human memory

People forget. More so when we are forced to memorize larger amounts of information, and retrieve them at appropriate settings. Similarly to the point above, we want to deallocate these resources and delegate them to some "secondary storage".

## 💡 Solution

Create a memory dump that acts as a "second brain". This storage should act as a centralized platform of personal knowledge, where all sources of knowledge such as notes, reminders, emails, documents, etc. can be stored conveniently.

Upon ingestion, automated flows should run to properly organise bits of information based on like knowledge topics. Users have the option to query stored information via a conversation.

## 🎯 Technical Solution

Build a RAG backend that ingests content from personal knowledge sources — starting with file uploads, with email and cloud-drive sync (Gmail, Google Drive, Outlook, OneDrive) planned as a future addition — indexes it, and answers natural-language questions with cited sources.

## 📋 Product Specifications

| #   | Requirement                                                                              | Acceptance Criteria                                                                    |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Users can ingest information via typed input or drag-and-drop file upload                | Supported file types are accepted; unsupported types are rejected with a clear error   |
| 2   | The service automatically organises ingested content into coherent knowledge topics      | Chunks are embedded and retrievable by semantic similarity without manual tagging      |
| 3   | The chatbot returns accurate, source-cited answers grounded in the user's knowledge base | Responses include citations; the model declines to answer when context is insufficient |

> Metrics TBD — define precision/recall targets and upload success-rate thresholds before M1 sign-off.

## 📖 Description

Memory Bank ingests content from file uploads, chunks and embeds it using OpenAI, and answers natural-language questions with GPT-4o over a streaming SSE response. Postgres is the single source of truth for all content; Qdrant serves as the vector index and is fully rebuildable at any time.

Built with: **Node.js + TypeScript**, **Fastify**, **Drizzle ORM**, **PostgreSQL**, **Qdrant**, **BullMQ + Redis**, **AWS S3**, **OpenAI GPT-4o + Whisper + text-embedding-3-large**.

## ✨ Key Features

- 📥 **File upload ingestion** — upload files (`.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.xlsx`); email/cloud-drive sync (Gmail, Google Drive, Outlook, OneDrive) is planned as a future addition
- 🎙️ **Media support** — audio transcription via Whisper, image/video understanding via GPT-4o Vision
- 🔄 **Durable ingestion pipeline** — BullMQ-backed 11-step pipeline with per-step timeouts, automatic retries, and a supervisor backstop
- 💬 **Streaming RAG** — real-time GPT-4o answers with cited sources streamed over SSE
- 🔁 **Idempotent vector indexing** — deterministic Qdrant point IDs (`uuidv5(documentId + chunkIndex)`) make retries safe with no duplicates

## 🚀 Installation & Usage

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- `ffmpeg` (required for audio/video extraction)
- AWS S3 bucket and credentials
- OpenAI API key

### 1. Clone and install

```bash
git clone <repo-url>
cd memory-bank-service
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the required values in `.env`:

### 3. Start infrastructure

```bash
docker compose up -d
```

This starts Postgres (`:5432`), Redis (`:6379`), Qdrant (`:6333`), and pgAdmin (`:5050`).

### 4. Run migrations

```bash
npm run db:migrate
```

### 5. Start the server

```bash
npm start
```

The API is available at `http://localhost:3000/api/v1`.

### 6. (Optional) Rebuild Qdrant from Postgres

If the Qdrant collection is lost or corrupted, re-embed all chunks without touching S3:

```bash
npx tsx scripts/rebuild-qdrant.ts
```

### 🛠️ Development commands

```bash
npm test          # Run Vitest test suite
npm run typecheck # TypeScript type checking
npm run lint      # ESLint
npm run format    # Prettier
```

## 📊 RAG Evaluation (promptfoo)

`rag-eval/` is a self-contained [promptfoo](https://www.promptfoo.dev/) suite that measures RAG quality against a live Memory Bank instance: retrieval precision, semantic-gap paraphrase queries, cross-domain negatives, multi-source conflicts, citation correctness, and delete/re-ingest lifecycle staleness. Each test case pairs a retrieval-layer `javascript` assertion (checking the actual chunks returned via `context.metadata.sources`) with an `llm-rubric`/`contains` check on the final answer, so a retrieval bug and a generation bug fail distinguishably.

It replaces an earlier Python/RAGAS harness that predated this service's JWT auth rollout and no longer worked.

### Prerequisites

- Memory Bank server running (`npm start`)
- Docker Compose services running (`docker compose up -d`)
- An `OPENAI_API_KEY` (used by promptfoo's `llm-rubric` grading)

### 1. Install and configure

```bash
cd rag-eval
npm install
cp .env.example .env   # fill in OPENAI_API_KEY and eval-user credentials
```

The eval user is registered automatically (or logged in, if it already exists) by the setup script — no manual account creation needed.

### 2. Upload fixtures and wait for indexing

```bash
npm run setup
```

### 3. Run the eval suite

```bash
npm run eval    # retrieval_precision, semantic_gap, cross_domain_negative, multi_source_conflict, citation_correctness
npm run view    # inspect results in promptfoo's local UI
```

### 4. Run the lifecycle suite

The delete/re-ingest cases need ordered state changes a single `promptfoo eval` run can't express, so they run via a dedicated script:

```bash
npm run eval:lifecycle
```

### All-in-one

```bash
npm run eval:all   # setup && eval && eval:lifecycle
```

When a case fails, check whether it's the `javascript` retrieval assertion or the `llm-rubric` answer assertion that failed — they test different layers. A retrieval-assert failure means bad chunking/embedding/search; a rubric-only failure with retrieval passing means a prompting or generation problem.

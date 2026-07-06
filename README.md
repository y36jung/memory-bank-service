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

## 📊 RAG Evaluation (RAGAS)

`scripts/eval/` contains a Python-based evaluation harness that measures RAG quality using [RAGAS](https://docs.ragas.io/). It calls the live Memory Bank API, fetches retrieved chunk text from Postgres, and runs RAGAS metrics across 15 test cases covering single-chunk lookup, cross-document synthesis, CSV structured queries, vocabulary mismatch, top-k saturation, and more.

### Metrics

| Group                 | Test cases    | Metrics                                                       |
| --------------------- | ------------- | ------------------------------------------------------------- |
| 1 — no ground truth   | tc-01 → tc-06 | `faithfulness`, `answer_relevancy`                            |
| 2 — with ground truth | tc-07 → tc-19 | + `context_precision`, `context_recall`, `answer_correctness` |

### Prerequisites

- Memory Bank server running (`npm start`)
- Docker Compose services running (`docker compose up -d`)
- Python 3.10+
- `OPENAI_API_KEY` in `.env`

### 1. Set up Python environment

```bash
python3 -m venv scripts/eval/.venv
source scripts/eval/.venv/bin/activate   # Windows: scripts\eval\.venv\Scripts\activate
pip install -r scripts/eval/requirements.txt
python scripts/eval/setup_shim.py
```

> **Note:** `setup_shim.py` adds a one-line compatibility stub for `langchain_community.chat_models.vertexai`, which RAGAS imports unconditionally but `langchain` v1.x removed. This must be run once after every fresh `pip install`.

### 2. Upload fixture documents

Upload the synthetic fixture documents and wait for indexing to complete:

```bash
for f in scripts/eval/fixtures/*; do
  curl -s -X POST http://localhost:3000/api/documents/upload -F "file=@$f" | jq .
done

# Poll until all documents show "status": "indexed"
curl -s http://localhost:3000/api/documents | jq '[.data[] | {name:.originalName, status:.status}]'
```

### 3. Run the full eval suite

```bash
python scripts/eval/eval.py \
  --db-url "postgresql://memory_bank:dev-password@localhost:5432/memory_bank_service_db"
```

Results are printed as a colour-coded table and saved to `eval_results_{timestamp}.json`.

### 4. Filter by tag for faster iteration

```bash
# Quick smoke test — single-chunk and factual cases only
python scripts/eval/eval.py --tags single-chunk factual

# Cross-document synthesis cases
python scripts/eval/eval.py --tags cross-doc

# Retrieval edge cases
python scripts/eval/eval.py --tags topk-saturation vocab-mismatch chunk-boundary
```

### 5. Verify re-index idempotency (tc-19)

```bash
python scripts/eval/eval.py --tags re-index --output before_reindex.json

# Delete and re-upload rest_api_guide.md, then wait for re-indexing...

python scripts/eval/eval.py --tags re-index --output after_reindex.json

python3 -c "
import json
b = json.load(open('before_reindex.json'))['results'][0]['metrics']
a = json.load(open('after_reindex.json'))['results'][0]['metrics']
for k in b: print(f'{k}: {b[k]:.3f} -> {a[k]:.3f}  diff={abs(b[k]-a[k]):.3f}')
"
```

Scores should be identical within ±0.05 across runs.

### CLI reference

```
python scripts/eval/eval.py [options]

Options:
  --base-url URL    Memory Bank API base URL (default: http://localhost:3000)
  --db-url URL      Postgres connection string (default: DATABASE_URL env var)
  --dataset PATH    Path to dataset JSON (default: scripts/eval/dataset.json)
  --output PATH     Output JSON file (default: eval_results_{timestamp}.json)
  --tags TAG [...]  Filter test cases by tag (ANY match)
```

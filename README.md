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

Build a RAG backend that ingests content from every personal knowledge source — file uploads, Gmail, Google Drive, Outlook, and OneDrive — indexes it, and answers natural-language questions with cited sources.

## 📋 Product Specifications

| #   | Requirement                                                                              | Acceptance Criteria                                                                    |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Users can ingest information via typed input or drag-and-drop file upload                | Supported file types are accepted; unsupported types are rejected with a clear error   |
| 2   | The service automatically organises ingested content into coherent knowledge topics      | Chunks are embedded and retrievable by semantic similarity without manual tagging      |
| 3   | The chatbot returns accurate, source-cited answers grounded in the user's knowledge base | Responses include citations; the model declines to answer when context is insufficient |

> Metrics TBD — define precision/recall targets and upload success-rate thresholds before M1 sign-off.

## 📖 Description

Memory Bank ingests content from multiple sources (file uploads, Gmail, Google Drive), chunks and embeds it using OpenAI, and answers natural-language questions with GPT-4o over a streaming SSE response. Postgres is the single source of truth for all content; Qdrant serves as the vector index and is fully rebuildable at any time.

Built with: **Node.js + TypeScript**, **Fastify**, **Drizzle ORM**, **PostgreSQL**, **Qdrant**, **BullMQ + Redis**, **AWS S3**, **OpenAI GPT-4o + Whisper + text-embedding-3-large**.

## ✨ Key Features

- 📥 **Multi-source ingestion** — upload files (`.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.xlsx`) or sync from Gmail, Google Drive, Outlook, and OneDrive via OAuth 2.0
- 🎙️ **Media support** — audio transcription via Whisper, image/video understanding via GPT-4o Vision
- 🔄 **Durable ingestion pipeline** — BullMQ-backed 11-step pipeline with per-step timeouts, automatic retries, and a supervisor backstop
- 💬 **Streaming RAG** — real-time GPT-4o answers with cited sources streamed over SSE
- 🔁 **Idempotent vector indexing** — deterministic Qdrant point IDs (`uuidv5(documentId + chunkIndex)`) make retries safe with no duplicates
- 🔐 **Encrypted OAuth tokens** — access/refresh tokens stored with AES-256-GCM encryption at rest

## 🚀 Installation & Usage

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- `ffmpeg` (required for audio/video extraction)
- AWS S3 bucket and credentials
- OpenAI API key
- Google OAuth credentials (for Gmail/Drive sync)

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

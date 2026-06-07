# 🧠 Memory Bank

A RAG backend that lets you chat with your personal knowledge base — uploaded documents, emails, and cloud files.

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

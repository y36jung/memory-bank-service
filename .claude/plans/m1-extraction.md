# m1-extraction — File Extractors for M1 Formats

**Owning executor:** extraction  
**Plan status:** Ready for implementation

> **Package gap (orchestrator note):** `mammoth`, `csv-parse`, and `xlsx` are absent from `package.json`. The `foundation-infra` executor must install them (and `@aws-sdk/client-s3`, `uuid`) before this executor runs. See m1-foundation.md.

---

## 1. Slice + linked spec/PRD sections

Sub-slice of Milestone 1 (orchestration plan: `implement-milestone-1-of-iridescent-aho.md`, Step 3 Phase 2b). Owning executor: **extraction**.

| PLAN.md section                           | Relevance                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| §Extractor Map                            | Canonical MIME → extractor table for every M1 format                                                          |
| §Data Ingestion Pipeline → Step 4 EXTRACT | Contract: `extractText(file)` returns plain text; orchestrator wraps with `withTimeout(…, 60_000, 'extract')` |
| §Project Structure                        | Mandates exact paths under `src/services/extractor/`                                                          |
| §Milestone 1 deliverable #6               | "Extractors: `.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.xlsx`"                                                 |
| §Milestone 1 deliverable #17              | "Vitest unit tests for chunker, extractor, and retrieval logic"                                               |

**Library deviation:** PLAN.md mentions `pdf-parse`, but `package.json` ships `pdfjs-dist@^5.2.133`. This slice uses the legacy ESM build (`pdfjs-dist/legacy/build/pdf.mjs`) for Node compatibility.

---

## 2. Acceptance criteria, verbatim

From PLAN.md Milestone 1 deliverables:

> **Deliverable 6.** Extractors: `.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.xlsx`

> **Deliverable 17.** Vitest unit tests for chunker, extractor, and retrieval logic

From PLAN.md Step 4 EXTRACT:

> EXTRACT ← timeout: 60s  
> `withTimeout(extractText(file), 60_000, 'extract')`  
> Parse raw content into plain text (see extractor map below)

Derived acceptance criteria (AC):

- **AC-E1.** `index.ts` exposes `extractText(key: string, mimeType: string): Promise<string>` that dispatches by MIME type.
- **AC-E2.** `extractText` downloads source bytes from S3 using `storage.getStream()`.
- **AC-E3.** `extractText` handles `text/plain` and `text/markdown` inline by streaming the S3 object to a UTF-8 string.
- **AC-E4.** `extractText` throws `AppError` with code `UNSUPPORTED_FORMAT` for any MIME type not in the supported set.
- **AC-E5.** Supported MIME types are exactly: `text/plain`, `text/markdown`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- **AC-E6.** `pdf.ts` exposes `extractPdf(buffer: Buffer): Promise<string>` implemented with `pdfjs-dist`.
- **AC-E7.** `docx.ts` exposes `extractDocx(buffer: Buffer): Promise<string>` implemented with `mammoth` (`extractRawText`).
- **AC-E8.** `spreadsheet.ts` exposes `extractSpreadsheet(buffer: Buffer, mimeType: string): Promise<string>` using `csv-parse` for CSV and `xlsx` for XLSX; rows emitted as tab-separated text.
- **AC-E9.** Slice depends only on `src/services/storage.ts`, `src/lib/errors.ts`, and `src/config/env.ts` from foundation-infra.

---

## 3. Design overview

A thin **dispatcher** (`index.ts`) is the single public entry point used by the ingestion worker:

1. **I/O**: fetch raw bytes via `storage.getStream(key)`. Decode stream to string for plaintext MIME types; buffer to `Buffer` for PDF/DOCX/XLSX/CSV (all require full in-memory data).
2. **Dispatch**: route by normalised MIME type to one of four handlers. Anything else throws `AppError('UNSUPPORTED_FORMAT', …)`.

The orchestrator wraps the call with `withTimeout(extractText(…), 60_000, 'extract')`; this slice embeds no internal watchdog.

Format-specific decisions:

- **pdfjs-dist legacy build** (`pdfjs-dist/legacy/build/pdf.mjs`) — only build that runs in Node without a browser worker. Workers disabled, font resolution suppressed. Pages joined with `'\n\n'`.
- **mammoth.extractRawText** — correct input for the chunker; HTML conversion would require a second extraction step.
- **Spreadsheets → TSV** — CSV re-parsed (RFC-4180, `relax_quotes: true`) then emitted as TSV; XLSX every sheet serialised to TSV with `# Sheet: <name>` headers. Re-emission normalises CSV escapes before the chunker.
- **MIME normalisation** — lower-case, trim, strip parameters after `;` (handles `text/csv; charset=utf-8`).

---

## 4. Affected files

All files are new. All owned by **extraction** executor.

| Action | Path                                    | Owner      |
| ------ | --------------------------------------- | ---------- |
| create | `src/services/extractor/index.ts`       | extraction |
| create | `src/services/extractor/pdf.ts`         | extraction |
| create | `src/services/extractor/docx.ts`        | extraction |
| create | `src/services/extractor/spreadsheet.ts` | extraction |

This slice does **not** create: `audio.ts`, `image.ts`, `video.ts` (M2), or any test files (test-verification owns those).

---

## 5. Signatures & data structures

### `src/services/extractor/index.ts`

```typescript
export const SUPPORTED_MIME_TYPES = {
  TEXT_PLAIN: 'text/plain',
  TEXT_MARKDOWN: 'text/markdown',
  APPLICATION_PDF: 'application/pdf',
  APPLICATION_DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TEXT_CSV: 'text/csv',
  APPLICATION_XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[keyof typeof SUPPORTED_MIME_TYPES];

export async function extractText(key: string, mimeType: string): Promise<string>;

// Internal (not exported):
async function streamToUtf8String(stream: NodeJS.ReadableStream): Promise<string>;
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer>;
function normaliseMimeType(raw: string): string; // lower-case, trim, strip after ';'
```

### `src/services/extractor/pdf.ts`

```typescript
export async function extractPdf(buffer: Buffer): Promise<string>;
// Uses pdfjs-dist/legacy/build/pdf.mjs
// getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, disableFontFace: true })
// Pages joined with '\n\n'
```

### `src/services/extractor/docx.ts`

```typescript
export async function extractDocx(buffer: Buffer): Promise<string>;
// await mammoth.extractRawText({ buffer }) → .value
```

### `src/services/extractor/spreadsheet.ts`

```typescript
export async function extractSpreadsheet(buffer: Buffer, mimeType: string): Promise<string>;
// CSV: csv-parse/sync parse(buffer, { bom: true, relax_quotes: true }) → rows → TSV
// XLSX: XLSX.read(buffer, { type: 'buffer' }) → each sheet → TSV with '# Sheet: <name>\n' header
// Throws AppError('UNSUPPORTED_FORMAT', ...) if mimeType is neither CSV nor XLSX

// Internal:
function tsvEscape(cell: unknown): string; // replace \t \n \r with single space
function rowToTsv(row: ReadonlyArray<unknown>): string; // join with '\t'
```

### Error contract

```typescript
import { AppError } from '../../lib/errors.js';
throw new AppError('UNSUPPORTED_FORMAT', `Unsupported MIME type: ${mimeType}`);
```

If foundation-infra's `AppError` constructor differs from `(code: string, message: string)`, extraction executor must HARD STOP and report a plan gap.

---

## 6. Interfaces

### Consumed (from foundation-infra)

| Symbol                   | Source                    | Use                                                   |
| ------------------------ | ------------------------- | ----------------------------------------------------- |
| `storage.getStream(key)` | `src/services/storage.ts` | Returns `Promise<NodeJS.ReadableStream>` of S3 object |
| `AppError`               | `src/lib/errors.ts`       | Thrown with code `'UNSUPPORTED_FORMAT'`               |

### Produced (consumed by ingestion-orchestration)

```typescript
import { extractText } from '../../services/extractor/index.js';

const text = await withTimeout(
  extractText(document.storageKey, document.mimeType),
  60_000,
  'extract',
);
```

`extractPdf`, `extractDocx`, `extractSpreadsheet`, and `SUPPORTED_MIME_TYPES` are also exported for test-verification fixture tests.

### Module resolution notes

- All intra-project imports use `.js` extension (NodeNext ESM).
- `pdfjs-dist/legacy/build/pdf.mjs` — supported Node entry per v5 docs.
- `import mammoth from 'mammoth'` (default export).
- `import { parse } from 'csv-parse/sync'` — buffer-in / array-out.
- `import * as XLSX from 'xlsx'`.

---

## 7. Invariants upheld

- **"Postgres is the sole source of truth for chunk text; Qdrant stores only vectors + qdrantId."** — This slice produces only a `string`; it writes nothing to Postgres, Qdrant, or any payload.
- **PLAN.md §Pipeline step 4: `withTimeout(extractText(file), 60_000, 'extract')`** — `extractText` is a plain `Promise<string>` with no internal timeout; orchestrator owns the timeout.
- **§Project Structure paths upheld** — files land at `src/services/extractor/{index,pdf,docx,spreadsheet}.ts`.
- **No M2 work in M1** — `audio.ts`, `image.ts`, `video.ts` intentionally absent.
- **Trust `documents.mime_type` in M1** — `file-type` byte-level sniffing is M2 scope.

---

## 8. Edge cases & failure modes

| #   | Scenario                                              | Behaviour                                                                                                   |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | MIME type not in `SUPPORTED_MIME_TYPES`               | `throw new AppError('UNSUPPORTED_FORMAT', ...)` — no fallback                                               |
| 2   | Empty file (0 bytes)                                  | All extractors return `''`; chunker produces 0 chunks — valid                                               |
| 3   | UTF-8 invalid bytes in plaintext                      | `TextDecoder('utf-8', { fatal: false })` replaces with `�`                                                  |
| 4   | Password-protected PDF                                | pdfjs-dist throws `PasswordException` — propagate; BullMQ retries then marks `failed`                       |
| 5   | Corrupt PDF                                           | pdfjs-dist throws `InvalidPDFException` — propagate                                                         |
| 6   | PDF with image-only pages                             | `getTextContent()` returns empty items; extracted text is empty string — indexed with low recall; OCR is M2 |
| 7   | Corrupt DOCX (not a valid ZIP)                        | mammoth throws via JSZip — propagate                                                                        |
| 8   | DOCX with embedded media                              | `extractRawText` ignores non-text runs — no exception                                                       |
| 9   | CSV with embedded commas/quotes/newlines              | csv-parse handles RFC-4180 escapes; re-emitted as TSV                                                       |
| 10  | CSV cell containing literal `\t` or `\n`              | `tsvEscape` replaces with single space (TSV has no escape sequences)                                        |
| 11  | XLSX with multiple sheets                             | Each emitted as `# Sheet: <name>\n<TSV>\n\n`                                                                |
| 12  | XLSX with empty sheet                                 | `# Sheet: <name>` header still emitted, empty TSV body                                                      |
| 13  | XLSX with formulas                                    | Use cached cell value (`.v`); if undefined treat as `''`                                                    |
| 14  | XLSX with dates                                       | Coerce serial numbers to ISO-8601 when cell type is `'d'`                                                   |
| 15  | Spreadsheet handler called with wrong MIME            | Defensive `AppError('UNSUPPORTED_FORMAT', ...)` in `extractSpreadsheet`                                     |
| 16  | S3 `getStream` rejects                                | Propagate unchanged; orchestrator's `withTimeout` + BullMQ retry handles it                                 |
| 17  | MIME with parameters (e.g. `text/csv; charset=utf-8`) | `normaliseMimeType` strips parameters after `;` before dispatch                                             |

---

## 9. Criterion → implementation → proof table

| Criterion | Implementation element                                          | File             | Proof (test-verification authors)                                                                         |
| --------- | --------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| AC-E1     | `extractText` switch on `normaliseMimeType(mimeType)`           | `index.ts`       | Unit: each supported MIME routes to correct handler                                                       |
| AC-E2     | `await storage.getStream(key)` inside `extractText`             | `index.ts`       | Unit: mock `storage.getStream`; assert called with supplied key                                           |
| AC-E3     | `streamToUtf8String` path for `text/plain` / `text/markdown`    | `index.ts`       | Unit: stream fixture string → assert exact equality                                                       |
| AC-E4     | `throw new AppError('UNSUPPORTED_FORMAT', …)` in default branch | `index.ts`       | Unit: `extractText('k', 'application/zip')` rejects with `AppError` code `'UNSUPPORTED_FORMAT'`           |
| AC-E5     | `SUPPORTED_MIME_TYPES` constant values                          | `index.ts`       | Unit: `Object.values(SUPPORTED_MIME_TYPES)` deep-equals spec list                                         |
| AC-E6     | pdfjs-dist `getDocument` + per-page `getTextContent`            | `pdf.ts`         | Unit: 2-page fixture PDF → string contains both pages' text joined by `\n\n`                              |
| AC-E7     | `mammoth.extractRawText({ buffer }).value`                      | `docx.ts`        | Unit: fixture `.docx` → string equals known plaintext                                                     |
| AC-E8     | csv-parse for CSV, XLSX.read for XLSX, both → TSV               | `spreadsheet.ts` | Unit a: CSV fixture with quoted commas → TSV; Unit b: 2-sheet XLSX → both `# Sheet:` headers + TSV bodies |
| AC-E9     | Imports limited to storage, errors, library packages            | all four files   | Static: grep imports; build `tsc --noEmit` passes                                                         |

---

## 10. Completeness self-check

| Check                                                                                                                                 | Result                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Every AC in §2 mapped in §9                                                                                                           | Pass (AC-E1–E9 all mapped)    |
| Every owned file in §4 has signatures in §5                                                                                           | Pass (4 files, 4+ signatures) |
| All interface boundaries named with symbol paths in §6                                                                                | Pass                          |
| No TBD, "to-be-decided", "builder can decide"                                                                                         | Pass                          |
| No M2 work (audio/image/video) described or implied                                                                                   | Pass                          |
| Every invariant cites PLAN.md/CLAUDE.md source or marked slice-local                                                                  | Pass                          |
| Library deviation (`pdf-parse` → `pdfjs-dist`) called out with authority                                                              | Pass                          |
| Edge cases cover: empty file, password-protected PDF, corrupt DOCX, CSV escapes, multi-sheet XLSX, formula/date cells, malformed MIME | Pass                          |
| Error contract fully specified                                                                                                        | Pass                          |
| Missing packages flagged for orchestrator                                                                                             | Pass                          |

**Completeness self-check passes. Plan is ready for the extraction executor.**

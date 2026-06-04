import type { Readable } from 'node:stream';
import * as storage from '../storage.js';
import { AppError } from '../../lib/errors.js';
import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractSpreadsheet } from './spreadsheet.js';

// ---------------------------------------------------------------------------
// Supported MIME types (M1 scope)
// ---------------------------------------------------------------------------

export const SUPPORTED_MIME_TYPES = {
  TEXT_PLAIN: 'text/plain',
  TEXT_MARKDOWN: 'text/markdown',
  APPLICATION_PDF: 'application/pdf',
  APPLICATION_DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TEXT_CSV: 'text/csv',
  APPLICATION_XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[keyof typeof SUPPORTED_MIME_TYPES];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lower-case, trim, and strip MIME parameters (everything after the first ';').
 * Example: 'text/csv; charset=utf-8' → 'text/csv'
 */
function normaliseMimeType(raw: string): string {
  return (raw.split(';')[0] ?? raw).trim().toLowerCase();
}

/**
 * Collect all chunks from a Readable stream and decode as UTF-8.
 * Uses TextDecoder with fatal: false so invalid byte sequences are replaced
 * with the replacement character rather than throwing.
 */
async function streamToUtf8String(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(Buffer.concat(chunks));
}

/**
 * Collect all chunks from a Readable stream into a single Buffer.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Download a file from S3 and extract its plain-text content.
 *
 * - text/plain and text/markdown: decoded from the stream directly (UTF-8).
 * - application/pdf: buffered and parsed with pdfjs-dist.
 * - application/vnd…docx: buffered and parsed with mammoth.
 * - text/csv / application/vnd…xlsx: buffered and parsed with csv-parse / xlsx.
 * - Any other MIME type: throws AppError('UNSUPPORTED_FORMAT', …).
 *
 * The caller (ingestion worker) is responsible for wrapping this call with
 * withTimeout(extractText(…), 60_000, 'extract') — no internal watchdog here.
 */
export async function extractText(key: string, mimeType: string): Promise<string> {
  const normalised = normaliseMimeType(mimeType);
  const stream = await storage.getStream(key);

  switch (normalised) {
    case SUPPORTED_MIME_TYPES.TEXT_PLAIN:
    case SUPPORTED_MIME_TYPES.TEXT_MARKDOWN:
      return streamToUtf8String(stream);

    case SUPPORTED_MIME_TYPES.APPLICATION_PDF: {
      const buf = await streamToBuffer(stream);
      return extractPdf(buf);
    }

    case SUPPORTED_MIME_TYPES.APPLICATION_DOCX: {
      const buf = await streamToBuffer(stream);
      return extractDocx(buf);
    }

    case SUPPORTED_MIME_TYPES.TEXT_CSV:
    case SUPPORTED_MIME_TYPES.APPLICATION_XLSX: {
      const buf = await streamToBuffer(stream);
      return extractSpreadsheet(buf, normalised);
    }

    default:
      throw new AppError('UNSUPPORTED_FORMAT', `Unsupported MIME type: ${mimeType}`);
  }
}

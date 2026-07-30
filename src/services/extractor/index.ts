import type { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import * as storage from '../storage.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { extractPdfPages } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractSpreadsheet } from './spreadsheet.js';
import { extractImage } from './image.js';
import { extractAudio } from './audio.js';
import { extractVideo } from './video.js';
import { extractHtml } from './html.js';
import type { TranscribedSegment } from './audio.js';

// ---------------------------------------------------------------------------
// Supported MIME types
// ---------------------------------------------------------------------------

export const SUPPORTED_MIME_TYPES = {
  // M1 — text formats
  TEXT_PLAIN: 'text/plain',
  TEXT_MARKDOWN: 'text/markdown',
  TEXT_HTML: 'text/html',
  APPLICATION_PDF: 'application/pdf',
  APPLICATION_DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TEXT_CSV: 'text/csv',
  APPLICATION_XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // M2 — image formats
  IMAGE_JPEG: 'image/jpeg',
  IMAGE_PNG: 'image/png',
  IMAGE_GIF: 'image/gif',
  IMAGE_WEBP: 'image/webp',
  // M2 — audio formats
  AUDIO_MPEG: 'audio/mpeg',
  AUDIO_WAV: 'audio/wav',
  AUDIO_OGG: 'audio/ogg',
  AUDIO_MP4: 'audio/mp4',
  AUDIO_M4A: 'audio/x-m4a',
  // M2 — video formats
  VIDEO_MP4: 'video/mp4',
  VIDEO_MOV: 'video/quicktime',
  VIDEO_AVI: 'video/x-msvideo',
} as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[keyof typeof SUPPORTED_MIME_TYPES];

export interface ExtractOptions {
  onProgress?: (stage: string, pct: number) => Promise<void>;
}

export interface ExtractionResult {
  text: string;
  segments?: TranscribedSegment[]; // only populated for audio/video
  pages?: string[]; // only populated for PDFs — one string per page
}

/** extractText's return type: an ExtractionResult plus the MIME type it dispatched on. */
export type ExtractResult = ExtractionResult & { resolvedMimeType: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normaliseMimeType(raw: string): string {
  return (raw.split(';')[0] ?? raw).trim().toLowerCase();
}

async function streamToUtf8String(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(Buffer.concat(chunks));
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Best-effort sniff for HTML content in a buffer that carries a generic
 * `application/octet-stream` MIME type. `file-type`'s magic-byte detection
 * can never identify HTML (it has no binary signature), so this is the only
 * way to recognize an HTML upload that a client mislabeled as octet-stream.
 */
function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString('utf-8').replace(/^[\s﻿]+/, '');
  return /^(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(head);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Download a file from S3 and extract its plain-text content.
 *
 * Steps:
 *  1. S3 HeadObject size pre-check — rejects files above MAX_FILE_SIZE_BYTES.
 *  2. MIME detection via file-type on the first 4100 bytes.
 *  3. Dispatch to the appropriate extractor based on detected MIME type.
 *
 * The caller is responsible for wrapping this with withTimeout for media types.
 */
export async function extractText(
  key: string,
  mimeType: string,
  opts?: ExtractOptions,
): Promise<ExtractResult> {
  // Step 1: size pre-check
  const sizeBytes = await storage.headObject(key);
  if (sizeBytes !== null && sizeBytes > env.MAX_FILE_SIZE_BYTES) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `File size ${sizeBytes} bytes exceeds maximum of ${env.MAX_FILE_SIZE_BYTES} bytes`,
      400,
    );
  }

  // Step 2: MIME detection from first 4100 bytes
  const headerStream = await storage.getStream(key);
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  for await (const chunk of headerStream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    headerChunks.push(buf);
    headerBytes += buf.length;
    if (headerBytes >= 4100) break;
  }
  headerStream.destroy();
  const headerBuf = Buffer.from(Buffer.concat(headerChunks).subarray(0, 4100));
  const detected = await fileTypeFromBuffer(headerBuf);
  let resolvedMime = detected?.mime ?? normaliseMimeType(mimeType);

  // file-type can't detect HTML by magic bytes (it has none); fall back to a
  // content sniff when the client sent (or file-type inferred) a generic type.
  if (resolvedMime === 'application/octet-stream' && looksLikeHtml(headerBuf)) {
    resolvedMime = SUPPORTED_MIME_TYPES.TEXT_HTML;
  }

  // Step 3: dispatch
  if (resolvedMime.startsWith('image/')) {
    return { text: await extractImage(key, opts), resolvedMimeType: resolvedMime };
  }
  if (resolvedMime.startsWith('audio/')) {
    const r = await extractAudio(key, opts);
    return { text: r.text, segments: r.segments, resolvedMimeType: resolvedMime };
  }
  if (resolvedMime.startsWith('video/')) {
    const r = await extractVideo(key, opts);
    return { ...r, resolvedMimeType: resolvedMime };
  }

  // M1 text-based formats: get fresh stream
  const stream = await storage.getStream(key);

  switch (resolvedMime) {
    case SUPPORTED_MIME_TYPES.TEXT_PLAIN:
    case SUPPORTED_MIME_TYPES.TEXT_MARKDOWN:
      return { text: await streamToUtf8String(stream), resolvedMimeType: resolvedMime };

    case SUPPORTED_MIME_TYPES.TEXT_HTML: {
      const buf = await streamToBuffer(stream);
      return { text: extractHtml(buf), resolvedMimeType: resolvedMime };
    }

    case SUPPORTED_MIME_TYPES.APPLICATION_PDF: {
      const buf = await streamToBuffer(stream);
      const pageTexts = await extractPdfPages(buf);
      return { text: pageTexts.join('\n\n'), pages: pageTexts, resolvedMimeType: resolvedMime };
    }

    case SUPPORTED_MIME_TYPES.APPLICATION_DOCX: {
      const buf = await streamToBuffer(stream);
      return { text: await extractDocx(buf), resolvedMimeType: resolvedMime };
    }

    case SUPPORTED_MIME_TYPES.TEXT_CSV:
    case SUPPORTED_MIME_TYPES.APPLICATION_XLSX: {
      const buf = await streamToBuffer(stream);
      return { text: await extractSpreadsheet(buf, resolvedMime), resolvedMimeType: resolvedMime };
    }

    default:
      stream.destroy();
      throw new AppError('UNSUPPORTED_FORMAT', `Unsupported MIME type: ${resolvedMime}`);
  }
}

import type { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import * as storage from '../storage.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractSpreadsheet } from './spreadsheet.js';
import { extractImage } from './image.js';
import { extractAudio } from './audio.js';
import { extractVideo } from './video.js';

// ---------------------------------------------------------------------------
// Supported MIME types
// ---------------------------------------------------------------------------

export const SUPPORTED_MIME_TYPES = {
  // M1 — text formats
  TEXT_PLAIN: 'text/plain',
  TEXT_MARKDOWN: 'text/markdown',
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
): Promise<string> {
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
  const resolvedMime = detected?.mime ?? normaliseMimeType(mimeType);

  // Step 3: dispatch
  if (resolvedMime.startsWith('image/')) {
    return extractImage(key, opts);
  }
  if (resolvedMime.startsWith('audio/')) {
    return extractAudio(key, opts);
  }
  if (resolvedMime.startsWith('video/')) {
    return extractVideo(key, opts);
  }

  // M1 text-based formats: get fresh stream
  const stream = await storage.getStream(key);

  switch (resolvedMime) {
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
      return extractSpreadsheet(buf, resolvedMime);
    }

    default:
      stream.destroy();
      throw new AppError('UNSUPPORTED_FORMAT', `Unsupported MIME type: ${resolvedMime}`);
  }
}

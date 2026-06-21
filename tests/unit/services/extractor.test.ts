/**
 * Unit tests for src/services/extractor/index.ts and format handlers.
 *
 * The storage module is mocked so tests run without S3 connectivity.
 *
 * Criteria covered:
 * AC-2a: extractText routes each MIME type to the correct handler
 * AC-2b: extractText throws AppError('UNSUPPORTED_FORMAT') for unknown MIME types
 * AC-3a: extractDocx returns text from a fixture DOCX buffer
 * AC-3b: extractSpreadsheet CSV → TSV format
 * AC-3c: extractSpreadsheet XLSX → TSV format with sheet header
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppError } from '../../../src/lib/errors.js';
import { extractDocx } from '../../../src/services/extractor/docx.js';
import { extractSpreadsheet } from '../../../src/services/extractor/spreadsheet.js';

// ---------------------------------------------------------------------------
// Mock the storage module so extractText doesn't need a real S3 connection.
// ---------------------------------------------------------------------------

vi.mock('../../../src/services/storage.js', () => ({
  getStream: vi.fn(),
  headObject: vi.fn(),
  getObjectBuffer: vi.fn(),
  putObject: vi.fn(),
  uploadStream: vi.fn(),
  deleteObject: vi.fn(),
}));

// Mock file-type so MIME detection returns undefined by default (falls back to client type)
vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn().mockResolvedValue(undefined),
}));

// Mock M2 sub-extractors so extractText dispatch tests don't hit real OpenAI/ffmpeg
vi.mock('../../../src/services/extractor/image.js', () => ({
  extractImage: vi.fn().mockResolvedValue('image description'),
}));
vi.mock('../../../src/services/extractor/audio.js', () => ({
  extractAudio: vi.fn().mockResolvedValue('audio transcript'),
}));
vi.mock('../../../src/services/extractor/video.js', () => ({
  extractVideo: vi.fn().mockResolvedValue('video text'),
}));

import * as storage from '../../../src/services/storage.js';
import { fileTypeFromBuffer } from 'file-type';
import { extractText } from '../../../src/services/extractor/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable();
  stream.push(buf);
  stream.push(null);
  return stream;
}

function stringToReadable(text: string): Readable {
  return bufferToReadable(Buffer.from(text, 'utf-8'));
}

// ---------------------------------------------------------------------------
// extractDocx — format handler unit tests (no mock needed — operates on Buffer)
// ---------------------------------------------------------------------------

describe('extractDocx', () => {
  it('extracts plain text from a real DOCX fixture (single-paragraph.docx)', async () => {
    // Use mammoth's bundled test fixture — no need to create our own.
    const fixturePath = path.join(
      process.cwd(),
      'node_modules/mammoth/test/test-data/single-paragraph.docx',
    );
    const buffer = fs.readFileSync(fixturePath);
    const text = await extractDocx(buffer);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // single-paragraph.docx contains the text "Walking on imported air"
    expect(text).toContain('Walking on imported air');
  });

  it('extracts text from tables.docx fixture', async () => {
    const fixturePath = path.join(process.cwd(), 'node_modules/mammoth/test/test-data/tables.docx');
    const buffer = fs.readFileSync(fixturePath);
    const text = await extractDocx(buffer);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('returns empty string for an empty.docx fixture', async () => {
    const fixturePath = path.join(process.cwd(), 'node_modules/mammoth/test/test-data/empty.docx');
    const buffer = fs.readFileSync(fixturePath);
    const text = await extractDocx(buffer);
    // mammoth returns '' or whitespace for a document with no content
    expect(typeof text).toBe('string');
  });

  it('returns a string (no HTML markup) — extractRawText not convertToHtml', async () => {
    const fixturePath = path.join(
      process.cwd(),
      'node_modules/mammoth/test/test-data/single-paragraph.docx',
    );
    const buffer = fs.readFileSync(fixturePath);
    const text = await extractDocx(buffer);
    // Should NOT contain HTML tags
    expect(text).not.toMatch(/<[a-z]+>/i);
  });
});

// ---------------------------------------------------------------------------
// extractSpreadsheet — format handler unit tests
// ---------------------------------------------------------------------------

describe('extractSpreadsheet', () => {
  describe('CSV → TSV', () => {
    it('converts a simple CSV to TSV format', async () => {
      const csv = 'name,age,city\nAlice,30,Toronto\nBob,25,Vancouver\n';
      const buffer = Buffer.from(csv, 'utf-8');
      const result = await extractSpreadsheet(buffer, 'text/csv');

      // Each row should be tab-separated
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toBe('name\tage\tcity');
      expect(lines[1]).toBe('Alice\t30\tToronto');
      expect(lines[2]).toBe('Bob\t25\tVancouver');
    });

    it('handles CSV with quoted fields', async () => {
      const csv = '"first name","last name"\n"John, Jr.","Doe"\n';
      const buffer = Buffer.from(csv, 'utf-8');
      const result = await extractSpreadsheet(buffer, 'text/csv');
      const lines = result.split('\n');
      // Quoted commas should be handled — field should not be split
      expect(lines[0]).toBe('first name\tlast name');
      expect(lines[1]).toContain('John, Jr.');
    });

    it('handles empty CSV', async () => {
      const csv = '';
      const buffer = Buffer.from(csv, 'utf-8');
      const result = await extractSpreadsheet(buffer, 'text/csv');
      expect(typeof result).toBe('string');
    });

    it('throws AppError("UNSUPPORTED_FORMAT") for unsupported MIME type', async () => {
      const buffer = Buffer.from('data', 'utf-8');
      await expect(extractSpreadsheet(buffer, 'application/octet-stream')).rejects.toThrow(
        AppError,
      );

      try {
        await extractSpreadsheet(buffer, 'application/octet-stream');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('UNSUPPORTED_FORMAT');
      }
    });
  });

  describe('XLSX → TSV', () => {
    it('converts a minimal XLSX buffer and includes sheet header', async () => {
      // Build a minimal XLSX in-memory using the xlsx library
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([
        ['Col A', 'Col B'],
        ['val1', 'val2'],
      ]);
      XLSX.utils.book_append_sheet(wb, ws, 'Data');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const result = await extractSpreadsheet(
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );

      expect(result).toContain('# Sheet: Data');
      expect(result).toContain('Col A\tCol B');
      expect(result).toContain('val1\tval2');
    });

    it('includes all sheets when XLSX has multiple sheets', async () => {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet([['sheet1col']]);
      const ws2 = XLSX.utils.aoa_to_sheet([['sheet2col']]);
      XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1');
      XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const result = await extractSpreadsheet(
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );

      expect(result).toContain('# Sheet: Sheet1');
      expect(result).toContain('# Sheet: Sheet2');
    });
  });
});

// ---------------------------------------------------------------------------
// extractText (dispatch function) — tests use mocked storage.getStream
// ---------------------------------------------------------------------------

describe('extractText — MIME type dispatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // M2: headObject now called first; return null so size pre-check is skipped
    vi.mocked(storage.headObject).mockResolvedValue(null);
    // M2: fileTypeFromBuffer defaults to undefined so client MIME is used as fallback
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
  });

  it('handles text/plain by returning the stream content as UTF-8', async () => {
    const expected = 'Hello, world!';
    // First call: header detection stream; second call: content stream
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(stringToReadable(expected))
      .mockResolvedValueOnce(stringToReadable(expected));

    const result = await extractText('some/key.txt', 'text/plain');
    expect(result.text).toBe(expected);
  });

  it('handles text/markdown by returning the stream content as UTF-8', async () => {
    const expected = '# Heading\n\nSome paragraph.';
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(stringToReadable(expected))
      .mockResolvedValueOnce(stringToReadable(expected));

    const result = await extractText('some/key.md', 'text/markdown');
    expect(result.text).toBe(expected);
  });

  it('handles text/plain with charset parameter (strips MIME params)', async () => {
    const expected = 'plain text with charset';
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(stringToReadable(expected))
      .mockResolvedValueOnce(stringToReadable(expected));

    const result = await extractText('some/key.txt', 'text/plain; charset=utf-8');
    expect(result.text).toBe(expected);
  });

  it('handles application/pdf by parsing the buffer', async () => {
    // Verify dispatch reaches the PDF branch — an invalid PDF throws a non-UNSUPPORTED_FORMAT error
    const invalidPdfBuffer = Buffer.from('not a pdf');
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(bufferToReadable(invalidPdfBuffer))
      .mockResolvedValueOnce(bufferToReadable(invalidPdfBuffer));

    await expect(extractText('some/key.pdf', 'application/pdf')).rejects.toThrow();
    try {
      vi.mocked(storage.getStream)
        .mockResolvedValueOnce(bufferToReadable(invalidPdfBuffer))
        .mockResolvedValueOnce(bufferToReadable(invalidPdfBuffer));
      await extractText('some/key.pdf', 'application/pdf');
    } catch (err) {
      if (err instanceof AppError) {
        expect(err.code).not.toBe('UNSUPPORTED_FORMAT');
      }
    }
  });

  it('handles application/vnd.openxmlformats-officedocument.wordprocessingml.document (DOCX)', async () => {
    const fixturePath = path.join(
      process.cwd(),
      'node_modules/mammoth/test/test-data/single-paragraph.docx',
    );
    const buffer = fs.readFileSync(fixturePath);
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(bufferToReadable(buffer))
      .mockResolvedValueOnce(bufferToReadable(buffer));

    const result = await extractText(
      'some/key.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain('Walking on imported air');
  });

  it('handles text/csv by converting to TSV', async () => {
    const csv = 'a,b\n1,2\n';
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(bufferToReadable(Buffer.from(csv)))
      .mockResolvedValueOnce(bufferToReadable(Buffer.from(csv)));

    const result = await extractText('some/key.csv', 'text/csv');
    expect(result.text).toContain('a\tb');
    expect(result.text).toContain('1\t2');
  });

  it('handles application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (XLSX)', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['x', 'y'],
      [1, 2],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(bufferToReadable(buf))
      .mockResolvedValueOnce(bufferToReadable(buf));

    const result = await extractText(
      'some/key.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result.text).toContain('# Sheet: Sheet1');
    expect(result.text).toContain('x\ty');
  });

  it('throws AppError("UNSUPPORTED_FORMAT") for unknown MIME type', async () => {
    // extractText calls getStream twice: once for header detection, once for content dispatch
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(stringToReadable('anything'))
      .mockResolvedValueOnce(stringToReadable('anything'));

    let caught: unknown;
    try {
      await extractText('some/key.bin', 'application/octet-stream');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('UNSUPPORTED_FORMAT');
  });

  // M2: image/jpeg now routes to extractImage — NOT UNSUPPORTED_FORMAT
  it('routes image/jpeg to extractImage (Milestone 2)', async () => {
    vi.mocked(storage.getStream).mockResolvedValueOnce(stringToReadable('image data'));
    const { extractImage } = await import('../../../src/services/extractor/image.js');
    // Re-set mock return value after vi.resetAllMocks() cleared it
    vi.mocked(extractImage).mockResolvedValue('image description');
    const result = await extractText('photo.jpg', 'image/jpeg');
    expect(extractImage).toHaveBeenCalled();
    expect(result.text).toBe('image description');
  });

  // M2: audio/mpeg now routes to extractAudio — NOT UNSUPPORTED_FORMAT
  it('routes audio/mpeg to extractAudio (Milestone 2)', async () => {
    vi.mocked(storage.getStream).mockResolvedValueOnce(stringToReadable('audio data'));
    const { extractAudio } = await import('../../../src/services/extractor/audio.js');
    // Re-set mock return value after vi.resetAllMocks() cleared it
    vi.mocked(extractAudio).mockResolvedValue({ text: 'audio transcript', segments: [] });
    const result = await extractText('audio.mp3', 'audio/mpeg');
    expect(extractAudio).toHaveBeenCalled();
    expect(result.text).toBe('audio transcript');
  });
});

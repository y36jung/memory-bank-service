/**
 * Unit tests for src/services/extractor/index.ts (M2 additions)
 *
 * Acceptance criteria covered:
 * AC-4: MIME detected via file-type — detected type overrides supplied mimeType
 * AC-5: S3 size pre-check rejects files > MAX_FILE_SIZE_BYTES
 * AC-6: onProgress callback called with correct stages
 *
 * All external dependencies are mocked so no real S3, OpenAI, or ffmpeg is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { AppError } from '../../../../src/lib/errors.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../../../../src/services/storage.js', () => ({
  headObject: vi.fn(),
  getStream: vi.fn(),
  getObjectBuffer: vi.fn(),
  putObject: vi.fn(),
  uploadStream: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('../../../../src/services/extractor/image.js', () => ({
  extractImage: vi.fn(),
}));

vi.mock('../../../../src/services/extractor/audio.js', () => ({
  extractAudio: vi.fn(),
}));

vi.mock('../../../../src/services/extractor/video.js', () => ({
  extractVideo: vi.fn(),
}));

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

import * as storage from '../../../../src/services/storage.js';
import { extractImage } from '../../../../src/services/extractor/image.js';
import { extractAudio } from '../../../../src/services/extractor/audio.js';
import { extractVideo } from '../../../../src/services/extractor/video.js';
import { fileTypeFromBuffer } from 'file-type';
import { extractText } from '../../../../src/services/extractor/index.js';
import { env } from '../../../../src/config/env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadable(content: string | Buffer): Readable {
  const r = new Readable({ read() {} });
  r.push(typeof content === 'string' ? Buffer.from(content) : content);
  r.push(null);
  return r;
}

// ---------------------------------------------------------------------------
// AC-5: S3 size pre-check rejects files > MAX_FILE_SIZE_BYTES
// ---------------------------------------------------------------------------

describe('AC-5: S3 size pre-check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws AppError("FILE_TOO_LARGE") when headObject returns size > MAX_FILE_SIZE_BYTES', async () => {
    const overLimit = env.MAX_FILE_SIZE_BYTES + 1;
    vi.mocked(storage.headObject).mockResolvedValue(overLimit);

    await expect(extractText('big.mp3', 'audio/mpeg')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });

  it('does NOT throw FILE_TOO_LARGE when headObject returns exactly MAX_FILE_SIZE_BYTES', async () => {
    // Exactly at the limit should be allowed (> check, not >=)
    vi.mocked(storage.headObject).mockResolvedValue(env.MAX_FILE_SIZE_BYTES);
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable('fake'));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'audio/mpeg', ext: 'mp3' } as any);
    vi.mocked(extractAudio as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'transcript',
      segments: [],
    });

    const result = await extractText('exact.mp3', 'audio/mpeg');
    expect(result.text).toBe('transcript');
  });

  it('does NOT throw FILE_TOO_LARGE when headObject returns null (unknown size)', async () => {
    vi.mocked(storage.headObject).mockResolvedValue(null);
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable('fake'));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'audio/mpeg', ext: 'mp3' } as any);
    vi.mocked(extractAudio as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'transcript',
      segments: [],
    });

    const result = await extractText('unknown-size.mp3', 'audio/mpeg');
    expect(result.text).toBe('transcript');
  });

  it('error is an instance of AppError with HTTP 400', async () => {
    vi.mocked(storage.headObject).mockResolvedValue(env.MAX_FILE_SIZE_BYTES + 100);

    try {
      await extractText('huge.mp4', 'video/mp4');
      throw new Error('Expected FILE_TOO_LARGE to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('FILE_TOO_LARGE');
      expect((err as AppError).statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: MIME detected via file-type — detected type overrides supplied mimeType
// ---------------------------------------------------------------------------

describe('AC-4: MIME type detection overrides client-supplied type', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(storage.headObject).mockResolvedValue(1024); // small file, passes size check
  });

  it('routes to extractImage when file-type detects image/jpeg (client said audio/mpeg)', async () => {
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable('fake-jpeg-bytes'));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' } as any);
    vi.mocked(extractImage as ReturnType<typeof vi.fn>).mockResolvedValue('image description');

    const result = await extractText('mystery.bin', 'audio/mpeg'); // wrong client MIME
    // opts is undefined when not provided — just verify the key was passed correctly
    expect(extractImage).toHaveBeenCalledWith('mystery.bin', undefined);
    expect(result.text).toBe('image description');
  });

  it('routes to extractAudio when file-type detects audio/mpeg (client said image/jpeg)', async () => {
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable('fake-audio-bytes'));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'audio/mpeg', ext: 'mp3' } as any);
    vi.mocked(extractAudio as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'audio transcript',
      segments: [],
    });

    const result = await extractText('mystery.bin', 'image/jpeg'); // wrong client MIME
    expect(extractAudio).toHaveBeenCalledWith('mystery.bin', undefined);
    expect(result.text).toBe('audio transcript');
  });

  it('routes to extractVideo when file-type detects video/mp4 (client said text/plain)', async () => {
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable('fake-video-bytes'));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'video/mp4', ext: 'mp4' } as any);
    vi.mocked(extractVideo as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'video description',
    });

    const result = await extractText('mystery.bin', 'text/plain'); // wrong client MIME
    expect(extractVideo).toHaveBeenCalledWith('mystery.bin', undefined);
    expect(result.text).toBe('video description');
  });

  it('falls back to normalised client MIME when file-type returns undefined', async () => {
    const textContent = 'plain text content';
    // headObject → first call for size; getStream → header bytes stream + text stream
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(makeReadable(textContent)) // header detection stream
      .mockResolvedValueOnce(makeReadable(textContent)); // actual content stream
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);

    const result = await extractText('file.txt', 'text/plain');
    expect(result.text).toBe(textContent);
  });

  it('strips charset parameter from client MIME before using as fallback', async () => {
    const textContent = 'hello charset';
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(makeReadable(textContent))
      .mockResolvedValueOnce(makeReadable(textContent));
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);

    const result = await extractText('file.txt', 'text/plain; charset=utf-8');
    expect(result.text).toBe(textContent);
  });
});

// ---------------------------------------------------------------------------
// AC-6: onProgress callback called with correct stages
// ---------------------------------------------------------------------------

describe('AC-6: onProgress callback is forwarded to sub-extractors', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(storage.headObject).mockResolvedValue(1024);
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable('fake'));
  });

  it('passes onProgress to extractImage for image/* MIME type', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' } as any);
    vi.mocked(extractImage as ReturnType<typeof vi.fn>).mockResolvedValue('description');

    const onProgress = vi.fn().mockResolvedValue(undefined);
    await extractText('photo.png', 'image/png', { onProgress });

    expect(extractImage).toHaveBeenCalledWith('photo.png', expect.objectContaining({ onProgress }));
  });

  it('passes onProgress to extractAudio for audio/* MIME type', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'audio/wav', ext: 'wav' } as any);
    vi.mocked(extractAudio as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'transcript',
      segments: [],
    });

    const onProgress = vi.fn().mockResolvedValue(undefined);
    await extractText('sound.wav', 'audio/wav', { onProgress });

    expect(extractAudio).toHaveBeenCalledWith('sound.wav', expect.objectContaining({ onProgress }));
  });

  it('passes onProgress to extractVideo for video/* MIME type', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'video/mp4', ext: 'mp4' } as any);
    vi.mocked(extractVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'video text' });

    const onProgress = vi.fn().mockResolvedValue(undefined);
    await extractText('clip.mp4', 'video/mp4', { onProgress });

    expect(extractVideo).toHaveBeenCalledWith('clip.mp4', expect.objectContaining({ onProgress }));
  });
});

/**
 * Unit tests for src/services/extractor/image.ts (M2)
 *
 * Acceptance criteria covered:
 * AC-2: Images → GPT-4o Vision description + OCR
 * AC-7: Vision description cached in S3 sidecar; cache hit avoids Vision API call on retry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../src/services/storage.js', () => ({
  headObject: vi.fn(),
  getStream: vi.fn(),
  getObjectBuffer: vi.fn(),
  putObject: vi.fn(),
  uploadStream: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('openai', () => {
  const createMock = vi.fn();
  const OpenAI = vi.fn(() => ({
    chat: { completions: { create: createMock } },
    audio: { transcriptions: { create: vi.fn() } },
  }));
  (OpenAI as any)._createMock = createMock;
  return { default: OpenAI };
});

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

import * as storage from '../../../../src/services/storage.js';
import { fileTypeFromBuffer } from 'file-type';
import OpenAI from 'openai';
import { extractImage } from '../../../../src/services/extractor/image.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadable(buf: Buffer): Readable {
  const r = new Readable({ read() {} });
  r.push(buf);
  r.push(null);
  return r;
}

const FAKE_IMAGE = Buffer.from('fake-image-bytes');
const FAKE_DESCRIPTION = 'A red circle on white background. Visible text: "Hello"';
const SIDECAR_SUFFIX = '.vision-cache.json';

/** Returns the mock `chat.completions.create` function from the OpenAI mock */
function getCreateMock(): ReturnType<typeof vi.fn> {
  // The OpenAI constructor mock exposes the shared createMock as a static prop
  return (OpenAI as any)._createMock as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// AC-2: Images → GPT-4o Vision description + OCR
// ---------------------------------------------------------------------------

describe('AC-2: extractImage — GPT-4o Vision description + OCR', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(null); // no sidecar yet
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable(FAKE_IMAGE));
    vi.mocked(storage.putObject).mockResolvedValue(undefined);
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' } as any);

    getCreateMock().mockResolvedValue({
      choices: [{ message: { content: FAKE_DESCRIPTION } }],
    });
  });

  it('returns the Vision API description as extracted text', async () => {
    const result = await extractImage('photo.jpg');
    expect(result).toBe(FAKE_DESCRIPTION);
  });

  it('calls GPT-4o (not a different model) with the image as base64 data URL', async () => {
    await extractImage('photo.jpg');
    const createMock = getCreateMock();
    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o');
    const imageContent = callArgs.messages[0].content[0];
    expect(imageContent.type).toBe('image_url');
    const url: string = imageContent.image_url.url;
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    // Verify the base64 payload is our fake image
    const decoded = Buffer.from(url.split(',')[1]!, 'base64');
    expect(decoded.equals(FAKE_IMAGE)).toBe(true);
  });

  it('sends an OCR/describe prompt in the Vision request', async () => {
    await extractImage('photo.jpg');
    const callArgs = getCreateMock().mock.calls[0][0];
    const textContent = callArgs.messages[0].content[1];
    expect(textContent.type).toBe('text');
    expect(typeof textContent.text).toBe('string');
    expect(textContent.text.length).toBeGreaterThan(10);
  });

  it('handles null content from Vision API gracefully (returns empty string)', async () => {
    getCreateMock().mockResolvedValue({
      choices: [{ message: { content: null } }],
    });
    const result = await extractImage('blank.png');
    expect(result).toBe('');
  });

  it('handles empty choices array from Vision API gracefully', async () => {
    getCreateMock().mockResolvedValue({ choices: [] });
    const result = await extractImage('blank.png');
    expect(result).toBe('');
  });

  it('uses detected MIME type in the data URL, not a hardcoded value', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/png', ext: 'png' } as any);
    await extractImage('photo.png');
    const callArgs = getCreateMock().mock.calls[0][0];
    const url: string = callArgs.messages[0].content[0].image_url.url;
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to image/jpeg when file-type cannot detect MIME', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    await extractImage('unknown.bin');
    const callArgs = getCreateMock().mock.calls[0][0];
    const url: string = callArgs.messages[0].content[0].image_url.url;
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
  });
});

// ---------------------------------------------------------------------------
// AC-7: Vision description cached in S3 sidecar; cache hit avoids Vision API call on retry
// ---------------------------------------------------------------------------

describe('AC-7: Vision description S3 sidecar caching', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('writes description to S3 sidecar after Vision API call', async () => {
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(null);
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable(FAKE_IMAGE));
    vi.mocked(storage.putObject).mockResolvedValue(undefined);
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' } as any);
    getCreateMock().mockResolvedValue({
      choices: [{ message: { content: FAKE_DESCRIPTION } }],
    });

    await extractImage('photo.jpg');

    expect(storage.putObject).toHaveBeenCalledTimes(1);
    const putArgs = vi.mocked(storage.putObject).mock.calls[0]!;
    expect(putArgs[0]).toBe(`photo.jpg${SIDECAR_SUFFIX}`);
    expect(putArgs[2]).toBe('application/json');
    const sidecar = JSON.parse(putArgs[1] as string);
    expect(sidecar.description).toBe(FAKE_DESCRIPTION);
    expect(typeof sidecar.createdAt).toBe('string');
  });

  it('on cache HIT: returns cached description without calling Vision API', async () => {
    const cached = JSON.stringify({
      description: 'cached description',
      createdAt: new Date().toISOString(),
    });
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(Buffer.from(cached, 'utf-8'));

    const result = await extractImage('photo.jpg');
    expect(result).toBe('cached description');
    expect(getCreateMock()).not.toHaveBeenCalled();
    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it('on cache HIT: checks the correct sidecar key (<key>.vision-cache.json)', async () => {
    const key = 'uploads/abc123/photo.jpg';
    const cached = JSON.stringify({ description: 'cached', createdAt: new Date().toISOString() });
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(Buffer.from(cached));

    await extractImage(key);

    expect(storage.getObjectBuffer).toHaveBeenCalledWith(`${key}${SIDECAR_SUFFIX}`);
  });

  it('on cache MISS: calls getObjectBuffer for the sidecar key', async () => {
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(null); // cache miss
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable(FAKE_IMAGE));
    vi.mocked(storage.putObject).mockResolvedValue(undefined);
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' } as any);
    getCreateMock().mockResolvedValue({
      choices: [{ message: { content: FAKE_DESCRIPTION } }],
    });

    const key = 'uploads/doc1/img.png';
    await extractImage(key);

    expect(storage.getObjectBuffer).toHaveBeenCalledWith(`${key}${SIDECAR_SUFFIX}`);
    expect(getCreateMock()).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC-6 partial: onProgress called with 'vision' stage
// ---------------------------------------------------------------------------

describe('AC-6 (image): onProgress called with vision stage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(null);
    vi.mocked(storage.getStream).mockResolvedValue(makeReadable(FAKE_IMAGE));
    vi.mocked(storage.putObject).mockResolvedValue(undefined);
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' } as any);
    getCreateMock().mockResolvedValue({
      choices: [{ message: { content: 'desc' } }],
    });
  });

  it('calls onProgress("vision", 0) before API call and onProgress("vision", 100) after', async () => {
    const stages: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      stages.push([stage, pct]);
    });

    await extractImage('photo.jpg', { onProgress });

    expect(stages).toContainEqual(['vision', 0]);
    expect(stages).toContainEqual(['vision', 100]);
    const idx0 = stages.findIndex((s) => s[0] === 'vision' && s[1] === 0);
    const idx100 = stages.findIndex((s) => s[0] === 'vision' && s[1] === 100);
    expect(idx0).toBeLessThan(idx100);
  });
});

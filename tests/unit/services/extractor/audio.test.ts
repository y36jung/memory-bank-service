/**
 * Unit tests for src/services/extractor/audio.ts (M2)
 *
 * Acceptance criteria covered:
 * AC-1: Audio files → Whisper transcript
 *       < 25 MB: single call
 *       ≥ 25 MB: split first (ffmpeg segment muxer), then transcribe each segment
 * AC-6 (audio): onProgress callback called with correct stages
 *
 * Dependencies mocked:
 * - storage: getStream, headObject, getObjectBuffer, putObject
 * - openai: audio.transcriptions.create
 * - file-type: fileTypeFromBuffer
 * - fluent-ffmpeg: entire module (avoids needing a real ffmpeg binary)
 * - node:fs: statSync, createReadStream, createWriteStream, readdirSync, mkdirSync, rmSync
 * - node:stream/promises: pipeline
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Hoisted mock variables (accessible inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockTranscriptionsCreate,
  mockStatSync,
  mockCreateReadStream,
  mockCreateWriteStream,
  mockReaddirSync,
  mockMkdirSync,
  mockRmSync,
} = vi.hoisted(() => ({
  mockTranscriptionsCreate: vi.fn(),
  mockStatSync: vi.fn(),
  mockCreateReadStream: vi.fn(),
  mockCreateWriteStream: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockRmSync: vi.fn(),
}));

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
  const OpenAI = vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
    audio: { transcriptions: { create: mockTranscriptionsCreate } },
  }));
  return { default: OpenAI };
});

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

// fluent-ffmpeg: return a plain object — tests set up the chain per-test
vi.mock('fluent-ffmpeg', () => {
  // Each call to ffmpeg(input) creates a new mock chain object
  // We use a factory so each invocation starts clean
  const MockFfmpeg = vi.fn((inputPath: string) => {
    const chain = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      run: vi.fn(),
    };
    (MockFfmpeg as any)._lastChain = chain;
    return chain;
  });
  (MockFfmpeg as any).setFfmpegPath = vi.fn();
  (MockFfmpeg as any)._lastChain = null;
  return { default: MockFfmpeg };
});

vi.mock('node:fs', () => ({
  statSync: mockStatSync,
  createReadStream: mockCreateReadStream,
  createWriteStream: mockCreateWriteStream,
  readdirSync: mockReaddirSync,
  mkdirSync: mockMkdirSync,
  rmSync: mockRmSync,
}));

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

import * as storage from '../../../../src/services/storage.js';
import { fileTypeFromBuffer } from 'file-type';
import { extractAudio } from '../../../../src/services/extractor/audio.js';
import ffmpeg from 'fluent-ffmpeg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WHISPER_LIMIT = 25 * 1024 * 1024; // 25 MB

function makeReadable(content: string | Buffer): Readable {
  const r = new Readable({ read() {} });
  r.push(typeof content === 'string' ? Buffer.from(content) : content);
  r.push(null);
  return r;
}

/**
 * Configure the ffmpeg mock so the chain's `.on('end', cb)` fires the callback immediately.
 * Must be called AFTER setupBaseMocks() to override the default `.mockReturnThis()`.
 */
function configureFfmpegEndCallback() {
  vi.mocked(ffmpeg).mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain['outputOptions'] = vi.fn().mockReturnValue(chain);
    chain['output'] = vi.fn().mockReturnValue(chain);
    chain['on'] = vi.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === 'end') setTimeout(cb, 0);
      return chain;
    });
    chain['run'] = vi.fn();
    (ffmpeg as any)._lastChain = chain;
    return chain as any;
  });
}

function setupBaseMocks() {
  vi.mocked(storage.getObjectBuffer).mockResolvedValue(null);
  vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'audio/mpeg', ext: 'mp3' } as any);
  vi.mocked(storage.getStream)
    .mockResolvedValueOnce(makeReadable('mp3-header')) // header detection stream
    .mockResolvedValueOnce(makeReadable('mp3-audio-data')); // download stream
  mockMkdirSync.mockReturnValue(undefined);
  mockRmSync.mockReturnValue(undefined);
  mockCreateWriteStream.mockReturnValue({ write: vi.fn(), end: vi.fn() });
  mockCreateReadStream.mockReturnValue(makeReadable('audio-content'));
}

// ---------------------------------------------------------------------------
// AC-1a: Files < 25 MB → single Whisper call (no splitting)
// ---------------------------------------------------------------------------

describe('AC-1a: Audio < 25 MB → single Whisper transcription call', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupBaseMocks();
  });

  it('returns Whisper transcript for a small file (single call)', async () => {
    const smallSize = WHISPER_LIMIT - 1; // just under 25 MB
    mockStatSync.mockReturnValue({ size: smallSize });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Hello world transcript' });

    const result = await extractAudio('audio/small.mp3');
    expect(result).toBe('Hello world transcript');
  });

  it('calls Whisper API exactly once for a small file', async () => {
    mockStatSync.mockReturnValue({ size: 1024 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Short audio' });

    await extractAudio('audio/tiny.mp3');
    expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it('calls Whisper with model whisper-1', async () => {
    mockStatSync.mockReturnValue({ size: 1024 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Whisper' });

    await extractAudio('audio/file.mp3');
    const callArgs = mockTranscriptionsCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('whisper-1');
  });

  it('does NOT invoke ffmpeg split for a small file', async () => {
    mockStatSync.mockReturnValue({ size: 1000 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'No split needed' });

    await extractAudio('audio/small.wav');
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it('handles file at exactly 25 MB (≤ limit means no split)', async () => {
    mockStatSync.mockReturnValue({ size: WHISPER_LIMIT });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Exactly 25MB' });

    const result = await extractAudio('audio/exact25.mp3');
    expect(result).toBe('Exactly 25MB');
    expect(ffmpeg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-1b: Files > 25 MB → split with ffmpeg, then transcribe each segment
// ---------------------------------------------------------------------------

describe('AC-1b: Audio > 25 MB → split with ffmpeg then transcribe segments', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupBaseMocks();
    configureFfmpegEndCallback();
  });

  it('invokes ffmpeg split for a large file (> 25 MB)', async () => {
    mockStatSync.mockReturnValue({ size: WHISPER_LIMIT + 1 });
    mockReaddirSync.mockReturnValue(['seg-0000.wav', 'seg-0001.wav']);
    mockTranscriptionsCreate
      .mockResolvedValueOnce({ text: 'Part one' })
      .mockResolvedValueOnce({ text: 'Part two' });

    const result = await extractAudio('audio/large.mp3');
    expect(ffmpeg).toHaveBeenCalledTimes(1);
    expect(result).toBe('Part one Part two');
  });

  it('calls Whisper once per segment', async () => {
    mockStatSync.mockReturnValue({ size: WHISPER_LIMIT + 100 });
    mockReaddirSync.mockReturnValue(['seg-0000.wav', 'seg-0001.wav', 'seg-0002.wav']);
    mockTranscriptionsCreate
      .mockResolvedValueOnce({ text: 'Segment A' })
      .mockResolvedValueOnce({ text: 'Segment B' })
      .mockResolvedValueOnce({ text: 'Segment C' });

    await extractAudio('audio/big.wav');
    expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(3);
  });

  it('joins segment transcripts with a space', async () => {
    mockStatSync.mockReturnValue({ size: WHISPER_LIMIT * 2 });
    mockReaddirSync.mockReturnValue(['seg-0000.wav', 'seg-0001.wav']);
    mockTranscriptionsCreate
      .mockResolvedValueOnce({ text: 'Alpha' })
      .mockResolvedValueOnce({ text: 'Beta' });

    const result = await extractAudio('audio/huge.mp3');
    expect(result).toBe('Alpha Beta');
  });

  it('passes segment_size flag to ffmpeg when splitting', async () => {
    mockStatSync.mockReturnValue({ size: WHISPER_LIMIT + 100 });
    mockReaddirSync.mockReturnValue(['seg-0000.wav']);
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Done' });

    await extractAudio('audio/oversized.mp3');

    // Inspect the outputOptions call on the last chain
    const lastChain = (ffmpeg as any)._lastChain;
    const optionsCalls = (lastChain.outputOptions as ReturnType<typeof vi.fn>).mock.calls;
    expect(optionsCalls.length).toBeGreaterThan(0);
    const optionsArray = optionsCalls[0][0] as string[];
    expect(optionsArray).toContain('-f');
    expect(optionsArray).toContain('segment');
    expect(optionsArray).toContain('-segment_time');
  });
});

// ---------------------------------------------------------------------------
// AC-1c: File extension detection via file-type
// ---------------------------------------------------------------------------

describe('AC-1c: Audio file extension detected via file-type', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses detected extension (.wav) in the tmp file path', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'audio/wav', ext: 'wav' } as any);
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(makeReadable('wav-header'))
      .mockResolvedValueOnce(makeReadable('wav-audio'));
    mockMkdirSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
    mockCreateWriteStream.mockReturnValue({ write: vi.fn(), end: vi.fn() });
    mockCreateReadStream.mockReturnValue(makeReadable('audio'));
    mockStatSync.mockReturnValue({ size: 100 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'WAV transcript' });

    await extractAudio('audio/file.wav');

    // createReadStream should be called with a path ending in .wav
    const readStreamPath: string = mockCreateReadStream.mock.calls[0][0];
    expect(readStreamPath).toMatch(/\.wav$/);
  });

  it('falls back to .mp3 extension when file-type returns undefined', async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    vi.mocked(storage.getStream)
      .mockResolvedValueOnce(makeReadable('unknown-header'))
      .mockResolvedValueOnce(makeReadable('audio-data'));
    mockMkdirSync.mockReturnValue(undefined);
    mockRmSync.mockReturnValue(undefined);
    mockCreateWriteStream.mockReturnValue({ write: vi.fn(), end: vi.fn() });
    mockCreateReadStream.mockReturnValue(makeReadable('audio'));
    mockStatSync.mockReturnValue({ size: 100 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Fallback mp3' });

    await extractAudio('audio/mystery.bin');

    const readStreamPath: string = mockCreateReadStream.mock.calls[0][0];
    expect(readStreamPath).toMatch(/\.mp3$/);
  });
});

// ---------------------------------------------------------------------------
// AC-6 (audio): onProgress called with correct stages
// ---------------------------------------------------------------------------

describe('AC-6 (audio): onProgress callback stages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupBaseMocks();
  });

  it('calls onProgress("downloading", 5) before download for small file', async () => {
    mockStatSync.mockReturnValue({ size: 1024 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'OK' });

    const stages: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      stages.push([stage, pct]);
    });

    await extractAudio('audio/file.mp3', { onProgress });
    expect(stages.some(([s]) => s === 'downloading')).toBe(true);
    expect(stages.find(([s]) => s === 'downloading')?.[1]).toBe(5);
  });

  it('calls onProgress("transcribing", ...) for small file path', async () => {
    mockStatSync.mockReturnValue({ size: 1024 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'OK' });

    const stages: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      stages.push([stage, pct]);
    });

    await extractAudio('audio/file.mp3', { onProgress });
    expect(stages.some(([s]) => s === 'transcribing')).toBe(true);
  });

  it('calls onProgress("done", 100) at the end for small file', async () => {
    mockStatSync.mockReturnValue({ size: 1024 });
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Done' });

    const stages: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      stages.push([stage, pct]);
    });

    await extractAudio('audio/file.mp3', { onProgress });
    expect(stages[stages.length - 1]).toEqual(['done', 100]);
  });

  it('calls onProgress("splitting", 20) for large file before transcribing', async () => {
    configureFfmpegEndCallback();
    mockStatSync.mockReturnValue({ size: WHISPER_LIMIT + 1 });
    mockReaddirSync.mockReturnValue(['seg-0000.wav']);
    mockTranscriptionsCreate.mockResolvedValue({ text: 'Done' });

    const stages: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      stages.push([stage, pct]);
    });

    await extractAudio('audio/large.mp3', { onProgress });
    expect(stages.some(([s]) => s === 'splitting')).toBe(true);
    expect(stages.find(([s]) => s === 'splitting')?.[1]).toBe(20);
  });
});

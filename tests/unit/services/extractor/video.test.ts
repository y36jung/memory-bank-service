/**
 * Unit tests for src/services/extractor/video.ts (M2)
 *
 * Acceptance criteria covered:
 * AC-3: Video → two-pass (audio→Whisper + keyframes→Vision) → merged text
 * AC-7: Vision description cached in S3 sidecar; cache hit avoids API calls on retry
 * AC-6 (video): onProgress callback called with correct stages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Hoisted mock variables
// ---------------------------------------------------------------------------

const {
  mockChatCreate,
  mockReadFileSync,
  mockReaddirSync,
  mockMkdirSync,
  mockRmSync,
  mockCreateWriteStream,
  mockTranscribeFile,
} = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockCreateWriteStream: vi.fn(),
  mockTranscribeFile: vi.fn(),
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
    chat: { completions: { create: mockChatCreate } },
    audio: { transcriptions: { create: vi.fn() } },
  }));
  return { default: OpenAI };
});

vi.mock('file-type', () => ({
  fileTypeFromBuffer: vi.fn(),
}));

// fluent-ffmpeg: use a vi.fn() factory that can be controlled per-test
vi.mock('fluent-ffmpeg', () => {
  const MockFfmpeg = vi.fn((inputPath: string) => {
    const chain = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      run: vi.fn(),
    };
    (MockFfmpeg as any)._lastChain = chain;
    return chain as any;
  });
  (MockFfmpeg as any).setFfmpegPath = vi.fn();
  (MockFfmpeg as any)._lastChain = null;
  return { default: MockFfmpeg };
});

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  mkdirSync: mockMkdirSync,
  rmSync: mockRmSync,
  createWriteStream: mockCreateWriteStream,
  createReadStream: vi.fn().mockReturnValue(new Readable({ read() {} })),
  statSync: vi.fn().mockReturnValue({ size: 1000 }),
}));

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

// Mock the transcribeFile helper from audio.ts directly (mockTranscribeFile is vi.hoisted)
vi.mock('../../../../src/services/extractor/audio.js', () => ({
  transcribeFile: mockTranscribeFile,
  extractAudio: vi.fn(),
}));

import * as storage from '../../../../src/services/storage.js';
import { fileTypeFromBuffer } from 'file-type';
import { extractVideo } from '../../../../src/services/extractor/video.js';
import ffmpeg from 'fluent-ffmpeg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYFRAME_INTERVAL = 10; // seconds, as defined in video.ts
const SIDECAR_SUFFIX = '.vision-cache.json';

function makeReadable(content: string | Buffer): Readable {
  const r = new Readable({ read() {} });
  r.push(typeof content === 'string' ? Buffer.from(content) : content);
  r.push(null);
  return r;
}

/**
 * Configure the ffmpeg mock so chain.on('end', cb) fires the callback.
 * Both invocations (audio extraction + keyframe extraction) get separate chains
 * that both fire 'end'.
 */
function configureFfmpegForEnd() {
  vi.mocked(ffmpeg).mockImplementation((_inputPath: string) => {
    const chain = {
      outputOptions: vi.fn().mockReturnThis(),
      output: vi.fn().mockReturnThis(),
      on: vi.fn().mockImplementation(function (this: unknown, event: string, cb: () => void) {
        if (event === 'end') setTimeout(cb, 0);
        return this;
      }),
      run: vi.fn(),
    };
    (ffmpeg as any)._chains = ((ffmpeg as any)._chains ?? []).concat([chain]);
    (ffmpeg as any)._lastChain = chain;
    return chain as any;
  });
}

function setupBaseMocks(keyframes: string[] = ['frame-0001.jpg', 'frame-0002.jpg']) {
  vi.mocked(storage.getObjectBuffer).mockResolvedValue(null); // no sidecar
  vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: 'video/mp4', ext: 'mp4' } as any);
  vi.mocked(storage.getStream)
    .mockResolvedValueOnce(makeReadable('mp4-header')) // header detection
    .mockResolvedValueOnce(makeReadable('mp4-video')); // download
  vi.mocked(storage.putObject).mockResolvedValue(undefined);
  mockMkdirSync.mockReturnValue(undefined);
  mockRmSync.mockReturnValue(undefined);
  mockCreateWriteStream.mockReturnValue({ write: vi.fn(), end: vi.fn() });
  mockTranscribeFile.mockResolvedValue('audio transcript');
  configureFfmpegForEnd();
  // Return keyframe files from readdirSync
  mockReaddirSync.mockReturnValue(keyframes);
  // readFileSync returns a fake JPEG buffer for each keyframe
  mockReadFileSync.mockReturnValue(Buffer.from('fake-jpeg'));
  mockChatCreate.mockResolvedValue({
    choices: [{ message: { content: 'Frame description' } }],
  });
  // Reset chains tracker
  (ffmpeg as any)._chains = [];
}

// ---------------------------------------------------------------------------
// AC-3: Video → two-pass extraction → merged text
// ---------------------------------------------------------------------------

describe('AC-3: extractVideo — two-pass (audio + keyframes) → merged text', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupBaseMocks();
  });

  it('returns merged text containing both [Visual Descriptions] and [Transcript] sections', async () => {
    const result = await extractVideo('video/clip.mp4');
    expect(result).toContain('[Visual Descriptions]');
    expect(result).toContain('[Transcript]');
    expect(result).toContain('audio transcript');
  });

  it('calls transcribeFile (Whisper) for the audio track', async () => {
    await extractVideo('video/clip.mp4');
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    // The audio path should end in .wav (extracted audio track)
    const audioPath: string = mockTranscribeFile.mock.calls[0][0];
    expect(audioPath).toMatch(/\.wav$/);
  });

  it('calls GPT-4o Vision for each extracted keyframe', async () => {
    // 2 keyframes
    await extractVideo('video/clip.mp4');
    expect(mockChatCreate).toHaveBeenCalledTimes(2);
  });

  it('uses gpt-4o model for keyframe descriptions', async () => {
    await extractVideo('video/clip.mp4');
    const callArgs = mockChatCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o');
  });

  it('sends each keyframe as base64 image_url to Vision', async () => {
    await extractVideo('video/clip.mp4');
    for (const call of mockChatCreate.mock.calls) {
      const imageContent = call[0].messages[0].content[0];
      expect(imageContent.type).toBe('image_url');
      expect(imageContent.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    }
  });

  it('labels each frame with its timestamp based on KEYFRAME_INTERVAL', async () => {
    const result = await extractVideo('video/clip.mp4');
    expect(result).toContain('[Frame at 0s]');
    expect(result).toContain(`[Frame at ${KEYFRAME_INTERVAL}s]`);
  });

  it('invokes ffmpeg twice: once for audio extraction, once for keyframe extraction', async () => {
    await extractVideo('video/clip.mp4');
    expect(ffmpeg).toHaveBeenCalledTimes(2);
  });

  it('audio track extraction uses -vn flag (no video)', async () => {
    await extractVideo('video/clip.mp4');
    const chains = (ffmpeg as any)._chains as Array<{
      outputOptions: ReturnType<typeof vi.fn>;
    }>;
    // First chain: audio extraction
    const firstChainOptions = chains[0]!.outputOptions.mock.calls[0][0] as string[];
    expect(firstChainOptions).toContain('-vn');
  });

  it('keyframe extraction uses fps filter with 1/KEYFRAME_INTERVAL', async () => {
    await extractVideo('video/clip.mp4');
    const chains = (ffmpeg as any)._chains as Array<{
      outputOptions: ReturnType<typeof vi.fn>;
    }>;
    // Second chain: keyframe extraction
    const secondChainOptions = chains[1]!.outputOptions.mock.calls[0][0] as string[];
    expect(secondChainOptions).toContain('-vf');
    const vfIndex = secondChainOptions.indexOf('-vf');
    const fpsFilter = secondChainOptions[vfIndex + 1];
    expect(fpsFilter).toContain(`fps=1/${KEYFRAME_INTERVAL}`);
  });

  it('handles video with no keyframes gracefully (no Vision calls)', async () => {
    vi.resetAllMocks();
    setupBaseMocks([]); // no keyframes
    const result = await extractVideo('video/empty.mp4');
    expect(result).toContain('[Transcript]');
    expect(result).toContain('[Visual Descriptions]');
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it('merged output places visual descriptions before transcript', async () => {
    const result = await extractVideo('video/clip.mp4');
    const visualIdx = result.indexOf('[Visual Descriptions]');
    const transcriptIdx = result.indexOf('[Transcript]');
    expect(visualIdx).toBeLessThan(transcriptIdx);
  });
});

// ---------------------------------------------------------------------------
// AC-7: Video Vision description S3 sidecar caching
// ---------------------------------------------------------------------------

describe('AC-7: extractVideo — S3 sidecar caching', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('on cache HIT: returns cached mergedText without calling Vision or Whisper APIs', async () => {
    const mergedText = '[Visual Descriptions]\ncached frame\n\n[Transcript]\ncached transcript';
    const sidecar = JSON.stringify({ mergedText, createdAt: new Date().toISOString() });
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(Buffer.from(sidecar, 'utf-8'));

    const result = await extractVideo('video/clip.mp4');
    expect(result).toBe(mergedText);
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
  });

  it('on cache HIT: checks the correct sidecar key (<key>.vision-cache.json)', async () => {
    const key = 'uploads/doc1/video.mp4';
    const sidecar = JSON.stringify({ mergedText: 'cached', createdAt: new Date().toISOString() });
    vi.mocked(storage.getObjectBuffer).mockResolvedValue(Buffer.from(sidecar));

    await extractVideo(key);
    expect(storage.getObjectBuffer).toHaveBeenCalledWith(`${key}${SIDECAR_SUFFIX}`);
  });

  it('on cache MISS: writes sidecar to S3 after processing', async () => {
    setupBaseMocks();

    await extractVideo('uploads/doc1/clip.mp4');

    expect(storage.putObject).toHaveBeenCalledTimes(1);
    const putArgs = vi.mocked(storage.putObject).mock.calls[0]!;
    expect(putArgs[0]).toBe(`uploads/doc1/clip.mp4${SIDECAR_SUFFIX}`);
    expect(putArgs[2]).toBe('application/json');
    const sidecar = JSON.parse(putArgs[1] as string);
    expect(typeof sidecar.mergedText).toBe('string');
    expect(typeof sidecar.createdAt).toBe('string');
  });

  it('on cache MISS: sidecar mergedText equals the returned value', async () => {
    setupBaseMocks();

    const result = await extractVideo('video/new.mp4');

    const putArgs = vi.mocked(storage.putObject).mock.calls[0]!;
    const sidecar = JSON.parse(putArgs[1] as string);
    expect(sidecar.mergedText).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// AC-6 (video): onProgress callback stages
// ---------------------------------------------------------------------------

describe('AC-6 (video): onProgress callback stages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupBaseMocks();
  });

  it('calls onProgress with downloading, extracting-audio, transcribing, extracting-keyframes, done stages', async () => {
    const stages = new Set<string>();
    const onProgress = vi.fn().mockImplementation(async (stage: string) => {
      stages.add(stage);
    });

    await extractVideo('video/clip.mp4', { onProgress });

    expect(stages.has('downloading')).toBe(true);
    expect(stages.has('extracting-audio')).toBe(true);
    expect(stages.has('transcribing')).toBe(true);
    expect(stages.has('extracting-keyframes')).toBe(true);
    expect(stages.has('done')).toBe(true);
  });

  it('calls onProgress("done", 100) as the final progress event', async () => {
    const progress: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      progress.push([stage, pct]);
    });

    await extractVideo('video/clip.mp4', { onProgress });

    const last = progress[progress.length - 1];
    expect(last?.[0]).toBe('done');
    expect(last?.[1]).toBe(100);
  });

  it('calls onProgress("downloading", 5) near the start', async () => {
    const progress: Array<[string, number]> = [];
    const onProgress = vi.fn().mockImplementation(async (stage: string, pct: number) => {
      progress.push([stage, pct]);
    });

    await extractVideo('video/clip.mp4', { onProgress });

    const dlEntry = progress.find(([s]) => s === 'downloading');
    expect(dlEntry).toBeDefined();
    expect(dlEntry?.[1]).toBe(5);
  });
});

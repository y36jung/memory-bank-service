import {
  createReadStream,
  statSync,
  rmSync,
  mkdirSync,
  createWriteStream,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import ffmpeg from 'fluent-ffmpeg';
import { fileTypeFromBuffer } from 'file-type';
import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { withTimeout } from '../../lib/utils.js';
import * as storage from '../storage.js';
import type { ExtractOptions } from './index.js';

if (env.FFMPEG_PATH) ffmpeg.setFfmpegPath(env.FFMPEG_PATH);

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const WHISPER_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB
const SEGMENT_DURATION_SECS = 720; // 12 min × 1.92 MB/min ≈ 23 MB — under Whisper 25 MB limit

/** Transcribe a local audio file via OpenAI Whisper. */
export async function transcribeFile(filePath: string): Promise<string> {
  const fileStream = createReadStream(filePath);
  const result = await withTimeout(
    openai.audio.transcriptions.create({ model: 'whisper-1', file: fileStream }),
    env.WHISPER_TIMEOUT_MS,
    'whisper',
  );
  return result.text;
}

/** Split an audio file into ≤25 MB WAV segments using time-based split with PCM re-encoding. */
async function splitAudio(inputPath: string, segDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const pattern = join(segDir, 'seg-%04d.wav');
    ffmpeg(inputPath)
      .outputOptions([
        '-f',
        'segment',
        '-segment_time',
        String(SEGMENT_DURATION_SECS),
        '-acodec',
        'pcm_s16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-reset_timestamps',
        '1',
      ])
      .output(pattern)
      .on('end', () => {
        const files = readdirSync(segDir)
          .filter((f: string) => f.startsWith('seg-') && f.endsWith('.wav'))
          .sort()
          .map((f: string) => join(segDir, f));
        resolve(files);
      })
      .on('error', reject)
      .run();
  });
}

/**
 * Download an audio file from S3 and transcribe it via Whisper.
 * Files > 25 MB are split into segments before transcription.
 */
export async function extractAudio(key: string, opts?: ExtractOptions): Promise<string> {
  // Detect extension from content
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
  const headerBuf = Buffer.concat(headerChunks).subarray(0, 4100);
  const detected = await fileTypeFromBuffer(headerBuf);
  const ext = detected?.ext ? `.${detected.ext}` : '.mp3';

  const tmpPath = join(tmpdir(), `${randomUUID()}${ext}`);
  const segDir = join(tmpdir(), randomUUID());
  mkdirSync(segDir);

  try {
    await opts?.onProgress?.('downloading', 5);
    const downloadStream = await storage.getStream(key);
    await pipeline(downloadStream, createWriteStream(tmpPath));

    const size = statSync(tmpPath).size;

    let transcript: string;
    if (size <= WHISPER_SIZE_LIMIT) {
      await opts?.onProgress?.('transcribing', 50);
      transcript = await transcribeFile(tmpPath);
    } else {
      await opts?.onProgress?.('splitting', 20);
      const segments = await splitAudio(tmpPath, segDir);
      const transcripts: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        await opts?.onProgress?.('transcribing', 20 + (i / segments.length) * 75);
        const segment = segments[i];
        if (segment) transcripts.push(await transcribeFile(segment));
      }
      transcript = transcripts.join(' ');
    }

    await opts?.onProgress?.('done', 100);
    return transcript;
  } finally {
    rmSync(tmpPath, { force: true });
    rmSync(segDir, { recursive: true, force: true });
  }
}

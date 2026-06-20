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

/** A serialisable subset of the Whisper verbose_json segment. */
export interface TranscribedSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** The result of a single Whisper transcription call. */
export interface TranscribeResult {
  text: string;
  segments: TranscribedSegment[];
}

/** Transcribe a local audio file via OpenAI Whisper, returning text and time-stamped segments. */
export async function transcribeFile(filePath: string): Promise<TranscribeResult> {
  const fileStream = createReadStream(filePath);
  const result = await withTimeout(
    openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fileStream,
      response_format: 'verbose_json',
    }),
    env.WHISPER_TIMEOUT_MS,
    'whisper',
  );
  const segments: TranscribedSegment[] = (result.segments ?? []).map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    text: s.text,
  }));
  return { text: result.text, segments };
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
export async function extractAudio(key: string, opts?: ExtractOptions): Promise<TranscribeResult> {
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

    if (size <= WHISPER_SIZE_LIMIT) {
      await opts?.onProgress?.('transcribing', 50);
      const result = await transcribeFile(tmpPath);
      await opts?.onProgress?.('done', 100);
      return result;
    } else {
      await opts?.onProgress?.('splitting', 20);
      const audioSegPaths = await splitAudio(tmpPath, segDir);
      const allSegments: TranscribedSegment[] = [];
      const transcripts: string[] = [];
      let offsetSecs = 0;
      for (let i = 0; i < audioSegPaths.length; i++) {
        await opts?.onProgress?.('transcribing', 20 + (i / audioSegPaths.length) * 75);
        const segPath = audioSegPaths[i];
        if (segPath) {
          const result = await transcribeFile(segPath);
          transcripts.push(result.text);
          for (const seg of result.segments) {
            allSegments.push({ ...seg, start: seg.start + offsetSecs, end: seg.end + offsetSecs });
          }
          offsetSecs += SEGMENT_DURATION_SECS;
        }
      }
      await opts?.onProgress?.('done', 100);
      return { text: transcripts.join(' '), segments: allSegments };
    }
  } finally {
    rmSync(tmpPath, { force: true });
    rmSync(segDir, { recursive: true, force: true });
  }
}

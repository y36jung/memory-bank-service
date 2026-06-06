import { readFileSync, rmSync, mkdirSync, readdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import ffmpeg from 'fluent-ffmpeg';
import OpenAI from 'openai';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../../config/env.js';
import { withTimeout } from '../../lib/utils.js';
import * as storage from '../storage.js';
import { transcribeFile } from './audio.js';
import type { ExtractOptions } from './index.js';

if (env.FFMPEG_PATH) ffmpeg.setFfmpegPath(env.FFMPEG_PATH);

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const KEYFRAME_INTERVAL = 10; // seconds

interface VideoSidecar {
  mergedText: string;
  createdAt: string;
}

/** Extract the audio track from a video file to a WAV file. */
function extractAudioTrack(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(['-vn', '-acodec', 'pcm_s16le'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/** Extract one keyframe every KEYFRAME_INTERVAL seconds as JPEG files. */
function extractKeyframes(inputPath: string, outDir: string, interval: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([`-vf`, `fps=1/${interval}`])
      .output(join(outDir, 'frame-%04d.jpg'))
      .on('end', () => {
        const frames = readdirSync(outDir)
          .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
          .sort()
          .map((f) => join(outDir, f));
        resolve(frames);
      })
      .on('error', reject)
      .run();
  });
}

/**
 * Two-pass video extraction: audio track → Whisper transcript + keyframes → GPT-4o Vision.
 * Results are cached in an S3 sidecar file.
 */
export async function extractVideo(key: string, opts?: ExtractOptions): Promise<string> {
  const sidecarKey = key + '.vision-cache.json';
  const cached = await storage.getObjectBuffer(sidecarKey);
  if (cached) {
    try {
      const sidecar = JSON.parse(cached.toString('utf-8')) as VideoSidecar;
      if (sidecar.mergedText) return sidecar.mergedText;
    } catch {
      // malformed sidecar — recompute
    }
  }

  // Detect extension
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
  const ext = detected?.ext ? `.${detected.ext}` : '.mp4';

  const tmpVideoPath = join(tmpdir(), `${randomUUID()}${ext}`);
  const tmpDir = join(tmpdir(), randomUUID());
  mkdirSync(tmpDir);

  try {
    await opts?.onProgress?.('downloading', 5);
    const downloadStream = await storage.getStream(key);
    await pipeline(downloadStream, createWriteStream(tmpVideoPath));

    // Pass 1: audio → transcript
    await opts?.onProgress?.('extracting-audio', 10);
    const tmpAudioPath = join(tmpDir, 'audio.wav');
    await extractAudioTrack(tmpVideoPath, tmpAudioPath);
    await opts?.onProgress?.('transcribing', 30);
    const transcript = await transcribeFile(tmpAudioPath);
    await opts?.onProgress?.('transcribing', 45);

    // Pass 2: keyframes → Vision descriptions
    await opts?.onProgress?.('extracting-keyframes', 50);
    const keyframePaths = await extractKeyframes(tmpVideoPath, tmpDir, KEYFRAME_INTERVAL);
    const descriptions: string[] = [];

    for (let i = 0; i < keyframePaths.length; i++) {
      await opts?.onProgress?.(
        'analyzing-frames',
        50 + (i / Math.max(keyframePaths.length, 1)) * 45,
      );
      const framePath = keyframePaths[i];
      if (!framePath) continue;
      const buf = readFileSync(framePath);
      const base64 = buf.toString('base64');

      const response = await withTimeout(
        openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64}` },
                },
                {
                  type: 'text',
                  text: 'Describe what is happening in this video frame. Include visible text, objects, and context.',
                },
              ],
            },
          ],
        }),
        env.VISION_TIMEOUT_MS,
        `gpt4o-vision-frame-${i}`,
      );

      const desc = response.choices[0]?.message?.content ?? '';
      descriptions.push(`[Frame at ${i * KEYFRAME_INTERVAL}s]\n${desc}`);
    }

    const mergedText = [
      '[Visual Descriptions]',
      descriptions.join('\n\n'),
      '',
      '[Transcript]',
      transcript,
    ].join('\n');

    await opts?.onProgress?.('merging', 99);

    const sidecar: VideoSidecar = { mergedText, createdAt: new Date().toISOString() };
    await storage.putObject(sidecarKey, JSON.stringify(sidecar), 'application/json');

    await opts?.onProgress?.('done', 100);
    return mergedText;
  } finally {
    rmSync(tmpVideoPath, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

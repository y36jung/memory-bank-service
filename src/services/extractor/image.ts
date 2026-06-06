import OpenAI from 'openai';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../../config/env.js';
import { withTimeout } from '../../lib/utils.js';
import { AppError } from '../../lib/errors.js';
import * as storage from '../storage.js';
import type { ExtractOptions } from './index.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const SIDECAR_SUFFIX = '.vision-cache.json';
const IMAGE_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB — GPT-4o Vision limit

interface VisionSidecar {
  description: string;
  createdAt: string;
}

/**
 * Extract a rich text description from an image using GPT-4o Vision.
 * The description is cached in an S3 sidecar file so re-indexing avoids
 * redundant Vision API calls.
 */
export async function extractImage(key: string, opts?: ExtractOptions): Promise<string> {
  const sidecarKey = key + SIDECAR_SUFFIX;
  const cached = await storage.getObjectBuffer(sidecarKey);
  if (cached) {
    try {
      const sidecar = JSON.parse(cached.toString('utf-8')) as VisionSidecar;
      if (sidecar.description) return sidecar.description;
    } catch {
      // malformed sidecar — recompute
    }
  }

  const sizeBytes = await storage.headObject(key);
  if (sizeBytes !== null && sizeBytes > IMAGE_SIZE_LIMIT) {
    throw new AppError(
      'IMAGE_TOO_LARGE',
      `Image size ${sizeBytes} bytes exceeds the ${IMAGE_SIZE_LIMIT / (1024 * 1024)} MB Vision API limit`,
      400,
    );
  }

  const stream = await storage.getStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  }
  const buf = Buffer.concat(chunks);
  const base64 = buf.toString('base64');

  const detected = await fileTypeFromBuffer(buf);
  const mimeType = detected?.mime ?? 'image/jpeg';

  await opts?.onProgress?.('vision', 0);

  const response = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
            {
              type: 'text',
              text: 'Describe this image in detail. Include all visible text (OCR), objects, layout, and context.',
            },
          ],
        },
      ],
    }),
    env.VISION_TIMEOUT_MS,
    'gpt4o-vision',
  );

  const description = response.choices[0]?.message?.content ?? '';
  await opts?.onProgress?.('vision', 100);

  const sidecar: VisionSidecar = { description, createdAt: new Date().toISOString() };
  await storage.putObject(sidecarKey, JSON.stringify(sidecar), 'application/json');

  return description;
}

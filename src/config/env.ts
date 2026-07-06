import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: z.string().optional(),
  REDIS_URL: z.string().url(),
  AWS_REGION: z.string(),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET_NAME: z.string(),
  OPENAI_API_KEY: z.string().startsWith('sk-'),
  JWT_SECRET: z.string().min(32),
  MAX_FILE_SIZE_BYTES: z.coerce.number().default(524_288_000),
  MEDIA_EXTRACT_TIMEOUT_MS: z.coerce.number().default(600_000),
  VISION_TIMEOUT_MS: z.coerce.number().default(60_000),
  WHISPER_TIMEOUT_MS: z.coerce.number().default(120_000),
  FFMPEG_PATH: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let env: Env;

try {
  env = envSchema.parse(process.env);
} catch (err) {
  console.error('Fatal: invalid environment configuration.');
  if (err instanceof z.ZodError) {
    for (const issue of err.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
}

export { env };

import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { env } from '../config/env.js';

export interface IngestionJobPayload {
  documentId: string;
  storageKey: string;
  attempt: number;
}

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // required for BullMQ Worker blocking commands
});

export const ingestionQueue = new Queue<IngestionJobPayload>('ingestion', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
    removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days
  },
});

export interface OAuthSyncJobPayload {
  provider: 'google';
  gmailQuery?: string;
}

export const oauthSyncQueue = new Queue<OAuthSyncJobPayload>('oauth-sync', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 60 * 60 * 24 * 7 },
    removeOnFail: { age: 60 * 60 * 24 * 30 },
  },
});

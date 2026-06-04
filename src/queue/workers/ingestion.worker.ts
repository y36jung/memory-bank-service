import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { redisConnection } from '../index.js';
import type { IngestionJobPayload } from '../index.js';
import { processIngestionJob, handleFailedJob } from '../../services/ingestion.js';

export const ingestionWorker = new Worker<IngestionJobPayload, void>(
  'ingestion',
  async (job: Job<IngestionJobPayload>) => processIngestionJob(job),
  { connection: redisConnection, concurrency: 5 },
);

ingestionWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!attemptsExhausted) return;
  try {
    await handleFailedJob(job, err);
  } catch (handlerErr) {
    void job.log(`failed-handler error: ${(handlerErr as Error).message ?? 'unknown'}`);
  }
});

ingestionWorker.on('error', (err) => {
  console.error('[ingestion-worker] error', err);
});

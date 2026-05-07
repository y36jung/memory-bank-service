# BullMQ + Outbox Pattern

> Sources: [Workers](https://docs.bullmq.io/guide/workers) · [Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs) · [Custom backoff strategy](https://docs.bullmq.io/bull/patterns/custom-backoff-strategy) · [DefaultJobOptions](https://api.docs.bullmq.io/interfaces/v4.DefaultJobOptions.html)

## Outbox Worker

Claim rows atomically with `UPDATE ... RETURNING`. Unwrap `TE` at the worker boundary:

```typescript
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

async function pollOutbox(db: Db) {
  const events = await db
    .update(outbox)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(and(eq(outbox.status, 'pending'), lte(outbox.runAfter, new Date()), lte(outbox.attempts, 5)))
    .returning();

  await Promise.allSettled(events.map(async (event) => {
    const result = await dispatch(event)();
    if (E.isLeft(result)) await markFailed(event.id, result.left)();
    else await markComplete(event.id)();
  }));
}
```

## Dispatch

Return `TE.TaskEither` — no try/catch inside:

```typescript
const dispatch = (event: OutboxEvent): TE.TaskEither<AppError, void> =>
  pipe(
    TE.of(event),
    TE.flatMap(e => {
      switch (e.eventType) {
        case 'ingest':     return runIngestionPipeline(e);
        case 'reindex':    return reindexRecord(e);
        case 'delete':     return deleteQdrantPoints(e.payload.chunkIds);
        case 'notify-due': return sendDueReminder(e);
      }
    }),
  );
```

## Retry / Backoff

BullMQ built-in: exponential backoff retries after `2^(attempts-1) * delay` ms. For the outbox, implement in Postgres:

```typescript
const markFailed = (id: string, err: AppError): TE.TaskEither<AppError, void> =>
  pipe(
    TE.tryCatch(
      () => db.query.outbox.findFirst({ where: eq(outbox.id, id) }),
      (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
    ),
    TE.flatMap(event => {
      const attempts = (event?.attempts ?? 0) + 1;
      const backoffMs = Math.min(2 ** attempts * 10_000, 600_000);
      return TE.tryCatch(
        () => db.update(outbox).set({
          status: attempts >= 5 ? 'failed' : 'pending',
          attempts,
          lastError: JSON.stringify(err),
          runAfter: new Date(Date.now() + backoffMs),
        }).where(eq(outbox.id, id)),
        (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
      );
    }),
    TE.map(() => undefined),
  );
```

After 5 attempts row stays `failed` — never silently dropped.

## BullMQ (Cron Jobs)

```typescript
interface PatternJobData { userId: string; since: string; }
interface PatternJobResult { patternsUpserted: number; }

const queue = new Queue<PatternJobData, PatternJobResult>('pattern-extraction', { connection: redis });

await queue.add('weekly', {}, {
  repeat: { pattern: '0 3 * * 1' },
  removeOnComplete: 100,
  removeOnFail: 50,
});

// Unwrap TE at the BullMQ worker boundary
const worker = new Worker<PatternJobData, PatternJobResult>(
  'pattern-extraction',
  async (job) => {
    const result = await runPatternExtraction(job.data.userId)();
    if (E.isLeft(result)) throw new Error(JSON.stringify(result.left));
    return result.right;
  },
  { connection: redis, concurrency: 2 }
);

worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'job failed'));
```

## Outbox Reconciliation

```typescript
const reconcileStuck = (): TE.TaskEither<AppError, void> =>
  TE.tryCatch(
    () => db.update(outbox)
      .set({ status: 'pending', runAfter: new Date() })
      .where(and(
        eq(outbox.status, 'processing'),
        lte(outbox.updatedAt, new Date(Date.now() - 10 * 60 * 1000)),
      )),
    (cause): AppError => ({ kind: 'upstream', service: 'postgres', cause })
  );
```

## Avoid

- Writing to Qdrant directly from route handlers — always via outbox
- `try/catch` inside dispatch handlers — return `TE.left(appError)` instead
- Cron schedules in local time — always UTC; convert at render time using user's `timezone` field

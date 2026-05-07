# Testing (Vitest)

> Sources: [Vitest Mocking Guide](https://vitest.dev/guide/mocking) · [Mocking Modules](https://vitest.dev/guide/mocking/modules) · [Mock Functions](https://vitest.dev/guide/mocking/functions) · [Test Projects](https://vitest.dev/guide/projects) · [Mock API](https://vitest.dev/api/mock)

## Test Types

| Type | Scope | Location |
|------|-------|----------|
| Unit | Single function/module | Co-located: `service.test.ts` next to `service.ts` |
| Integration | Service + real DB | `tests/integration/` |
| E2E | Full HTTP request | `tests/e2e/` |

No mocked databases in integration tests — run against real Postgres + Qdrant in Docker.

Per Vitest docs, configure separate projects for unit and integration:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
    ],
  },
});
```

## Unit Test Pattern

```typescript
import { describe, it, expect } from 'vitest';
import * as E from 'fp-ts/Either';

describe('mergeAndScore', () => {
  it('boosts manual-linked chunks by 0.30', () => {
    const result = mergeAndScore(qdrantResults, [{ chunkId: 'abc', confidence: 1.0 }]);
    expect(result.find(r => r.chunkId === 'abc')!.finalScore)
      .toBeCloseTo(qdrantResults[0].score + 0.30, 5);
  });
});
```

## Integration Test Pattern

Reset state between tests with transaction rollback — no truncate:

```typescript
import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

let db: Db;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await db.execute(sql`BEGIN`); });
afterEach(async () => { await db.execute(sql`ROLLBACK`); });

it('creates task and outbox event atomically', async () => {
  await taskService.create(db, { title: 'Test', userId: TEST_USER_ID });
  const events = await db.select().from(outbox).where(eq(outbox.sourceKind, 'task'));
  expect(events).toHaveLength(1);
  expect(events[0].eventType).toBe('ingest');
});
```

## Mocking LLMs

Vitest: mock at the module boundary using `vi.mock`. Per docs, mocked module replaces the entire module; spied module keeps the original implementation:

```typescript
import { vi } from 'vitest';

vi.mock('@lib/openai', () => ({
  openai: {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    },
  },
}));
```

For agent tests, mock `anthropic.messages.create` to return a deterministic tool-use then end-turn sequence.

Always clear mocks between tests per Vitest docs — use `vi.clearAllMocks()` in `afterEach` or set `clearMocks: true` in config:

```typescript
// vitest.config.ts
test: { clearMocks: true }
```

## Mocking BullMQ

Unit tests — mock the module entirely:
```typescript
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn(),
}));
```

Integration tests of the outbox worker — call `dispatch()` directly, bypass BullMQ.

## Assertions

- Always assert DB state after mutations — not just return values
- For SSE: collect all events then assert the sequence

For `TaskEither` — always unwrap with `pipe` and assert on the `Either`:

```typescript
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

it('embeds and writes chunks', async () => {
  const result = await pipe(embedBatch(['hello world']), TE.flatMap(writeToQdrant))();

  expect(E.isRight(result)).toBe(true);
  if (E.isRight(result)) {
    expect(result.right).toHaveLength(1);
  }
});

it('returns left on upstream failure', async () => {
  vi.mocked(openai.embeddings.create).mockRejectedValueOnce(new Error('rate limit'));
  const result = await embedBatch(['hello'])();

  expect(E.isLeft(result)).toBe(true);
  if (E.isLeft(result)) {
    expect(result.left.kind).toBe('upstream');
  }
});
```

SSE:
```typescript
const events: StreamEvent[] = [];
for await (const event of collectSSE(response)) events.push(event);
expect(events.at(-1)?.type).toBe('done');
```

## Coverage Targets

| Area | Target |
|------|--------|
| Scoring / merge logic | 100% |
| Error-type narrowing | 100% |
| Service layer | 80%+ |
| Integration (happy + one failure path per handler) | required |
| Generated files (Drizzle schema types, migrations) | skip |

## Avoid

- `setTimeout` in tests — use `vi.useFakeTimers()` for time-dependent logic
- Asserting on log output — assert on observable state (DB rows, return values)
- Mocking Drizzle or Postgres in integration tests

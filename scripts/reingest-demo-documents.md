# Reingest demo account documents (beta)

Re-queues every document owned by a demo account (`users.is_demo = true`) for
full reingestion — re-extract from S3, re-chunk, re-embed, re-upsert to
Qdrant — regardless of current document status.

## Why this runs in Render's Shell, not locally

The beta job queue backing (Render Key Value / Valkey, see PLAN.md § Hosting
& Deployment) is only reachable from inside Render's private network —
its hostname (`red-xxxxxxxxxxxx`) doesn't resolve at all from outside Render,
confirmed via a direct TCP connection test (`ENOTFOUND`). Beta Postgres
(Neon), Qdrant Cloud, and S3 are all reachable from a local machine, but
Redis is not, so this can't be split into "run locally against beta creds"
like `scripts/rebuild-qdrant.ts` — it must run on the Render service itself,
where the correct env vars are already injected natively.

The API and the BullMQ worker run in the same Render process
(`src/server.ts`), so jobs enqueued this way start processing immediately
once the shell command finishes.

## Steps

1. Render dashboard → the beta web service → **Shell** tab.
2. Confirm the working directory (should show `package.json`, `src/`, `scripts/`):
   ```bash
   pwd && ls
   ```
   Expected: `/opt/render/project/src`. If it differs, adjust the relative
   import paths below (`../src/...`) accordingly.
3. Create and run the script inside the project tree — **not** `/tmp`. Module
   resolution walks up from the importing file's own directory looking for
   `node_modules`; a file under `/tmp` can't find the project's
   `node_modules` and `drizzle-orm` (or any other package) fails to resolve.

   ```bash
   cat > /opt/render/project/src/scripts/.reingest-demo-tmp.ts <<'SCRIPT_EOF'
   import { randomUUID } from 'node:crypto';
   import { eq, inArray } from 'drizzle-orm';
   import { db, pool } from '../src/db/index.js';
   import { documents, users, ingestionJobs } from '../src/db/schema.js';
   import { ingestionQueue, redisConnection } from '../src/queue/index.js';
   import { env } from '../src/config/env.js';
   ```

async function main(): Promise<void> {
if (env.NODE_ENV !== 'beta') throw new Error(`Refusing to run: NODE_ENV=${env.NODE_ENV}`);
if (!new URL(env.DATABASE_URL).host.endsWith('neon.tech')) {
throw new Error(`Refusing to run: unexpected DB host ${new URL(env.DATABASE_URL).host}`);
}

const demoUsers = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.isDemo, true));
if (demoUsers.length === 0) { console.log('No demo accounts found.'); return; }
console.log(`Found ${demoUsers.length} demo account(s): ${demoUsers.map((u) => u.email).join(', ')}`);

const demoUserIds = demoUsers.map((u) => u.id);
const docs = await db
.select({ id: documents.id, storageKey: documents.storageKey, status: documents.status, userId: documents.userId })
.from(documents)
.where(inArray(documents.userId, demoUserIds));

const targets = docs.filter((d) => d.storageKey);
console.log(`${docs.length} document(s) found, ${targets.length} have a storage key.`);

let enqueued = 0;
for (const doc of targets) {
const bullJobId = randomUUID();
await db.insert(ingestionJobs).values({ documentId: doc.id, bullJobId, status: 'queued', attempt: 1 });
await ingestionQueue.add(
'ingest',
{ documentId: doc.id, storageKey: doc.storageKey as string, attempt: 1, userId: doc.userId },
{ jobId: bullJobId },
);
enqueued++;
console.log(`Enqueued ${enqueued}/${targets.length} — ${doc.id} (was '${doc.status}')`);
}
console.log(`Done. ${enqueued} job(s) enqueued.`);
}

main()
.catch((err) => { console.error('Fatal:', err); process.exitCode = 1; })
.finally(async () => { await ingestionQueue.close(); await redisConnection.quit(); await pool.end(); });
SCRIPT_EOF
npx tsx /opt/render/project/src/scripts/.reingest-demo-tmp.ts
rm /opt/render/project/src/scripts/.reingest-demo-tmp.ts

```

## Notes

- This deletes each targeted document's existing chunks (Postgres + Qdrant)
before re-extracting, so those documents are briefly unretrievable while
their job runs, and re-embedding spends OpenAI tokens on the beta key.
- Scope is _all_ documents for every `is_demo = true` user, regardless of
current status — adjust the `docs` query above (e.g. filter by `status`)
for a narrower run.
- Bypasses the app's `assertNotDemo` route guard on purpose — this is an
operator action run directly against the DB/queue, not the public API.
```

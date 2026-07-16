// Drives the delete/re-ingest ordering that lifecycle.yaml's two cases need,
// which a single `promptfoo eval` invocation can't express (all test cases in
// one config run independently). Assumes `npm run setup` has already run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { getAccessToken } from './auth.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

const BASE_URL = process.env.MEMORY_BANK_API_URL || 'http://localhost:3000';
const EVAL_USER_EMAIL = process.env.EVAL_USER_EMAIL;
const EVAL_USER_PASSWORD = process.env.EVAL_USER_PASSWORD;

async function findDocumentByName(token, originalName) {
  const res = await fetch(`${BASE_URL}/api/documents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to list documents: HTTP ${res.status}: ${await res.text()}`);
  }
  const { data } = await res.json();
  const doc = data.items.find((d) => d.originalName === originalName);
  if (!doc) {
    throw new Error(
      `No document named "${originalName}" found. Did you run \`npm run setup\` first?`,
    );
  }
  return doc;
}

async function deleteDocument(token, documentId) {
  const res = await fetch(`${BASE_URL}/api/documents/${documentId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to delete document ${documentId}: HTTP ${res.status}: ${await res.text()}`,
    );
  }
}

async function uploadAs(token, filePath, filename, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: mimeType }), filename);

  const res = await fetch(`${BASE_URL}/api/documents/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Upload failed for ${filename}: HTTP ${res.status}: ${await res.text()}`);
  }
  const { data } = await res.json();
  return data.documentId;
}

async function pollUntilIndexed(
  token,
  documentId,
  { timeoutMs = 120_000, intervalMs = 2000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${documentId} to index.`);
    }
    const res = await fetch(`${BASE_URL}/api/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch document ${documentId}: HTTP ${res.status}: ${await res.text()}`,
      );
    }
    const { data } = await res.json();
    if (data.status === 'indexed') return;
    if (data.status === 'failed') {
      throw new Error(`Ingestion failed for ${documentId}: ${data.errorMessage}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function runPromptfoo(configFile) {
  console.log(`\nRunning promptfoo eval -c ${configFile}...`);
  const result = spawnSync('npx', ['promptfoo', 'eval', '-c', configFile], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status === 0;
}

async function main() {
  if (!EVAL_USER_EMAIL || !EVAL_USER_PASSWORD) {
    console.error('EVAL_USER_EMAIL and EVAL_USER_PASSWORD must be set (see .env.example)');
    process.exit(1);
  }

  const token = await getAccessToken(BASE_URL, EVAL_USER_EMAIL, EVAL_USER_PASSWORD);
  let allPassed = true;

  // --- Case 1: delete packing_guides.csv, then confirm the answer doesn't
  // reference it anymore. ---
  console.log('Deleting packing_guides.csv...');
  const packingDoc = await findDocumentByName(token, 'packing_guides.csv');
  await deleteDocument(token, packingDoc.id);
  console.log('Deleted. Running the post-delete staleness check...');
  allPassed = runPromptfoo('promptfooconfig.lifecycle-deleted.yaml') && allPassed;

  // --- Case 2: delete + re-upload retirement_planning.md (same filename,
  // updated content), then confirm the answer reflects the new content. ---
  console.log('\nDeleting and re-ingesting retirement_planning.md with updated content...');
  const retirementDoc = await findDocumentByName(token, 'retirement_planning.md');
  await deleteDocument(token, retirementDoc.id);

  const v2Path = join(ROOT, 'fixtures', '_lifecycle', 'retirement_planning_v2.md');
  const newDocumentId = await uploadAs(token, v2Path, 'retirement_planning.md', 'text/markdown');
  console.log('Re-uploaded. Waiting for indexing...');
  await pollUntilIndexed(token, newDocumentId);

  console.log('Re-indexed. Running the post-reingest freshness check...');
  allPassed = runPromptfoo('promptfooconfig.lifecycle-reingested.yaml') && allPassed;

  if (!allPassed) {
    console.error('\nOne or more lifecycle checks failed.');
    process.exit(1);
  }
  console.log('\nAll lifecycle checks passed.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

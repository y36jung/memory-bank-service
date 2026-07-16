// Registers (or logs in) the eval user, uploads the main fixture corpus, and
// polls until every document is indexed. Run before `npm run eval`.

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getAccessToken } from './auth.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

const BASE_URL = process.env.MEMORY_BANK_API_URL || 'http://localhost:3000';
const EVAL_USER_EMAIL = process.env.EVAL_USER_EMAIL;
const EVAL_USER_PASSWORD = process.env.EVAL_USER_PASSWORD;

const MIME_TYPES = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
};

function listFixtureFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue; // skip _lifecycle and similar reserved dirs
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFixtureFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

async function uploadFixture(baseUrl, token, filePath) {
  const filename = filePath.split('/').pop();
  const mimeType = MIME_TYPES[extname(filename)] || 'application/octet-stream';
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)], { type: mimeType }), filename);

  const res = await fetch(`${baseUrl}/api/documents/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Upload failed for ${filename}: HTTP ${res.status}: ${await res.text()}`);
  }

  const { data } = await res.json();
  return { filename, documentId: data.documentId };
}

async function pollUntilIndexed(
  baseUrl,
  token,
  uploaded,
  { timeoutMs = 240_000, intervalMs = 2000 } = {},
) {
  const pending = new Map(uploaded.map((u) => [u.documentId, u.filename]));
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for indexing. Still pending: ${[...pending.values()].join(', ')}`,
      );
    }

    const res = await fetch(`${baseUrl}/api/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to list documents: HTTP ${res.status}: ${await res.text()}`);
    }
    const { data } = await res.json();

    for (const doc of data.items) {
      if (!pending.has(doc.id)) continue;
      if (doc.status === 'indexed') {
        pending.delete(doc.id);
      } else if (doc.status === 'failed') {
        throw new Error(`Ingestion failed for ${doc.originalName}: ${doc.errorMessage}`);
      }
    }

    if (pending.size > 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

async function main() {
  if (!EVAL_USER_EMAIL || !EVAL_USER_PASSWORD) {
    console.error('EVAL_USER_EMAIL and EVAL_USER_PASSWORD must be set (see .env.example)');
    process.exit(1);
  }

  console.log(`Authenticating as ${EVAL_USER_EMAIL}...`);
  const token = await getAccessToken(BASE_URL, EVAL_USER_EMAIL, EVAL_USER_PASSWORD);

  const files = listFixtureFiles(FIXTURES_DIR);
  console.log(`Uploading ${files.length} fixture document(s)...`);

  const uploaded = [];
  for (const filePath of files) {
    const result = await uploadFixture(BASE_URL, token, filePath);
    console.log(`  ${result.filename} -> ${result.documentId}`);
    uploaded.push(result);
  }

  console.log('Waiting for indexing to complete...');
  await pollUntilIndexed(BASE_URL, token, uploaded);

  console.log(`Done. ${uploaded.length} document(s) indexed.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

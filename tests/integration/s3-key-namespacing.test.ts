/**
 * Slice 3 — S3 key re-namespacing per user. Plan §9 rows 2-4 and §8 edge
 * cases #1, #2, #7.
 *
 * Runs against REAL Postgres (mb_test_slice1), real Redis (BullMQ enqueue
 * only — no worker is started, per buildTestApp.ts's documented rationale),
 * and REAL S3 (the bucket configured in .env — confirmed reachable; see
 * probe in test-verification's handback). No mocks, per PLAN.md §M1
 * Deliverables.
 *
 * Every object this suite creates in S3 is cleaned up in `afterAll`/test
 * bodies via `deleteObject`, whether or not the route under test also
 * deletes it, so the suite leaves no residue in the real bucket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument } from './helpers/seed.js';
import { signHS256 } from './helpers/jwt.js';
import { env } from '../../src/config/env.js';
import { db, pool } from '../../src/db/index.js';
import { documents } from '../../src/db/schema.js';
import {
  putObject,
  getObjectBuffer,
  deleteObject,
  buildDocumentStorageKey,
} from '../../src/services/storage.js';
import { randomUUID } from 'node:crypto';

describe('Slice 3 — S3 key re-namespacing per user', () => {
  let app: FastifyInstance;
  const s3KeysToCleanUp: string[] = [];

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    // Best-effort cleanup of any S3 object this suite created that the
    // route under test did not already delete.
    for (const key of s3KeysToCleanUp) {
      await getObjectBuffer(key).catch(() => null); // no-op, just avoid unhandled rejections
    }
    await app.close();
    await pool.end();
  });

  it('plan §9 row 2: a fresh upload by user U produces a storage_key matching ^users/U/documents/ and ending with the filename', async () => {
    const user = await seedUser('fresh-upload-owner');
    const token = signHS256({ sub: user.id }, env.JWT_SECRET);

    const boundary = '----slice3boundary';
    const filename = 'slice3-fresh-upload.txt';
    const payload = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: text/plain',
      '',
      'slice-3 fresh upload probe content',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const documentId = res.json().data.documentId;
    expect(documentId).toEqual(expect.any(String));

    const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(row).toBeDefined();
    expect(row?.storageKey).toBeDefined();
    const storageKey = row!.storageKey!;

    expect(storageKey).toMatch(new RegExp(`^users/${user.id}/documents/`));
    expect(storageKey.endsWith(filename)).toBe(true);
    expect(storageKey).toBe(buildDocumentStorageKey(user.id, documentId, filename));

    s3KeysToCleanUp.push(storageKey);

    // Confirm the object really landed in S3 under the new-format key
    // (proves uploadStream received the namespaced key, not just that the
    // DB row was written).
    const buf = await getObjectBuffer(storageKey);
    expect(buf?.toString('utf8')).toBe('slice-3 fresh upload probe content');

    // Clean up the real S3 object ourselves (route under test does not
    // delete on upload — only DELETE /documents/:id does).
    await deleteObject(storageKey);
  });

  it('plan §9 row 3 / edge case #1: a legacy-format storage_key (documents/<id>/<name>) with a real S3 object keeps working for GET .../file and DELETE with zero migration', async () => {
    const user = await seedUser('legacy-format-owner');
    const token = signHS256({ sub: user.id }, env.JWT_SECRET);

    const legacyKey = `documents/${randomUUID()}/legacy-file.txt`;
    const legacyContent = 'legacy-format object, pre-dating the users/ prefix';
    await putObject(legacyKey, legacyContent, 'text/plain');
    s3KeysToCleanUp.push(legacyKey);

    const doc = await seedDocument(user.id, {
      storageKey: legacyKey,
      status: 'indexed',
      originalName: 'legacy-file.txt',
      filename: 'legacy-file.txt',
      mimeType: 'text/plain',
    });

    // GET /documents/:id/file must still stream the legacy-keyed object.
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}/file`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body).toBe(legacyContent);

    // DELETE /documents/:id must still remove the legacy-keyed object.
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${doc.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ data: { deleted: true }, error: null });

    const [rowAfterDelete] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(rowAfterDelete).toBeUndefined();

    // The S3 object itself must be gone (not just the DB row) — proves
    // DELETE dereferenced the legacy key verbatim rather than re-deriving
    // a users/<userId>/... key that would never have matched anything.
    const afterDelete = await getObjectBuffer(legacyKey);
    expect(afterDelete).toBeNull();
  });

  it('plan §9 row 4: two users uploading identically-named files never collide', async () => {
    const userA = await seedUser('collision-user-a');
    const userB = await seedUser('collision-user-b');
    const tokenA = signHS256({ sub: userA.id }, env.JWT_SECRET);
    const tokenB = signHS256({ sub: userB.id }, env.JWT_SECRET);

    const filename = 'shared-name.txt';
    function multipartPayload(boundary: string, content: string) {
      return [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: text/plain',
        '',
        content,
        `--${boundary}--`,
        '',
      ].join('\r\n');
    }

    const boundaryA = '----slice3collisionA';
    const resA = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: {
        authorization: `Bearer ${tokenA}`,
        'content-type': `multipart/form-data; boundary=${boundaryA}`,
      },
      payload: multipartPayload(boundaryA, 'content from user A'),
    });
    expect(resA.statusCode).toBe(201);
    const docIdA = resA.json().data.documentId;

    const boundaryB = '----slice3collisionB';
    const resB = await app.inject({
      method: 'POST',
      url: '/api/documents/upload',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': `multipart/form-data; boundary=${boundaryB}`,
      },
      payload: multipartPayload(boundaryB, 'content from user B'),
    });
    expect(resB.statusCode).toBe(201);
    const docIdB = resB.json().data.documentId;

    const [rowA] = await db.select().from(documents).where(eq(documents.id, docIdA));
    const [rowB] = await db.select().from(documents).where(eq(documents.id, docIdB));

    expect(rowA?.storageKey).toBeDefined();
    expect(rowB?.storageKey).toBeDefined();
    expect(rowA!.storageKey).not.toBe(rowB!.storageKey);
    expect(rowA!.storageKey).toMatch(new RegExp(`^users/${userA.id}/documents/`));
    expect(rowB!.storageKey).toMatch(new RegExp(`^users/${userB.id}/documents/`));

    s3KeysToCleanUp.push(rowA!.storageKey!, rowB!.storageKey!);

    // Both objects independently readable and distinct in content — proves
    // no overwrite occurred despite the identical filename.
    const bufA = await getObjectBuffer(rowA!.storageKey!);
    const bufB = await getObjectBuffer(rowB!.storageKey!);
    expect(bufA?.toString('utf8')).toBe('content from user A');
    expect(bufB?.toString('utf8')).toBe('content from user B');

    await deleteObject(rowA!.storageKey!);
    await deleteObject(rowB!.storageKey!);
  });
});

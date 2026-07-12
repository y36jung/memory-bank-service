/**
 * Auth identity flow (register/login/refresh/logout) — slice-3 plan §9 rows 2-4:
 *   - Criterion 2: two distinct users register/login and get independently
 *     scoped access tokens + refresh cookies; A's refresh cookie can never
 *     mint B's session; A's access token only reaches A's own documents
 *     (cross-user isolation extends to the new /auth/* surface).
 *   - Criterion 3: refresh-token reuse detection revokes the WHOLE family —
 *     replaying a used token fails, and so does the newest-issued child that
 *     was never itself replayed (both get marked is_used = true).
 *   - Criterion 4 (body-level secret hygiene): no `password_hash` field and
 *     no raw refresh-token value ever appears in a JSON response body; the
 *     access token in the body IS intentional (needed for
 *     `Authorization: Bearer`) and is asserted present, not absent.
 *   - Edge cases from plan §8: #3 duplicate email, #4 null password_hash,
 *     #5 wrong password, #9 expired refresh token, #10 missing/blank cookie.
 *
 * Runs against a real Fastify app (helpers/buildTestApp.ts) and real Postgres
 * (mb_test_slice1, migrated by tests/integration/globalSetup.ts) — no mocks.
 *
 * Rate-limit note: register and login each have an INDEPENDENT per-IP
 * counter (a fresh child LocalStore per route, keyed only by req.ip — see
 * node_modules/@fastify/rate-limit's onRoute/child-store wiring). This file
 * calls register <=6 times and login <=5 times total, both well under the
 * max: 10/1min per-route budget, so no test here trips the limiter. The
 * dedicated 429 assertion lives in its own file/app instance: rate-limit.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildTestApp } from './helpers/buildTestApp.js';
import { seedUser, seedDocument, seedRefreshToken } from './helpers/seed.js';
import { db, pool } from '../../src/db/index.js';
import { refreshTokens } from '../../src/db/schema.js';
import { REFRESH_COOKIE_NAME } from '../../src/lib/refreshToken.js';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@test.local`;
}

/** Decode (not verify) a JWT's payload — sufficient for asserting `sub` in-process. */
function decodeJwtSub(token: string): string {
  const parts = token.split('.');
  const payloadB64 = parts[1];
  if (!payloadB64) throw new Error('decodeJwtSub: malformed JWT');
  const payload: { sub: string } = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  );
  return payload.sub;
}

function getRefreshCookie(res: LightMyRequestResponse) {
  const found = res.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
  if (!found) throw new Error(`getRefreshCookie: ${REFRESH_COOKIE_NAME} not set on response`);
  return found;
}

describe('auth identity flow — /api/auth/{register,login,refresh,logout}', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('criterion 2 — two distinct users, cross-user isolation on the new endpoints', () => {
    it('A and B each get their own user-scoped access token + refresh cookie; A refresh cannot mint B session; A token only reaches A documents', async () => {
      const emailA = uniqueEmail('flow-a');
      const emailB = uniqueEmail('flow-b');
      const password = 'password123';

      const registerA = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: emailA, password },
      });
      expect(registerA.statusCode).toBe(201);
      const bodyRegA = registerA.json();
      expect(bodyRegA.error).toBeNull();
      expect(decodeJwtSub(bodyRegA.data.accessToken)).toBe(bodyRegA.data.user.id);
      const cookieRegA = getRefreshCookie(registerA);

      const registerB = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: emailB, password },
      });
      expect(registerB.statusCode).toBe(201);
      const bodyRegB = registerB.json();
      expect(decodeJwtSub(bodyRegB.data.accessToken)).toBe(bodyRegB.data.user.id);
      const cookieRegB = getRefreshCookie(registerB);

      expect(bodyRegA.data.user.id).not.toBe(bodyRegB.data.user.id);
      expect(cookieRegA.value).not.toBe(cookieRegB.value);

      const loginA = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: emailA, password },
      });
      expect(loginA.statusCode).toBe(200);
      const bodyLoginA = loginA.json();
      expect(decodeJwtSub(bodyLoginA.data.accessToken)).toBe(bodyRegA.data.user.id);
      const cookieLoginA = getRefreshCookie(loginA);

      const loginB = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: emailB, password },
      });
      expect(loginB.statusCode).toBe(200);
      const bodyLoginB = loginB.json();
      expect(decodeJwtSub(bodyLoginB.data.accessToken)).toBe(bodyRegB.data.user.id);
      const cookieLoginB = getRefreshCookie(loginB);

      // Each login mints a fresh, distinct refresh-token family root.
      expect(cookieLoginA.value).not.toBe(cookieLoginB.value);
      expect(cookieLoginA.value).not.toBe(cookieRegA.value);

      // A's refresh cookie mints ONLY A's session — never B's, regardless of
      // how the token is presented.
      const refreshAsA = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: cookieLoginA.value },
      });
      expect(refreshAsA.statusCode).toBe(200);
      const refreshedSub = decodeJwtSub(refreshAsA.json().data.accessToken);
      expect(refreshedSub).toBe(bodyRegA.data.user.id);
      expect(refreshedSub).not.toBe(bodyRegB.data.user.id);

      // A's access token only reaches A's documents (cross-user isolation
      // preserved on the pre-existing, slice-1/2 protected surface).
      const doc = await seedDocument(bodyRegA.data.user.id);

      const getAsOwner = await app.inject({
        method: 'GET',
        url: `/api/documents/${doc.id}`,
        headers: { authorization: `Bearer ${bodyRegA.data.accessToken}` },
      });
      expect(getAsOwner.statusCode).toBe(200);
      expect(getAsOwner.json().data.userId).toBe(bodyRegA.data.user.id);

      const getAsStranger = await app.inject({
        method: 'GET',
        url: `/api/documents/${doc.id}`,
        headers: { authorization: `Bearer ${bodyRegB.data.accessToken}` },
      });
      expect(getAsStranger.statusCode).toBe(404);
    });
  });

  describe('criterion 3 — refresh-token reuse detection revokes the whole family', () => {
    it('replaying the original root token after rotation -> 401; the newest-issued child then also fails; every family row is_used = true', async () => {
      const email = uniqueEmail('reuse');
      const password = 'password123';

      const registerRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password },
      });
      expect(registerRes.statusCode).toBe(201);
      const userId: string = registerRes.json().data.user.id;
      const rootRaw = getRefreshCookie(registerRes).value;

      // Rotate once: root R -> child C1.
      const refresh1 = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rootRaw },
      });
      expect(refresh1.statusCode).toBe(200);
      const childRaw = getRefreshCookie(refresh1).value;
      expect(childRaw).not.toBe(rootRaw);

      // Replay the ORIGINAL root token R -> 401 (reuse detected; family revoked).
      const replayRoot = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: rootRaw },
      });
      expect(replayRoot.statusCode).toBe(401);
      expect(replayRoot.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });

      // The newest-issued token in the family (C1, never itself replayed
      // before now) must ALSO fail — the whole family was revoked, not just R.
      const replayChild = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: childRaw },
      });
      expect(replayChild.statusCode).toBe(401);
      expect(replayChild.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });

      // Every row in this user's refresh-token family is marked is_used = true.
      const familyRows = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
      expect(familyRows).toHaveLength(2); // root R + child C1
      expect(familyRows.every((r) => r.isUsed === true)).toBe(true);
    });
  });

  describe('criterion 4 — body-level secret hygiene', () => {
    it('no password_hash or raw refresh-token value ever appears in a response body; accessToken IS present (not a leak)', async () => {
      const email = uniqueEmail('hygiene');
      const password = 'password123';

      const registerRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password },
      });
      expect(registerRes.statusCode).toBe(201);
      const registerBody = registerRes.json();
      const registerRaw = getRefreshCookie(registerRes).value;

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
      });
      expect(loginRes.statusCode).toBe(200);
      const loginBody = loginRes.json();
      const loginRaw = getRefreshCookie(loginRes).value;

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: loginRaw },
      });
      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = refreshRes.json();
      const refreshRaw = getRefreshCookie(refreshRes).value;

      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { [REFRESH_COOKIE_NAME]: refreshRaw },
      });
      expect(logoutRes.statusCode).toBe(200);
      const logoutBody = logoutRes.json();

      const bodies = [registerBody, loginBody, refreshBody, logoutBody];
      const rawSecrets = [registerRaw, loginRaw, refreshRaw];

      for (const body of bodies) {
        const serialized = JSON.stringify(body);
        expect(serialized).not.toMatch(/password_hash/i);
        expect(serialized).not.toMatch(/passwordHash/i);
        for (const raw of rawSecrets) {
          expect(serialized).not.toContain(raw);
        }
      }

      // Intentional: the access token IS in the JSON body (needed for the
      // client to set `Authorization: Bearer`). Not a leak — asserted present.
      expect(typeof registerBody.data.accessToken).toBe('string');
      expect(registerBody.data.accessToken.length).toBeGreaterThan(0);
      expect(typeof loginBody.data.accessToken).toBe('string');
      expect(typeof refreshBody.data.accessToken).toBe('string');
    });
  });

  describe('edge cases (plan §8)', () => {
    it('#3 duplicate email on register -> 409 EMAIL_TAKEN', async () => {
      const email = uniqueEmail('dup');
      const password = 'password123';

      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        data: null,
        error: { code: 'EMAIL_TAKEN', message: expect.any(String) },
      });
    });

    it('#5 login with wrong password -> 401 INVALID_CREDENTIALS', async () => {
      const user = await seedUser('wrong-pw', 'correct-password');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: 'incorrect-password' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
      });
    });

    it('#4 login for a user with password_hash = null (legacy/synthetic) -> 401 INVALID_CREDENTIALS', async () => {
      const user = await seedUser('null-pw-hash'); // no password given => passwordHash stays null

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: 'whatever123' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
      });
    });

    it('#5b login with a malformed email (fails Zod .email(), never reaches the handler) -> 401 INVALID_CREDENTIALS, not 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'test', password: 'whatever123' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
      });
    });

    it('#5c login with a too-short password (fails Zod .min(8)) -> 401 INVALID_CREDENTIALS, not 500', async () => {
      const user = await seedUser('short-pw');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: 'short' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
      });
    });

    it('#5d login with password field omitted entirely -> 401 INVALID_CREDENTIALS, not 500', async () => {
      const user = await seedUser('missing-pw-field');

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
      });
    });

    it('#9 expired refresh token -> 401 UNAUTHORIZED and the cookie is cleared', async () => {
      const user = await seedUser('expired-rt');
      const { raw } = await seedRefreshToken(user.id, { expiresAt: new Date(Date.now() - 1000) });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: raw },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
      const cleared = getRefreshCookie(res);
      expect(cleared.value).toBe('');
    });

    it('#10 missing refresh cookie on /refresh -> 401; blank refresh cookie on /refresh -> 401', async () => {
      const missing = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });

      const blank = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: '' },
      });
      expect(blank.statusCode).toBe(401);
      expect(blank.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    });

    it('#10 missing/blank refresh cookie on /logout is idempotent 200', async () => {
      const missing = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toEqual({ data: { success: true }, error: null });

      const blank = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { [REFRESH_COOKIE_NAME]: '' },
      });
      expect(blank.statusCode).toBe(200);
      expect(blank.json()).toEqual({ data: { success: true }, error: null });
    });
  });
});

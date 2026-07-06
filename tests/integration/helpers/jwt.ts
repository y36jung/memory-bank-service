/**
 * Minimal, dependency-free JWT construction for testing src/plugins/auth.ts.
 *
 * Deliberately hand-rolled with node:crypto rather than importing `fast-jwt`
 * (an undeclared transitive dependency of @fastify/jwt) or `jsonwebtoken`
 * (not installed) — this also lets us construct deliberately-malicious
 * tokens (alg: none, alg: HS384 confusion) that a "just sign a valid token"
 * helper library wouldn't easily produce.
 */
import { createHmac } from 'node:crypto';

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** Sign a standard HS256 JWT with the given secret. */
export function signHS256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSecs = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: nowSecs, ...payload };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Sign an already-expired HS256 JWT (exp in the past). */
export function signExpiredHS256(payload: Record<string, unknown>, secret: string): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  return signHS256({ ...payload, exp: nowSecs - 3600 }, secret);
}

/** Build a token with `alg: none` and no signature segment — the classic algorithm-confusion attack. */
export function signAlgNone(payload: Record<string, unknown>): string {
  const header = { alg: 'none', typ: 'JWT' };
  const nowSecs = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: nowSecs, ...payload };
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}.`;
}

/** Build a token with an asymmetric-looking alg header (HS256 signature underneath — the header just lies). */
export function signAlgConfusion(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSecs = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: nowSecs, ...payload };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}`;
  // Signed with HMAC using the "public-ish" secret — since there's no real RSA key,
  // this exercises the "declared alg doesn't match verify.algorithms allow-list" path.
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

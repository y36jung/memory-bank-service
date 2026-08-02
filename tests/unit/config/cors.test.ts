/**
 * Unit tests for src/config/cors.ts — sse-cors-origin-check plan §5.5.
 *
 * This is the regression proof for the SSE-mirror bug: an arbitrary Origin
 * (e.g. https://evil.example) must never be reflected as an allowed origin,
 * in any NODE_ENV.
 *
 * tests/unit/setup.ts pins NODE_ENV=test for this whole unit suite, so the
 * plain top-of-file import already exercises the default/test-env branch.
 * `CORS_ALLOWED_ORIGINS` is computed once at module load from `env.NODE_ENV`
 * (plan §8 edge case #7), so the development and beta branches are
 * unreachable via a normal static import — they are reached below via
 * `vi.resetModules()` + an overridden `process.env.NODE_ENV` + a dynamic
 * re-import of the module (and, transitively, of src/config/env.ts).
 *
 * No mocks: this exercises the real module under real env-var values.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  CORS_ALLOWED_ORIGINS,
  isAllowedOrigin,
  assertTrustedOrigin,
} from '../../../src/config/cors.js';
import { AppError } from '../../../src/lib/errors.js';

function requestWithOrigin(origin: string | undefined): FastifyRequest {
  return { headers: origin === undefined ? {} : { origin } } as FastifyRequest;
}

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_REGISTRATION_SECRET = process.env['REGISTRATION_SECRET'];

describe('src/config/cors.ts', () => {
  // Suite-isolation guard (plan §5.5): every test that mutates
  // process.env.NODE_ENV restores it and clears the module registry
  // afterward, whether or not the test also did so itself.
  afterEach(() => {
    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
    if (ORIGINAL_REGISTRATION_SECRET === undefined) {
      delete process.env['REGISTRATION_SECRET'];
    } else {
      process.env['REGISTRATION_SECRET'] = ORIGINAL_REGISTRATION_SECRET;
    }
    vi.resetModules();
  });

  describe('default/test env (as the suite runs, NODE_ENV=test)', () => {
    it('CORS_ALLOWED_ORIGINS resolves to an empty list', () => {
      expect(CORS_ALLOWED_ORIGINS).toEqual([]);
    });

    it('isAllowedOrigin returns false for the dev frontend origin', () => {
      expect(isAllowedOrigin('http://localhost:3001')).toBe(false);
    });

    it('isAllowedOrigin returns false for an arbitrary untrusted origin (regression guard)', () => {
      expect(isAllowedOrigin('https://evil.example')).toBe(false);
    });

    it('isAllowedOrigin returns false for a missing Origin (undefined)', () => {
      expect(isAllowedOrigin(undefined)).toBe(false);
    });

    it('assertTrustedOrigin does not throw when Origin is absent (fails open on missing)', () => {
      expect(() => assertTrustedOrigin(requestWithOrigin(undefined))).not.toThrow();
    });

    it('assertTrustedOrigin throws AppError("FORBIDDEN", 403) when Origin is present and not allow-listed', () => {
      try {
        assertTrustedOrigin(requestWithOrigin('https://evil.example'));
        expect.unreachable('assertTrustedOrigin should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('FORBIDDEN');
        expect((err as AppError).statusCode).toBe(403);
      }
    });
  });

  describe('development env (module reloaded under NODE_ENV=development)', () => {
    it('CORS_ALLOWED_ORIGINS resolves to the local frontend only', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'development';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3001']);
    });

    it('isAllowedOrigin returns true for the trusted dev origin', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'development';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('http://localhost:3001')).toBe(true);
    });

    it('isAllowedOrigin returns false for an arbitrary untrusted origin (regression guard)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'development';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('https://evil.example')).toBe(false);
    });

    it('isAllowedOrigin returns false for a missing Origin (undefined)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'development';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin(undefined)).toBe(false);
    });
  });

  describe('beta env (module reloaded under NODE_ENV=beta)', () => {
    it('CORS_ALLOWED_ORIGINS resolves to the deployed frontend and the local dev frontend', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'beta';
      process.env['REGISTRATION_SECRET'] = 'test-registration-secret';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.CORS_ALLOWED_ORIGINS).toEqual([
        'https://memory-bank-ui.vercel.app',
        'http://localhost:3001',
      ]);
    });

    it('isAllowedOrigin returns true for the deployed frontend origin', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'beta';
      process.env['REGISTRATION_SECRET'] = 'test-registration-secret';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('https://memory-bank-ui.vercel.app')).toBe(true);
    });

    it('isAllowedOrigin returns true for the local dev frontend origin (lets local frontend test against the deployed beta API)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'beta';
      process.env['REGISTRATION_SECRET'] = 'test-registration-secret';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('http://localhost:3001')).toBe(true);
    });

    it('isAllowedOrigin returns false for an arbitrary untrusted origin (regression guard)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'beta';
      process.env['REGISTRATION_SECRET'] = 'test-registration-secret';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('https://evil.example')).toBe(false);
    });

    it('isAllowedOrigin returns false for a missing Origin (undefined)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'beta';
      process.env['REGISTRATION_SECRET'] = 'test-registration-secret';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin(undefined)).toBe(false);
    });

    it('assertTrustedOrigin does not throw when Origin matches the allow-list', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'beta';
      process.env['REGISTRATION_SECRET'] = 'test-registration-secret';
      const mod = await import('../../../src/config/cors.js');
      expect(() =>
        mod.assertTrustedOrigin(requestWithOrigin('https://memory-bank-ui.vercel.app')),
      ).not.toThrow();
    });
  });
});

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
 * (plan §8 edge case #7), so the development and production branches are
 * unreachable via a normal static import — they are reached below via
 * `vi.resetModules()` + an overridden `process.env.NODE_ENV` + a dynamic
 * re-import of the module (and, transitively, of src/config/env.ts).
 *
 * No mocks: this exercises the real module under real env-var values.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CORS_ALLOWED_ORIGINS, isAllowedOrigin } from '../../../src/config/cors.js';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

describe('src/config/cors.ts', () => {
  // Suite-isolation guard (plan §5.5): every test that mutates
  // process.env.NODE_ENV restores it and clears the module registry
  // afterward, whether or not the test also did so itself.
  afterEach(() => {
    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
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

  describe('production env (module reloaded under NODE_ENV=production)', () => {
    it('CORS_ALLOWED_ORIGINS resolves to an empty list', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'production';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.CORS_ALLOWED_ORIGINS).toEqual([]);
    });

    it('isAllowedOrigin returns false for the dev frontend origin', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'production';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('http://localhost:3001')).toBe(false);
    });

    it('isAllowedOrigin returns false for an arbitrary untrusted origin (regression guard)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'production';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin('https://evil.example')).toBe(false);
    });

    it('isAllowedOrigin returns false for a missing Origin (undefined)', async () => {
      vi.resetModules();
      process.env['NODE_ENV'] = 'production';
      const mod = await import('../../../src/config/cors.js');
      expect(mod.isAllowedOrigin(undefined)).toBe(false);
    });
  });
});

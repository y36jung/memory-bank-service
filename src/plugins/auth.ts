import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { generateRefreshToken } from '../lib/refreshToken.js';
import { env } from '../config/env.js';

// fastifyJwt registration + the `declare module '@fastify/jwt'` augmentation
// live in ./jwt.ts (registered at root). This plugin is registered inside
// protectedScope and only enforces the presence of a valid token.

declare module 'fastify' {
  interface FastifyRequest {
    // Per-browser id for the shared demo account (isDemo === true users all
    // share one userId). Only ever set when request.user.isDemo is true —
    // see the preHandler below and src/lib/chatOwnership.ts.
    demoDeviceId?: string;
  }
}

export const DEMO_DEVICE_COOKIE_NAME = 'demo_device_id';
export const DEMO_DEVICE_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// path: '/' (unlike the refresh cookie's '/api/auth') — chat routes and the
// protected-scope rate limiter both need to read this outside /api/auth.
const DEMO_DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'beta',
  path: '/',
  maxAge: DEMO_DEVICE_COOKIE_TTL_MS / 1000, // @fastify/cookie maxAge is seconds
};

export const authPlugin = fp(async (app) => {
  app.decorateRequest('demoDeviceId', undefined);

  app.addHook('preHandler', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid authentication token', 401);
    }
    // Structured-logging enrichment (item 9): bind userId onto the request logger.
    request.log = request.log.child({ userId: request.user.id });

    if (request.user.isDemo) {
      const existing = request.cookies[DEMO_DEVICE_COOKIE_NAME];
      if (existing) {
        request.demoDeviceId = existing;
      } else {
        // generateRefreshToken() is just 32 random bytes, base64url — reused
        // here purely as a random-id generator. Not hashed: unlike the
        // refresh token this is a routing key, not a bearer credential.
        const minted = generateRefreshToken();
        request.demoDeviceId = minted;
        reply.setCookie(DEMO_DEVICE_COOKIE_NAME, minted, DEMO_DEVICE_COOKIE_OPTIONS);
      }
    }
  });
});

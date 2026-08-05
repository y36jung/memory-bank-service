import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { recordDemoDeviceSeen } from '../lib/demoDeviceTracking.js';

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

// Not a cookie: a plain request header. Sidesteps SameSite/cross-site cookie
// delivery entirely. The frontend generates the value itself
// (crypto.randomUUID(), cached to localStorage) and sends it on every
// request — the backend is a pure consumer, it never mints one. A demo
// request that arrives without it simply gets no demoDeviceId; see
// src/lib/chatOwnership.ts for how that fails closed (no rows) rather than
// leaking data across devices.
export const DEMO_DEVICE_HEADER_NAME = 'x-demo-device-id';

export const authPlugin = fp(async (app) => {
  app.decorateRequest('demoDeviceId', undefined);

  app.addHook('preHandler', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid authentication token', 401);
    }
    // Structured-logging enrichment (item 9): bind userId onto the request logger.
    request.log = request.log.child({ userId: request.user.id });

    if (request.user.isDemo) {
      const existing = request.headers[DEMO_DEVICE_HEADER_NAME];
      if (typeof existing === 'string' && existing.length > 0) {
        request.demoDeviceId = existing;
        try {
          if (await recordDemoDeviceSeen(existing)) {
            request.log.info({ deviceId: existing }, 'new demo device seen');
          }
        } catch (err) {
          request.log.warn({ err, deviceId: existing }, 'failed to record demo device');
        }
      }
    }
  });
});

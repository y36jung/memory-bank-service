import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { generateRefreshToken } from '../lib/refreshToken.js';

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

// Not a cookie: a plain header pair (request header in, response header out
// on mint). Sidesteps SameSite/cross-site cookie delivery entirely — see
// src/config/cors.ts's exposedHeaders for the corresponding CORS change
// required for the frontend to read the response header.
export const DEMO_DEVICE_HEADER_NAME = 'x-demo-device-id';

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
      const existing = request.headers[DEMO_DEVICE_HEADER_NAME];
      if (typeof existing === 'string' && existing.length > 0) {
        request.demoDeviceId = existing;
      } else {
        // generateRefreshToken() is just 32 random bytes, base64url — reused
        // here purely as a random-id generator. Not hashed: unlike the
        // refresh token this is a routing key, not a bearer credential.
        const minted = generateRefreshToken();
        request.demoDeviceId = minted;
        reply.header(DEMO_DEVICE_HEADER_NAME, minted);
      }
    }
  });
});

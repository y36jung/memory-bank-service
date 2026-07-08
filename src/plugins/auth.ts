import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

// fastifyJwt registration + the `declare module '@fastify/jwt'` augmentation
// live in ./jwt.ts (registered at root). This plugin is registered inside
// protectedScope and only enforces the presence of a valid token.
export const authPlugin = fp(async (app) => {
  app.addHook('preHandler', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid authentication token', 401);
    }
    // Structured-logging enrichment (item 9): bind userId onto the request logger.
    request.log = request.log.child({ userId: request.user.id });
  });
});

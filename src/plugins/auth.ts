import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

// Module augmentation: pin the token payload and the shape of request.user.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { id: string };
  }
}

export const authPlugin = fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    verify: { algorithms: ['HS256'] },
    formatUser: (payload) => ({ id: payload.sub }),
  });

  app.addHook('preHandler', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid authentication token', 401);
    }
  });
});

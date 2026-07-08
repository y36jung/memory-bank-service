import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env.js';

// Module augmentation: pin the token payload and the shape of request.user.
// Registered at root (§3.1-A) so both the public authRoutes (sign) and the
// protected scope (verify) share the same `app.jwt` decorator.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string }; // types BOTH app.jwt.sign(...) and request.jwtVerify()
    user: { id: string };
  }
}

export const jwtPlugin = fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    verify: { algorithms: ['HS256'] },
    formatUser: (payload) => ({ id: payload.sub }),
  });
});

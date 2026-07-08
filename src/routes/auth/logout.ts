import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { revokeRefreshTokenFamily } from '../../db/refreshTokens.js';
import { REFRESH_COOKIE_NAME, hashRefreshToken } from '../../lib/refreshToken.js';
import { sendSuccess } from '../../lib/errors.js';

// Public; no rate limit; idempotent even with no/unknown cookie.
export const logoutRoute: FastifyPluginAsyncZod = async (app) => {
  app.post('/logout', async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE_NAME];
    if (raw) {
      await revokeRefreshTokenFamily(hashRefreshToken(raw));
    }
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    sendSuccess(reply, { success: true });
  });
};

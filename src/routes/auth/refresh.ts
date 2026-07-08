import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { rotateRefreshToken } from '../../db/refreshTokens.js';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  generateRefreshToken,
  hashRefreshToken,
} from '../../lib/refreshToken.js';
import { sendSuccess, AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

// §3.1-B: cookie path is the minimal common prefix of /refresh and /logout.
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_TTL_MS / 1000, // @fastify/cookie maxAge is seconds
};

// Not rate-limited (per-IP tier scopes to login/register only, §5.11).
export const refreshRoute: FastifyPluginAsyncZod = async (app) => {
  app.post('/refresh', async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE_NAME];
    if (!raw) {
      throw new AppError('UNAUTHORIZED', 'Invalid refresh token', 401);
    }

    const newRaw = generateRefreshToken();
    const result = await rotateRefreshToken({
      presentedHash: hashRefreshToken(raw),
      newTokenHash: hashRefreshToken(newRaw),
      newExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    switch (result.status) {
      case 'rotated': {
        const accessToken = app.jwt.sign({ sub: result.userId }, { expiresIn: '15m' });
        reply.setCookie(REFRESH_COOKIE_NAME, newRaw, REFRESH_COOKIE_OPTIONS);
        sendSuccess(reply, { accessToken });
        break;
      }
      case 'reuse_detected':
        // Family already revoked inside rotateRefreshToken. Never log the token value.
        request.log.warn('refresh token reuse detected');
        reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
        throw new AppError('UNAUTHORIZED', 'Invalid refresh token', 401);
      case 'not_found':
      case 'expired':
        // Uniform code — no oracle about which failure occurred.
        reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
        throw new AppError('UNAUTHORIZED', 'Invalid refresh token', 401);
    }
  });
};

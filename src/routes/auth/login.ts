import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { insertRootRefreshToken } from '../../db/refreshTokens.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
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

export const loginRoute: FastifyPluginAsyncZod = async (app) => {
  // Derived from hashPassword() (src/lib/password.ts) so it always tracks
  // BCRYPT_COST. Precomputed once at plugin registration and captured in the
  // handler closure so the not-found / no-password path runs an
  // equivalent-cost bcrypt compare, equalizing timing against the real-user
  // path (no user-enumeration signal).
  const DUMMY_HASH = await hashPassword('invalid-dummy-password-for-timing');

  app.post(
    '/login',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.ip },
      },
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(8),
        }),
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

      if (!user || user.passwordHash == null) {
        await verifyPassword(request.body.password, DUMMY_HASH);
        throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
      }

      const ok = await verifyPassword(request.body.password, user.passwordHash);
      if (!ok) {
        throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
      }

      const accessToken = app.jwt.sign({ sub: user.id }, { expiresIn: '15m' });

      const raw = generateRefreshToken();
      await insertRootRefreshToken({
        userId: user.id,
        tokenHash: hashRefreshToken(raw),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });
      reply.setCookie(REFRESH_COOKIE_NAME, raw, REFRESH_COOKIE_OPTIONS);

      sendSuccess(reply, { user: { id: user.id, email: user.email }, accessToken });
    },
  );
};

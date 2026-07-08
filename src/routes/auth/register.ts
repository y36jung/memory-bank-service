import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { insertRootRefreshToken } from '../../db/refreshTokens.js';
import { hashPassword } from '../../lib/password.js';
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

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  // drizzle-orm@0.45.2 wraps driver errors in DrizzleQueryError; the real
  // Postgres error (with .code) is nested at err.cause, not top-level.
  const topLevelCode = 'code' in err ? (err as { code: unknown }).code : undefined;
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;

  return topLevelCode === '23505' || causeCode === '23505';
}

export const registerRoute: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/register',
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
      const passwordHash = await hashPassword(request.body.password);

      let user: { id: string; email: string };
      try {
        const [row] = await db
          .insert(users)
          .values({ email, passwordHash })
          .returning({ id: users.id, email: users.email });
        if (!row) throw new Error('register: insert returned no row');
        user = row;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('EMAIL_TAKEN', 'Email already registered', 409);
        }
        throw err;
      }

      const accessToken = app.jwt.sign({ sub: user.id }, { expiresIn: '15m' });

      const raw = generateRefreshToken();
      await insertRootRefreshToken({
        userId: user.id,
        tokenHash: hashRefreshToken(raw),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });
      reply.setCookie(REFRESH_COOKIE_NAME, raw, REFRESH_COOKIE_OPTIONS);

      sendSuccess(reply, { user: { id: user.id, email: user.email }, accessToken }, 201);
    },
  );
};

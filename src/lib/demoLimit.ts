import { redisConnection } from '../queue/index.js';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

const DEMO_MSG_COUNT_TTL_SECS = 25 * 60 * 60; // 24h + 1h buffer

function todayKey(): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `demo:msg-count:${day}`;
}

/**
 * Global, cross-visitor daily cap on demo-account chat messages — bounds
 * shared OpenAI spend regardless of how many concurrent demo devices are
 * active (that's src/server.ts's per-device rate limit, a separate concern).
 * Call before any OpenAI call / SSE header flush so a rejection is a plain
 * JSON 4xx, not a mid-stream SSE error.
 */
export async function assertDemoDailyLimitNotExceeded(): Promise<void> {
  const key = todayKey();
  const count = await redisConnection.incr(key);
  if (count === 1) {
    await redisConnection.expire(key, DEMO_MSG_COUNT_TTL_SECS);
  }
  if (count > env.DEMO_DAILY_MESSAGE_LIMIT) {
    throw new AppError(
      'DEMO_LIMIT_EXCEEDED',
      'The shared demo account has reached its daily message limit. Please try again tomorrow.',
      429,
    );
  }
}

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { chatSessions } from '../db/schema.js';

/**
 * Ownership predicate for chat_sessions. Regular users are scoped by userId
 * alone (unchanged behavior). The shared demo account has one userId across
 * every concurrent visitor, so demo requests are also scoped by the
 * per-browser demoDeviceId minted in src/plugins/auth.ts. A demo request
 * with no demoDeviceId shouldn't happen (the auth preHandler always mints
 * one for isDemo === true), but fails closed to a never-matching condition
 * rather than falling back to an unscoped cross-device leak.
 */
export function chatSessionOwnershipCondition(request: FastifyRequest): SQL {
  const userCondition = eq(chatSessions.userId, request.user.id);
  if (!request.user.isDemo) return userCondition;
  if (!request.demoDeviceId) return sql`false`;
  return and(userCondition, eq(chatSessions.deviceId, request.demoDeviceId)) as SQL;
}

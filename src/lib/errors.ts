import type { FastifyReply } from 'fastify';

/**
 * All failure modes the service can surface.
 * Kinds: not_found (404), bad_request (400), upstream (502).
 * Exhaustive switch via `satisfies never` at every call site.
 */
export type AppError =
  | { kind: 'not_found'; service?: string; cause?: unknown }
  | { kind: 'bad_request'; service?: string; cause?: unknown }
  | { kind: 'upstream'; service?: string; cause?: unknown };

/** Maps AppError.kind to its HTTP status code. */
const statusMap: Record<AppError['kind'], number> = {
  not_found: 404,
  bad_request: 400,
  upstream: 502,
};

/** Returns the HTTP status for a known kind, or 500 for unknown/absent kinds. */
export function statusFromKind(kind: AppError['kind'] | undefined): number {
  return kind != null ? statusMap[kind] : 500;
}

/**
 * Sends a typed error response and ends the reply.
 * Never exposes stack traces or internal details.
 *
 * @param reply - Active Fastify reply to write to
 * @param err - Typed application error to map to HTTP
 */
export function sendError(reply: FastifyReply, err: AppError): void {
  void reply.code(statusMap[err.kind]).send({ error: err.kind });
}

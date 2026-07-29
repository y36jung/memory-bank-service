import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export function assertNotDemo(request: FastifyRequest): void {
  if (request.user.isDemo) {
    throw new AppError('FORBIDDEN', 'Demo accounts cannot perform this action', 403);
  }
}

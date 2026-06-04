/**
 * Unit tests for src/lib/errors.ts
 *
 * Criteria covered:
 * AC-7a: sendSuccess produces { data, error: null }
 * AC-7b: sendError with AppError produces { data: null, error: { code, message } }
 * AC-7c: sendError with unknown error produces { data: null, error: { code: 'INTERNAL_ERROR', message } }
 * AC-7d: AppError carries code, message, and statusCode
 */

import { describe, it, expect, vi } from 'vitest';
import { AppError, sendSuccess, sendError } from '../../../src/lib/errors.js';
import type { FastifyReply } from 'fastify';

/**
 * Build a minimal Fastify reply mock that captures what was sent.
 */
function makeMockReply() {
  let capturedStatus = 200;
  let capturedBody: unknown = undefined;

  const reply = {
    status: vi.fn((code: number) => {
      capturedStatus = code;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      capturedBody = body;
      return reply;
    }),
    getStatus: () => capturedStatus,
    getBody: () => capturedBody,
  };

  return reply as unknown as FastifyReply & {
    getStatus: () => number;
    getBody: () => unknown;
  };
}

describe('AppError', () => {
  it('stores code, message, and default statusCode 400', () => {
    const err = new AppError('SOME_CODE', 'something went wrong');
    expect(err.code).toBe('SOME_CODE');
    expect(err.message).toBe('something went wrong');
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe('AppError');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts a custom statusCode', () => {
    const err = new AppError('NOT_FOUND', 'resource not found', 404);
    expect(err.statusCode).toBe(404);
  });

  it('throws AppError("UNSUPPORTED_FORMAT") for unsupported MIME — plan specifies this code', () => {
    const err = new AppError(
      'UNSUPPORTED_FORMAT',
      'Unsupported MIME type: application/octet-stream',
    );
    expect(err.code).toBe('UNSUPPORTED_FORMAT');
  });
});

describe('sendSuccess', () => {
  it('sends { data: <value>, error: null } with status 200 by default', () => {
    const reply = makeMockReply();
    sendSuccess(reply, { id: 'abc', name: 'test' });

    const body = reply.getBody() as { data: unknown; error: unknown };
    expect(reply.getStatus()).toBe(200);
    expect(body.data).toEqual({ id: 'abc', name: 'test' });
    expect(body.error).toBeNull();
  });

  it('sends a custom status code when provided', () => {
    const reply = makeMockReply();
    sendSuccess(reply, { created: true }, 201);
    expect(reply.getStatus()).toBe(201);
    const body = reply.getBody() as { data: unknown; error: unknown };
    expect(body.data).toEqual({ created: true });
    expect(body.error).toBeNull();
  });

  it('works with null data', () => {
    const reply = makeMockReply();
    sendSuccess(reply, null);
    const body = reply.getBody() as { data: unknown; error: unknown };
    expect(body.data).toBeNull();
    expect(body.error).toBeNull();
  });

  it('works with array data', () => {
    const reply = makeMockReply();
    sendSuccess(reply, [1, 2, 3]);
    const body = reply.getBody() as { data: unknown; error: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.error).toBeNull();
  });
});

describe('sendError', () => {
  it('sends { data: null, error: { code, message } } for AppError', () => {
    const reply = makeMockReply();
    const err = new AppError('VALIDATION_ERROR', 'invalid input', 422);
    sendError(reply, err);

    expect(reply.getStatus()).toBe(422);
    const body = reply.getBody() as {
      data: unknown;
      error: { code: string; message: string };
    };
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('invalid input');
  });

  it('sends 400 status for AppError with default statusCode', () => {
    const reply = makeMockReply();
    sendError(reply, new AppError('BAD', 'bad request'));
    expect(reply.getStatus()).toBe(400);
  });

  it('sends { data: null, error: { code: "INTERNAL_ERROR", message } } for generic Error', () => {
    const reply = makeMockReply();
    sendError(reply, new Error('unexpected crash'));

    expect(reply.getStatus()).toBe(500);
    const body = reply.getBody() as {
      data: unknown;
      error: { code: string; message: string };
    };
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('unexpected crash');
  });

  it('sends INTERNAL_ERROR for unknown non-Error values', () => {
    const reply = makeMockReply();
    sendError(reply, 'string error');

    expect(reply.getStatus()).toBe(500);
    const body = reply.getBody() as {
      data: unknown;
      error: { code: string; message: string };
    };
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

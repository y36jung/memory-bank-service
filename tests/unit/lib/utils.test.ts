/**
 * Unit tests for src/lib/utils.ts — withTimeout helper
 *
 * Criteria covered:
 * AC-5a: withTimeout rejects with "Timeout: <label> exceeded <ms>ms" when promise doesn't resolve in time
 * AC-5b: withTimeout resolves normally when promise completes before deadline
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout } from '../../../src/lib/utils.js';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value when it completes before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('hello'), 1000, 'test operation');
    expect(result).toBe('hello');
  });

  it('rejects with the correct timeout message when the promise does not resolve in time', async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise<string>(() => {
      // never resolves
    });

    const racePromise = withTimeout(neverResolves, 5000, 'OpenAI embedding');

    // Advance timers past the deadline
    vi.advanceTimersByTime(5001);

    await expect(racePromise).rejects.toThrow('Timeout: OpenAI embedding exceeded 5000ms');
  });

  it('error message format matches PLAN.md specification: "Timeout: <label> exceeded <ms>ms"', async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise<void>(() => {});
    const racePromise = withTimeout(neverResolves, 30000, 'OpenAI embedding');
    vi.advanceTimersByTime(30001);

    let caughtError: Error | undefined;
    try {
      await racePromise;
    } catch (err) {
      if (err instanceof Error) caughtError = err;
    }

    expect(caughtError).toBeDefined();
    // PLAN.md specifies: 'Timeout: OpenAI embedding exceeded 30000ms'
    expect(caughtError?.message).toBe('Timeout: OpenAI embedding exceeded 30000ms');
  });

  it('rejects with error mentioning label and ms for the extract step label', async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise<void>(() => {});
    const racePromise = withTimeout(neverResolves, 60000, 'extract');
    vi.advanceTimersByTime(60001);

    await expect(racePromise).rejects.toThrow('Timeout: extract exceeded 60000ms');
  });

  it('rejects with error mentioning label and ms for the postgres commit label', async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise<void>(() => {});
    const racePromise = withTimeout(neverResolves, 10000, 'postgres commit');
    vi.advanceTimersByTime(10001);

    await expect(racePromise).rejects.toThrow('Timeout: postgres commit exceeded 10000ms');
  });

  it('does not timeout when the promise resolves before the deadline', async () => {
    vi.useFakeTimers();

    const quickPromise = new Promise<number>((resolve) => {
      setTimeout(() => resolve(42), 100);
    });

    const racePromise = withTimeout(quickPromise, 5000, 'quick op');

    // Advance only 200ms — before the 5000ms deadline
    vi.advanceTimersByTime(200);

    const result = await racePromise;
    expect(result).toBe(42);
  });

  it('the rejected error is an instance of Error', async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise<void>(() => {});
    const racePromise = withTimeout(neverResolves, 1000, 'qdrant upsert');
    vi.advanceTimersByTime(1001);

    await expect(racePromise).rejects.toBeInstanceOf(Error);
  });
});

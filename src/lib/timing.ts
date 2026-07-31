/**
 * Temporary diagnostic helper for measuring per-stage latency in the chat
 * request path (Render vs. localhost investigation). Safe to delete along
 * with its call sites once the slow stage is identified.
 */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[timing] ${label}: ${Date.now() - start}ms`);
  }
}

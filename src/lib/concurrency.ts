// Shared by demo-retry.ts (and available to checkout.ts/demo-workers.ts) —
// the retry contract for transactions under REPEATABLE READ/SERIALIZABLE.

export interface PgError extends Error {
  code?: string;
}

export function pgErrorCode(err: unknown): string | undefined {
  return (err as PgError)?.code;
}

// serialization_failure and deadlock_detected — see README § Concurrency
// for why these two and nothing else.
export const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

export function isRetryablePgError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries the WHOLE operation — reads included, not just the write, which
 *  is what actually avoids turning a caught conflict into a silent lost
 *  update. Only retries 40001/40P01; anything else (a real bug, a
 *  constraint violation, insufficient stock) propagates immediately.
 *  `onRetry` is a pure observability hook (demo-retry.ts uses it to count
 *  how many conflicts actually happened across all callers) — it never
 *  affects the retry decision itself. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; onRetry?: (code: string, attempt: number) => void },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 6;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryablePgError(err) || attempt >= maxAttempts) throw err;
      const code = pgErrorCode(err) as string;
      // Capped — uncapped exponential growth is fine for 2 contenders, but
      // demo-retry.ts deliberately runs 10 writers against the same row, and
      // an uncapped 2^attempt turns a real (if unlikely) worst-case retry
      // chain into a multi-second wait. A real backoff always has a ceiling.
      const backoffMs = Math.round(Math.min(2 ** attempt * 15, 300) + Math.random() * 15);
      console.log(`  [retry] ${label}: attempt ${attempt} caught ${code} — retrying in ${backoffMs}ms`);
      options?.onRetry?.(code, attempt);
      await sleep(backoffMs);
    }
  }
}

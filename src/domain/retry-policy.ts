import type { Decision, DeliveryResult } from './types.js';

export interface RetryPolicyOptions {
  /** Total attempts allowed, including the first one. */
  maxAttempts: number;
  /** Delay before the second attempt; doubles after each failure. */
  baseDelayMs: number;
  /** Upper bound for any single delay, including a server-provided Retry-After. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyOptions = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
};

/**
 * Status codes worth retrying. 408 and 429 are 4xx but describe a temporary
 * condition on the receiver, so retrying them is correct; other 4xx mean the
 * request itself is wrong and will fail the same way every time.
 */
const RETRYABLE_4XX = new Set([408, 429]);

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_4XX.has(status);
}

/** Exponential backoff: base, 2*base, 4*base, ... capped at maxDelayMs. */
export function backoffDelay(attempt: number, options: RetryPolicyOptions): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  // 2 ** 1023 is still finite, but cap the exponent so the multiplication cannot overflow to Infinity.
  const exponent = Math.min(attempt - 1, 52);
  return Math.min(options.baseDelayMs * 2 ** exponent, options.maxDelayMs);
}

/**
 * Pure decision function: given the attempt number that just finished and its
 * result, say what to do with the event. No I/O and no clock, so every branch
 * is unit tested directly.
 */
export function decide(attempt: number, result: DeliveryResult, options: RetryPolicyOptions): Decision {
  let retryReason: string;
  let serverDelayMs: number | undefined;

  if (result.kind === 'response') {
    const { status } = result;
    if (status >= 200 && status < 300) {
      return { action: 'mark_delivered' };
    }
    if (!isRetryableStatus(status)) {
      // 3xx is included here: the relay does not follow redirects, because a
      // redirect on a POST webhook usually means the URL is misconfigured.
      return { action: 'fail', reason: `non-retryable HTTP ${status}` };
    }
    retryReason = `HTTP ${status}`;
    serverDelayMs = result.retryAfterMs;
  } else if (result.kind === 'timeout') {
    retryReason = 'timeout';
  } else {
    retryReason = `network error: ${result.message}`;
  }

  if (attempt >= options.maxAttempts) {
    return { action: 'fail', reason: `gave up after ${attempt} attempts (last: ${retryReason})` };
  }

  const computed = backoffDelay(attempt, options);
  // A Retry-After from the receiver wins when it asks us to wait longer, but it
  // is still capped so a bad header cannot park an event for days.
  const delayMs = Math.min(Math.max(computed, serverDelayMs ?? 0), options.maxDelayMs);
  return { action: 'retry', delayMs, reason: retryReason };
}

/**
 * Parse an HTTP Retry-After header (RFC 9110 section 10.2.3): either a number of
 * seconds or an HTTP date. Returns undefined for anything we cannot trust.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

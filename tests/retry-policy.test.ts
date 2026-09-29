import { describe, expect, it } from 'vitest';
import { backoffDelay, decide, isRetryableStatus, parseRetryAfter } from '../src/domain/retry-policy.js';

const policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 };

describe('isRetryableStatus', () => {
  it.each([500, 502, 503, 504, 408, 429])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 410, 422, 301, 302])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('doubles from the base delay', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, policy))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('never exceeds maxDelayMs, even for huge attempt numbers', () => {
    expect(backoffDelay(6, policy)).toBe(30_000);
    expect(backoffDelay(10_000, policy)).toBe(30_000);
  });

  it('rejects attempt numbers below 1', () => {
    expect(() => backoffDelay(0, policy)).toThrow(RangeError);
  });
});

describe('decide', () => {
  it('marks any 2xx as delivered', () => {
    expect(decide(1, { kind: 'response', status: 204 }, policy)).toEqual({ action: 'mark_delivered' });
  });

  it('fails immediately on a non-retryable 4xx, even on the first attempt', () => {
    expect(decide(1, { kind: 'response', status: 400 }, policy)).toEqual({
      action: 'fail',
      reason: 'non-retryable HTTP 400',
    });
  });

  it('does not follow or retry redirects', () => {
    expect(decide(1, { kind: 'response', status: 302 }, policy).action).toBe('fail');
  });

  it('retries 5xx, timeouts and network errors with backoff', () => {
    expect(decide(1, { kind: 'response', status: 503 }, policy)).toEqual({
      action: 'retry',
      delayMs: 1_000,
      reason: 'HTTP 503',
    });
    expect(decide(2, { kind: 'timeout' }, policy)).toEqual({ action: 'retry', delayMs: 2_000, reason: 'timeout' });
    expect(decide(3, { kind: 'network_error', message: 'ECONNREFUSED' }, policy)).toEqual({
      action: 'retry',
      delayMs: 4_000,
      reason: 'network error: ECONNREFUSED',
    });
  });

  it('gives up when the last allowed attempt fails', () => {
    expect(decide(5, { kind: 'response', status: 500 }, policy)).toEqual({
      action: 'fail',
      reason: 'gave up after 5 attempts (last: HTTP 500)',
    });
  });

  it('waits longer when Retry-After asks for more than the backoff', () => {
    const d = decide(1, { kind: 'response', status: 429, retryAfterMs: 20_000 }, policy);
    expect(d).toEqual({ action: 'retry', delayMs: 20_000, reason: 'HTTP 429' });
  });

  it('keeps the backoff when Retry-After is shorter', () => {
    const d = decide(3, { kind: 'response', status: 503, retryAfterMs: 500 }, policy);
    expect(d).toMatchObject({ delayMs: 4_000 });
  });

  it('caps an unreasonable Retry-After at maxDelayMs', () => {
    const d = decide(1, { kind: 'response', status: 503, retryAfterMs: 86_400_000 }, policy);
    expect(d).toMatchObject({ delayMs: 30_000 });
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('reads seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('reads an HTTP date relative to now', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('treats a date in the past as "retry now"', () => {
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0);
  });

  it.each([null, '', '  ', 'soon', '-5', '1.5'])('ignores %j', (value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});

import { parseRetryAfter } from '../domain/retry-policy.js';
import type { DeliveryResult, OutboxEvent } from '../domain/types.js';
import type { Clock } from '../clock.js';

export interface Deliverer {
  deliver(event: OutboxEvent): Promise<DeliveryResult>;
}

export interface HttpDelivererOptions {
  timeoutMs: number;
  clock: Clock;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POSTs the stored payload as JSON. The event key and attempt number are sent
 * as headers so the receiver can deduplicate: delivery is at-least-once, so the
 * same event can arrive more than once.
 */
export class HttpDeliverer implements Deliverer {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpDelivererOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async deliver(event: OutboxEvent): Promise<DeliveryResult> {
    try {
      const response = await this.fetchImpl(event.targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-outbox-event-key': event.eventKey,
          'x-outbox-attempt': String(event.attempts),
        },
        body: event.payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      // Drain the body so the connection is released; we do not use it.
      await response.arrayBuffer().catch(() => undefined);

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.options.clock.now());
      return retryAfterMs === undefined
        ? { kind: 'response', status: response.status }
        : { kind: 'response', status: response.status, retryAfterMs };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return { kind: 'timeout' };
      }
      return { kind: 'network_error', message: describeError(error) };
    }
  }
}

/** fetch wraps the real cause (ECONNREFUSED, ENOTFOUND...) in a generic TypeError. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: string }).code;
      return code ? `${code}: ${cause.message}` : cause.message;
    }
    return error.message;
  }
  return String(error);
}

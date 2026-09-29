import type { Clock } from './clock.js';
import type { Deliverer } from './delivery/http-deliverer.js';
import { decide, type RetryPolicyOptions } from './domain/retry-policy.js';
import type { Logger } from './logger.js';
import type { OutboxStore } from './store/outbox-store.js';

export interface RunSummary {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
}

export interface RunOptions {
  store: OutboxStore;
  deliverer: Deliverer;
  clock: Clock;
  policy: RetryPolicyOptions;
  logger: Logger;
  /** Stop after this many attempts in one run. */
  limit: number;
}

/**
 * Process due events one at a time until none are due or the limit is hit.
 * Sequential on purpose: to deliver in parallel, run several processes against
 * the same database; claimNext keeps them from taking the same event.
 */
export async function runOnce(options: RunOptions): Promise<RunSummary> {
  const { store, deliverer, clock, policy, logger, limit } = options;
  const summary: RunSummary = { attempted: 0, delivered: 0, retried: 0, failed: 0 };

  while (summary.attempted < limit) {
    const event = store.claimNext(clock.now());
    if (!event) break;
    summary.attempted += 1;

    const result = await deliverer.deliver(event);
    const decision = decide(event.attempts, result, policy);
    const statusCode = result.kind === 'response' ? result.status : null;
    const now = clock.now();

    const fields = { id: event.id, key: event.eventKey, attempt: event.attempts, status_code: statusCode };
    switch (decision.action) {
      case 'mark_delivered':
        store.markDelivered(event.id, statusCode ?? 0, now);
        summary.delivered += 1;
        logger.info('delivered', fields);
        break;
      case 'retry':
        store.scheduleRetry(event.id, now + decision.delayMs, decision.reason, statusCode, now);
        summary.retried += 1;
        logger.warn('retry_scheduled', { ...fields, reason: decision.reason, delay_ms: decision.delayMs });
        break;
      case 'fail':
        store.markFailed(event.id, decision.reason, statusCode, now);
        summary.failed += 1;
        logger.warn('failed', { ...fields, reason: decision.reason });
        break;
    }
  }
  return summary;
}

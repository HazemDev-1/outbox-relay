import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deliverer } from '../src/delivery/http-deliverer.js';
import type { DeliveryResult, OutboxEvent } from '../src/domain/types.js';
import { silentLogger } from '../src/logger.js';
import { runOnce } from '../src/relay.js';
import { OutboxStore } from '../src/store/outbox-store.js';
import { FakeClock, tempDbPath } from './helpers.js';

const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 };

/** Returns scripted results in order and records what it was asked to deliver. */
class ScriptedDeliverer implements Deliverer {
  calls: OutboxEvent[] = [];
  constructor(private readonly results: DeliveryResult[]) {}
  async deliver(event: OutboxEvent): Promise<DeliveryResult> {
    this.calls.push(event);
    const next = this.results.shift();
    if (!next) throw new Error('deliverer called more times than scripted');
    return next;
  }
}

describe('runOnce', () => {
  let db: ReturnType<typeof tempDbPath>;
  let store: OutboxStore;
  let clock: FakeClock;

  beforeEach(() => {
    db = tempDbPath();
    store = new OutboxStore(db.path);
    clock = new FakeClock();
  });
  afterEach(() => {
    store.close();
    db.cleanup();
  });

  const run = (deliverer: Deliverer, limit = 100) =>
    runOnce({ store, deliverer, clock, policy, logger: silentLogger, limit });

  it('does nothing on an empty outbox', async () => {
    expect(await run(new ScriptedDeliverer([]))).toEqual({ attempted: 0, delivered: 0, retried: 0, failed: 0 });
  });

  it('retries with backoff until the receiver recovers', async () => {
    const { id } = store.enqueue({ eventKey: 'k', targetUrl: 'http://x.test', payload: '{}' }, clock.now());
    const deliverer = new ScriptedDeliverer([
      { kind: 'response', status: 503 },
      { kind: 'timeout' },
      { kind: 'response', status: 200 },
    ]);

    expect(await run(deliverer)).toMatchObject({ attempted: 1, retried: 1 });
    // Not due yet: a second run in the same instant must not retry early.
    expect(await run(deliverer)).toMatchObject({ attempted: 0 });

    clock.advance(1_000);
    expect(await run(deliverer)).toMatchObject({ attempted: 1, retried: 1 });

    clock.advance(1_999);
    expect(await run(deliverer)).toMatchObject({ attempted: 0 });
    clock.advance(1);
    expect(await run(deliverer)).toMatchObject({ attempted: 1, delivered: 1 });

    expect(store.get(id)).toMatchObject({ status: 'delivered', attempts: 3, lastError: null });
    expect(deliverer.calls.map((e) => e.attempts)).toEqual([1, 2, 3]);
  });

  it('fails permanently after maxAttempts and records the last reason', async () => {
    const { id } = store.enqueue({ eventKey: 'k', targetUrl: 'http://x.test', payload: '{}' }, clock.now());
    const deliverer = new ScriptedDeliverer(Array(3).fill({ kind: 'response', status: 500 }));
    for (let i = 0; i < 3; i++) {
      await run(deliverer);
      clock.advance(60_000);
    }
    expect(store.get(id)).toMatchObject({ status: 'failed', attempts: 3, lastStatusCode: 500 });
    expect(store.get(id)?.lastError).toContain('gave up after 3 attempts');
    expect(await run(deliverer)).toMatchObject({ attempted: 0 });
  });

  it('keeps going after one event fails and respects the limit', async () => {
    for (const key of ['a', 'b', 'c']) {
      store.enqueue({ eventKey: key, targetUrl: 'http://x.test', payload: '{}' }, clock.now());
    }
    const deliverer = new ScriptedDeliverer([
      { kind: 'response', status: 404 },
      { kind: 'response', status: 200 },
    ]);
    expect(await run(deliverer, 2)).toEqual({ attempted: 2, delivered: 1, retried: 0, failed: 1 });
    expect(store.counts()).toEqual({ pending: 1, in_flight: 0, delivered: 1, failed: 1 });
  });
});

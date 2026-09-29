import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventKeyConflictError } from '../src/errors.js';
import { OutboxStore } from '../src/store/outbox-store.js';
import { tempDbPath } from './helpers.js';

const T0 = 1_700_000_000_000;
const event = (key: string) => ({ eventKey: key, targetUrl: 'http://receiver.test/hook', payload: `{"key":"${key}"}` });

describe('OutboxStore (real SQLite file)', () => {
  let db: ReturnType<typeof tempDbPath>;
  let store: OutboxStore;

  beforeEach(() => {
    db = tempDbPath();
    store = new OutboxStore(db.path);
  });
  afterEach(() => {
    store.close();
    db.cleanup();
  });

  describe('enqueue', () => {
    it('stores a new event as pending and due now', () => {
      const { id, created } = store.enqueue(event('a'), T0);
      expect(created).toBe(true);
      expect(store.get(id)).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: T0 });
    });

    it('is idempotent: the same event twice keeps one row', () => {
      const first = store.enqueue(event('a'), T0);
      const second = store.enqueue(event('a'), T0 + 5);
      expect(second).toEqual({ id: first.id, created: false });
      expect(store.counts().pending).toBe(1);
    });

    it('rejects the same key with a different payload', () => {
      store.enqueue(event('a'), T0);
      expect(() => store.enqueue({ ...event('a'), payload: '{"changed":true}' }, T0)).toThrow(EventKeyConflictError);
    });
  });

  describe('claimNext', () => {
    it('returns nothing when nothing is due', () => {
      store.enqueue(event('a'), T0);
      expect(store.claimNext(T0 - 1)).toBeUndefined();
    });

    it('claims the oldest due event, marks it in flight and counts the attempt', () => {
      store.enqueue(event('a'), T0);
      store.enqueue(event('b'), T0 + 1);
      const claimed = store.claimNext(T0 + 10);
      expect(claimed).toMatchObject({ eventKey: 'a', status: 'in_flight', attempts: 1 });
    });

    it('never hands the same event to two connections', () => {
      // Two independent connections to one file, like two worker processes.
      const other = new OutboxStore(db.path);
      try {
        for (let i = 0; i < 20; i++) store.enqueue(event(`e${i}`), T0);
        const seen: number[] = [];
        for (let i = 0; i < 20; i++) {
          const conn = i % 2 === 0 ? store : other;
          const claimed = conn.claimNext(T0);
          expect(claimed).toBeDefined();
          seen.push(claimed!.id);
        }
        expect(new Set(seen).size).toBe(20);
        expect(store.claimNext(T0)).toBeUndefined();
        expect(other.claimNext(T0)).toBeUndefined();
      } finally {
        other.close();
      }
    });
  });

  describe('state transitions', () => {
    it('schedules a retry: back to pending, not due until the given time', () => {
      const { id } = store.enqueue(event('a'), T0);
      store.claimNext(T0);
      store.scheduleRetry(id, T0 + 5_000, 'HTTP 503', 503, T0);
      expect(store.get(id)).toMatchObject({ status: 'pending', lastError: 'HTTP 503', lastStatusCode: 503 });
      expect(store.claimNext(T0 + 4_999)).toBeUndefined();
      expect(store.claimNext(T0 + 5_000)?.id).toBe(id);
    });

    it('refuses to finish an event that is not in flight', () => {
      const { id } = store.enqueue(event('a'), T0);
      expect(() => store.markDelivered(id, 200, T0)).toThrow(/not in flight/);
    });

    it('refuses to finish the same event twice', () => {
      const { id } = store.enqueue(event('a'), T0);
      store.claimNext(T0);
      store.markDelivered(id, 200, T0);
      expect(() => store.markFailed(id, 'late result', 500, T0)).toThrow(/not in flight/);
      expect(store.get(id)?.status).toBe('delivered');
    });

    it('keeps data after reopening the file', () => {
      const { id } = store.enqueue(event('a'), T0);
      store.close();
      store = new OutboxStore(db.path);
      expect(store.get(id)?.eventKey).toBe('a');
    });
  });
});

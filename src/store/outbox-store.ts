import { DatabaseSync } from 'node:sqlite';
import { EventKeyConflictError } from '../errors.js';
import type { EventStatus, OutboxEvent } from '../domain/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key        TEXT    NOT NULL UNIQUE,
  target_url       TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('pending', 'in_flight', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  last_status_code INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_due ON events (status, next_attempt_at);
`;

interface EventRow {
  id: number;
  event_key: string;
  target_url: string;
  payload: string;
  status: EventStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  last_status_code: number | null;
  created_at: number;
  updated_at: number;
}

function toEvent(row: EventRow): OutboxEvent {
  return {
    id: row.id,
    eventKey: row.event_key,
    targetUrl: row.target_url,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    lastStatusCode: row.last_status_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewEvent {
  eventKey: string;
  targetUrl: string;
  payload: string;
}

export interface EnqueueResult {
  id: number;
  /** false when an identical event with the same key already existed. */
  created: boolean;
}

export type StatusCounts = Record<EventStatus, number>;

/**
 * All SQL lives here. Every state change is a single statement, so each one is
 * atomic without explicit transactions, and several worker processes can share
 * one database file.
 */
export class OutboxStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL lets readers continue while a worker writes; busy_timeout makes a
    // second process wait for the write lock instead of failing immediately.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Idempotent on eventKey: enqueuing the same event twice is a no-op, which is
   * what a producer retrying after a timeout needs. Reusing a key for a
   * different event is a bug in the producer and is rejected.
   */
  enqueue(event: NewEvent, now: number): EnqueueResult {
    const inserted = this.db
      .prepare(
        `INSERT INTO events (event_key, target_url, payload, status, next_attempt_at, created_at, updated_at)
         VALUES (:key, :url, :payload, 'pending', :now, :now, :now)
         ON CONFLICT (event_key) DO NOTHING
         RETURNING id`,
      )
      .get({ key: event.eventKey, url: event.targetUrl, payload: event.payload, now }) as { id: number } | undefined;

    if (inserted) return { id: inserted.id, created: true };

    const existing = this.db
      .prepare('SELECT id, target_url, payload FROM events WHERE event_key = :key')
      .get({ key: event.eventKey }) as { id: number; target_url: string; payload: string };

    if (existing.target_url !== event.targetUrl || existing.payload !== event.payload) {
      throw new EventKeyConflictError(event.eventKey);
    }
    return { id: existing.id, created: false };
  }

  /**
   * Atomically take the oldest due event and mark it in flight. The subquery
   * and the update run as one statement under SQLite's write lock, so two
   * workers can never claim the same row.
   */
  claimNext(now: number): OutboxEvent | undefined {
    const row = this.db
      .prepare(
        `UPDATE events
            SET status = 'in_flight', attempts = attempts + 1, updated_at = :now
          WHERE status = 'pending'
            AND id = (SELECT id FROM events
                       WHERE status = 'pending' AND next_attempt_at <= :now
                       ORDER BY next_attempt_at, id
                       LIMIT 1)
          RETURNING *`,
      )
      .get({ now }) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  markDelivered(id: number, statusCode: number, now: number): void {
    this.transition(id, 'delivered', {
      now,
      statusCode,
      error: null,
      nextAttemptAt: null,
    });
  }

  scheduleRetry(id: number, nextAttemptAt: number, reason: string, statusCode: number | null, now: number): void {
    this.transition(id, 'pending', { now, statusCode, error: reason, nextAttemptAt });
  }

  markFailed(id: number, reason: string, statusCode: number | null, now: number): void {
    this.transition(id, 'failed', { now, statusCode, error: reason, nextAttemptAt: null });
  }

  get(id: number): OutboxEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id = :id').get({ id }) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  counts(): StatusCounts {
    const counts: StatusCounts = { pending: 0, in_flight: 0, delivered: 0, failed: 0 };
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status').all() as {
      status: EventStatus;
      n: number;
    }[];
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /**
   * Only an in-flight event may leave the in_flight state. If the row is not in
   * flight (for example it was already finished), throw instead of silently
   * overwriting another worker's result.
   */
  private transition(
    id: number,
    to: EventStatus,
    fields: { now: number; statusCode: number | null; error: string | null; nextAttemptAt: number | null },
  ): void {
    const result = this.db
      .prepare(
        `UPDATE events
            SET status = :to,
                last_status_code = :statusCode,
                last_error = :error,
                next_attempt_at = COALESCE(:nextAttemptAt, next_attempt_at),
                updated_at = :now
          WHERE id = :id AND status = 'in_flight'`,
      )
      .run({ id, to, ...fields });
    if (result.changes !== 1) {
      throw new Error(`event ${id} is not in flight; refusing to move it to ${to}`);
    }
  }
}

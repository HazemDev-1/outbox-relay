export type EventStatus = 'pending' | 'in_flight' | 'delivered' | 'failed';

export interface OutboxEvent {
  id: number;
  eventKey: string;
  targetUrl: string;
  payload: string;
  status: EventStatus;
  /** Number of delivery attempts started so far, including the current one while in flight. */
  attempts: number;
  /** Epoch milliseconds; the event is not picked up before this time. */
  nextAttemptAt: number;
  lastError: string | null;
  lastStatusCode: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What happened when we tried to POST the event. */
export type DeliveryResult =
  | { kind: 'response'; status: number; retryAfterMs?: number }
  | { kind: 'timeout' }
  | { kind: 'network_error'; message: string };

/** What the relay should do next with an event after a delivery attempt. */
export type Decision =
  | { action: 'mark_delivered' }
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'fail'; reason: string };

# outbox-relay

A small command-line worker that delivers events from a SQLite outbox table to HTTP endpoints, retrying failures with exponential backoff.

It is a learning and portfolio project, not production software. It is kept small enough to read in one sitting.

## The problem

A service records an event (for example `order.paid`) in its own database and must notify another system over HTTP.
Calling the receiver inline is fragile: it can be down, slow, or return an error, and the process can crash between
"saved" and "sent". The transactional outbox pattern stores the event first and lets a separate worker deliver it.
This project is that worker.

## Usage

Requires Node.js 22.13 or newer (for the built-in `node:sqlite` module).

```bash
npm ci && npm run build

node dist/cli.js enqueue --db outbox.db --key order-42.paid \
  --url https://receiver.example/hooks --payload '{"order":42,"status":"paid"}'

node dist/cli.js run --db outbox.db --once      # deliver everything that is due, then exit
node dist/cli.js status --db outbox.db          # {"pending":0,"in_flight":0,"delivered":1,"failed":0}
```

`run --once` is meant to be called on a schedule (cron, a CI job, a systemd timer). Options: `--limit`, `--timeout-ms`,
`--max-attempts`, `--base-delay-ms`, `--max-delay-ms`.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error (bug or environment problem) |
| 2 | Invalid input or configuration; nothing was changed |
| 3 | `run` finished, but at least one event was permanently failed in this run |

Command results are printed to stdout as one JSON object. Per-event logs are JSON lines on stderr.
Node prints an `ExperimentalWarning` for `node:sqlite` on stderr; set `NODE_NO_WARNINGS=1` to hide it.

## How it decides

| Receiver result | Action |
| --- | --- |
| 2xx | delivered |
| 408, 429, 5xx | retry |
| timeout, connection error | retry |
| other 4xx | failed immediately (the request itself is wrong; retrying cannot fix it) |
| 3xx | failed immediately (redirects are not followed; on a webhook they usually mean a wrong URL) |

Retries wait `base * 2^(attempt-1)`, capped at `--max-delay-ms`. A `Retry-After` header (seconds or IMF-fixdate) is
honoured when it asks for a longer wait, and is also capped. After `--max-attempts` the event is marked failed.

## Design

```
src/
  domain/retry-policy.ts   pure decision logic: no I/O, no clock
  store/outbox-store.ts    all SQL; every state change is one statement
  delivery/http-deliverer.ts
  relay.ts                 claim -> deliver -> decide -> persist, one event at a time
  main.ts / cli.ts         argument parsing, validation, exit codes
```

- **Atomic claim.** `claimNext` is a single `UPDATE ... WHERE id = (SELECT ...) RETURNING *`. SQLite runs it under one
  write lock, so two workers cannot take the same row. An integration test runs three worker processes against one
  file and checks every event is delivered exactly once when nothing fails. Replacing the claim with a separate
  SELECT and UPDATE makes that test fail.
- **Guarded transitions.** An event can only leave `in_flight` once. A late or duplicate result throws instead of
  overwriting another worker's outcome.
- **Idempotent enqueue.** Enqueuing the same `event_key` twice is a no-op, so a producer can safely retry. Reusing a key
  for a different payload is rejected.
- **Injected clock and deliverer.** Retry timing is tested by moving a fake clock, not by sleeping.
- **Real dependencies in tests.** Store and integration tests use real SQLite files, a real local HTTP server, and the
  real CLI in child processes.

## Guarantees and limitations

- **At-least-once, not exactly-once.** If the receiver processes the request but the response is lost (timeout,
  crash), the event is sent again. Receivers must deduplicate using the `x-outbox-event-key` header.
- **A worker crash leaves an event stuck `in_flight`.** v1 has no lease expiry, so such an event is never retried.
  Tracked as a follow-up issue.
- **Failed events stay failed.** There is no command to requeue them yet.
- **No jitter.** Many events failing at the same moment are retried at the same moment.
- **Delivery order is not guaranteed** across retries or across several workers.
- **SQLite only**, one machine. Several processes on one file work; a network filesystem is not supported.
- **No request signing** (for example HMAC). Receivers cannot verify the sender.

## Development

```bash
make check    # lint + typecheck + tests
```

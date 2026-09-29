# outbox-relay

A small command-line worker that delivers events from a SQLite outbox table to HTTP endpoints, with retries.

**Status:** early development. Nothing is implemented on `main` yet; work is tracked in the issues.

## The problem

A service records an event (for example `order.paid`) in its own database and must notify another system over HTTP.
Doing the HTTP call inline is fragile: the receiver can be down, slow, or return an error, and the process can crash
between "saved" and "sent". The transactional outbox pattern stores the event first and lets a separate worker
deliver it. This project is that worker, kept small enough to read in one sitting.

Failure modes it has to handle:

- receiver down, timing out, or returning 5xx
- receiver rejecting the request (4xx) where retrying cannot help
- two workers picking up the same event
- a worker crashing after it picked an event up
- an event that will never succeed being retried forever

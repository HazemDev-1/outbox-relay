import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutboxStore } from '../../src/store/outbox-store.js';
import { runCli, startServer, tempDbPath, type TestServer } from '../helpers.js';

describe('several worker processes on one database', () => {
  let db: ReturnType<typeof tempDbPath>;
  let server: TestServer;

  beforeEach(async () => {
    db = tempDbPath();
    // A little latency so the workers really overlap in time.
    server = await startServer((_req, res) => setTimeout(() => res.writeHead(200).end(), 5));
  });
  afterEach(async () => {
    await server.close();
    db.cleanup();
  });

  it('delivers every event exactly once when nothing fails', async () => {
    const EVENTS = 40;
    const store = new OutboxStore(db.path);
    for (let i = 0; i < EVENTS; i++) {
      store.enqueue({ eventKey: `evt-${i}`, targetUrl: server.url, payload: `{"i":${i}}` }, Date.now());
    }
    store.close();

    const results = await Promise.all(
      [1, 2, 3].map(() => runCli(['run', '--db', db.path, '--once', '--limit', String(EVENTS)])),
    );

    for (const r of results) expect(r.code, r.stderr).toBe(0);
    const totals = results.map((r) => JSON.parse(r.stdout) as { delivered: number });
    expect(totals.reduce((sum, t) => sum + t.delivered, 0)).toBe(EVENTS);

    const keys = server.requests.map((r) => r.headers['x-outbox-event-key']);
    expect(keys).toHaveLength(EVENTS);
    expect(new Set(keys).size).toBe(EVENTS);

    const check = new OutboxStore(db.path);
    expect(check.counts()).toEqual({ pending: 0, in_flight: 0, delivered: EVENTS, failed: 0 });
    check.close();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpDeliverer } from '../../src/delivery/http-deliverer.js';
import { silentLogger } from '../../src/logger.js';
import { runOnce } from '../../src/relay.js';
import { OutboxStore } from '../../src/store/outbox-store.js';
import { FakeClock, startServer, tempDbPath, type TestServer } from '../helpers.js';

const policy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 60_000 };

describe('delivery over real HTTP', () => {
  let db: ReturnType<typeof tempDbPath>;
  let store: OutboxStore;
  let clock: FakeClock;
  let server: TestServer | undefined;

  beforeEach(() => {
    db = tempDbPath();
    store = new OutboxStore(db.path);
    clock = new FakeClock();
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    store.close();
    db.cleanup();
  });

  const run = (timeoutMs = 2_000) =>
    runOnce({
      store,
      deliverer: new HttpDeliverer({ timeoutMs, clock }),
      clock,
      policy,
      logger: silentLogger,
      limit: 10,
    });

  it('sends the payload and dedupe headers, and recovers after two 503s', async () => {
    server = await startServer((_req, res, i) => {
      res.writeHead(i < 2 ? 503 : 204).end();
    });
    const { id } = store.enqueue({ eventKey: 'order-42.paid', targetUrl: `${server.url}/hooks`, payload: '{"order":42}' }, clock.now());

    await run();
    clock.advance(1_000);
    await run();
    clock.advance(2_000);
    await run();

    expect(store.get(id)).toMatchObject({ status: 'delivered', attempts: 3, lastStatusCode: 204 });
    expect(server.requests).toHaveLength(3);
    const last = server.requests[2]!;
    expect(last.path).toBe('/hooks');
    expect(last.body).toBe('{"order":42}');
    expect(last.headers['content-type']).toBe('application/json');
    expect(last.headers['x-outbox-event-key']).toBe('order-42.paid');
    expect(server.requests.map((r) => r.headers['x-outbox-attempt'])).toEqual(['1', '2', '3']);
  });

  it('honours Retry-After from a 429', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '30' }).end();
    });
    const { id } = store.enqueue({ eventKey: 'k', targetUrl: server.url, payload: '{}' }, clock.now());
    await run();
    expect(store.get(id)?.nextAttemptAt).toBe(clock.now() + 30_000);
  });

  it('fails immediately on 400 without retrying', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(400).end('bad signature');
    });
    const { id } = store.enqueue({ eventKey: 'k', targetUrl: server.url, payload: '{}' }, clock.now());
    expect(await run()).toMatchObject({ failed: 1 });
    expect(store.get(id)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'non-retryable HTTP 400' });
  });

  it('does not follow a redirect', async () => {
    server = await startServer((req, res) => {
      if (req.path === '/moved') res.writeHead(200).end();
      else res.writeHead(302, { location: '/moved' }).end();
    });
    const { id } = store.enqueue({ eventKey: 'k', targetUrl: server.url, payload: '{}' }, clock.now());
    await run();
    expect(store.get(id)?.status).toBe('failed');
    expect(server.requests.map((r) => r.path)).toEqual(['/']);
  });

  it('treats a slow receiver as a timeout and schedules a retry', async () => {
    server = await startServer((_req, res) => {
      setTimeout(() => res.writeHead(200).end(), 1_000);
    });
    const { id } = store.enqueue({ eventKey: 'k', targetUrl: server.url, payload: '{}' }, clock.now());
    expect(await run(100)).toMatchObject({ retried: 1 });
    expect(store.get(id)).toMatchObject({ status: 'pending', lastError: 'timeout', lastStatusCode: null });
  });

  it('treats a refused connection as a network error and schedules a retry', async () => {
    // Start and stop a server to get a port that is very likely closed.
    const temp = await startServer((_req, res) => res.end());
    const closedUrl = temp.url;
    await temp.close();

    const { id } = store.enqueue({ eventKey: 'k', targetUrl: closedUrl, payload: '{}' }, clock.now());
    expect(await run()).toMatchObject({ retried: 1 });
    expect(store.get(id)?.lastError).toMatch(/^network error: ECONNREFUSED/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, startServer, tempDbPath, type TestServer } from '../helpers.js';

describe('CLI (separate process)', () => {
  let db: ReturnType<typeof tempDbPath>;
  let server: TestServer | undefined;

  beforeEach(() => {
    db = tempDbPath();
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    db.cleanup();
  });

  it('enqueues, delivers and reports status as JSON', async () => {
    server = await startServer((_req, res) => res.writeHead(200).end());

    const enq = await runCli(['enqueue', '--db', db.path, '--key', 'evt-1', '--url', server.url, '--payload', '{"a":1}']);
    expect(enq.code).toBe(0);
    expect(JSON.parse(enq.stdout)).toEqual({ id: 1, created: true });

    const again = await runCli(['enqueue', '--db', db.path, '--key', 'evt-1', '--url', server.url, '--payload', '{"a":1}']);
    expect(JSON.parse(again.stdout)).toEqual({ id: 1, created: false });

    const run = await runCli(['run', '--db', db.path, '--once']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ attempted: 1, delivered: 1, retried: 0, failed: 0 });
    // Structured logs go to stderr, one JSON object per line.
    const logs = run.stderr.trim().split('\n').map((l) => JSON.parse(l));
    expect(logs).toContainEqual(expect.objectContaining({ level: 'info', event: 'delivered', key: 'evt-1' }));

    const status = await runCli(['status', '--db', db.path]);
    expect(JSON.parse(status.stdout)).toEqual({ pending: 0, in_flight: 0, delivered: 1, failed: 0 });
  });

  it('exits 3 when an event is permanently failed, so CI or cron can alert', async () => {
    server = await startServer((_req, res) => res.writeHead(410).end());
    await runCli(['enqueue', '--db', db.path, '--key', 'gone', '--url', server.url, '--payload', '{}']);
    const run = await runCli(['run', '--db', db.path, '--once']);
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ failed: 1 });
  });

  it.each([
    [['enqueue', '--db', 'x.db', '--key', 'k', '--url', 'ftp://x', '--payload', '{}'], /http or https/],
    [['enqueue', '--db', 'x.db', '--key', 'k', '--url', 'http://x.test', '--payload', 'nope'], /valid JSON/],
    [['run', '--db', 'x.db'], /requires --once/],
    [['run', '--db', 'x.db', '--once', '--limit', '0'], /--limit must be a positive integer/],
    [['run', '--db', 'x.db', '--once', '--base-delay-ms', '9', '--max-delay-ms', '5'], /must not be greater/],
    [['status'], /--db is required/],
    [['frobnicate', '--db', 'x.db'], /unknown command/],
    [['status', '--db', 'x.db', '--nope'], /Unknown option/],
  ])('exits 2 with a clear message for bad input %#', async (args, message) => {
    const result = await runCli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).toBe('');
  });

  it('exits 2 when an event key is reused for a different payload', async () => {
    await runCli(['enqueue', '--db', db.path, '--key', 'k', '--url', 'http://x.test', '--payload', '{"v":1}']);
    const result = await runCli(['enqueue', '--db', db.path, '--key', 'k', '--url', 'http://x.test', '--payload', '{"v":2}']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/already exists with a different/);
  });
});

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** A real SQLite file in a fresh temp directory, removed by cleanup(). */
export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-relay-'));
  return { path: join(dir, 'outbox.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export class FakeClock {
  constructor(public current = 1_700_000_000_000) {}
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface ReceivedRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface TestServer {
  url: string;
  requests: ReceivedRequest[];
  close: () => Promise<void>;
}

/** A real HTTP server on a random local port. The handler decides each response. */
export async function startServer(
  handler: (req: ReceivedRequest, res: ServerResponse, index: number) => void,
): Promise<TestServer> {
  const requests: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const received = { path: req.url ?? '/', headers: req.headers, body };
      requests.push(received);
      handler(received, res, requests.length - 1);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const ROOT = resolve(import.meta.dirname, '..');

/** Runs the real CLI entry point in a separate Node process. */
export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

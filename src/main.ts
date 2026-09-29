import { parseArgs } from 'node:util';
import { systemClock, type Clock } from './clock.js';
import { parseJsonPayload, parsePositiveInt, parseTargetUrl, requireOption } from './config.js';
import { HttpDeliverer, type Deliverer } from './delivery/http-deliverer.js';
import { DEFAULT_RETRY_POLICY } from './domain/retry-policy.js';
import { EventKeyConflictError, UsageError } from './errors.js';
import { jsonLogger, type Logger } from './logger.js';
import { runOnce } from './relay.js';
import { OutboxStore } from './store/outbox-store.js';

export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  /** `run` finished, but at least one event was permanently failed during it. */
  EVENTS_FAILED: 3,
} as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  clock?: Clock;
  logger?: Logger;
  deliverer?: Deliverer;
}

const USAGE = `Usage:
  outbox-relay enqueue --db <file> --key <event-key> --url <http(s) url> --payload <json>
  outbox-relay run     --db <file> --once [--limit N] [--timeout-ms N] [--max-attempts N]
                       [--base-delay-ms N] [--max-delay-ms N]
  outbox-relay status  --db <file>

Exit codes: 0 ok, 1 unexpected error, 2 usage/config error, 3 run permanently failed an event.
`;

const OPTIONS = {
  db: { type: 'string' },
  key: { type: 'string' },
  url: { type: 'string' },
  payload: { type: 'string' },
  once: { type: 'boolean' },
  limit: { type: 'string' },
  'timeout-ms': { type: 'string' },
  'max-attempts': { type: 'string' },
  'base-delay-ms': { type: 'string' },
  'max-delay-ms': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof UsageError || error instanceof EventKeyConflictError) {
      io.stderr(`error: ${error.message}\n`);
      return EXIT.USAGE;
    }
    io.stderr(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.UNEXPECTED;
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || command === undefined) {
    io.stdout(USAGE);
    return command === undefined && !values.help ? EXIT.USAGE : EXIT.OK;
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1]}"`);

  const clock = io.clock ?? systemClock;
  const dbPath = requireOption('db', values.db);

  switch (command) {
    case 'enqueue': {
      const key = requireOption('key', values.key);
      const targetUrl = parseTargetUrl(values.url);
      const payload = parseJsonPayload(values.payload);
      const store = new OutboxStore(dbPath);
      try {
        const result = store.enqueue({ eventKey: key, targetUrl, payload }, clock.now());
        io.stdout(`${JSON.stringify(result)}\n`);
      } finally {
        store.close();
      }
      return EXIT.OK;
    }

    case 'run': {
      if (!values.once) {
        throw new UsageError('run currently requires --once (continuous polling is not implemented yet)');
      }
      // Validate everything before opening the database or touching the network.
      const limit = parsePositiveInt('limit', values.limit, 100);
      const timeoutMs = parsePositiveInt('timeout-ms', values['timeout-ms'], 10_000);
      const policy = {
        maxAttempts: parsePositiveInt('max-attempts', values['max-attempts'], DEFAULT_RETRY_POLICY.maxAttempts),
        baseDelayMs: parsePositiveInt('base-delay-ms', values['base-delay-ms'], DEFAULT_RETRY_POLICY.baseDelayMs),
        maxDelayMs: parsePositiveInt('max-delay-ms', values['max-delay-ms'], DEFAULT_RETRY_POLICY.maxDelayMs),
      };
      if (policy.baseDelayMs > policy.maxDelayMs) {
        throw new UsageError('--base-delay-ms must not be greater than --max-delay-ms');
      }

      const store = new OutboxStore(dbPath);
      try {
        const summary = await runOnce({
          store,
          deliverer: io.deliverer ?? new HttpDeliverer({ timeoutMs, clock }),
          clock,
          policy,
          logger: io.logger ?? jsonLogger(),
          limit,
        });
        io.stdout(`${JSON.stringify(summary)}\n`);
        return summary.failed > 0 ? EXIT.EVENTS_FAILED : EXIT.OK;
      } finally {
        store.close();
      }
    }

    case 'status': {
      const store = new OutboxStore(dbPath);
      try {
        io.stdout(`${JSON.stringify(store.counts())}\n`);
      } finally {
        store.close();
      }
      return EXIT.OK;
    }

    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

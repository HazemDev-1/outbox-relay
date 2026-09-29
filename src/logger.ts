export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

/** One JSON object per line on stderr, so stdout stays clean for command output. */
export function jsonLogger(write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  const log = (level: string) => (event: string, fields: LogFields = {}) =>
    write(`${JSON.stringify({ level, event, ...fields })}\n`);
  return { info: log('info'), warn: log('warn') };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };

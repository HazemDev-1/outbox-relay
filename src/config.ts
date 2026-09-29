import { UsageError } from './errors.js';

export function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function parseTargetUrl(raw: string | undefined): string {
  if (!raw) throw new UsageError('--url is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--url is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`--url must use http or https, got "${url.protocol}"`);
  }
  return url.toString();
}

/** The payload is stored as-is, but must be JSON because it is sent as application/json. */
export function parseJsonPayload(raw: string | undefined): string {
  if (raw === undefined) throw new UsageError('--payload is required');
  try {
    JSON.parse(raw);
  } catch {
    throw new UsageError('--payload must be valid JSON');
  }
  return raw;
}

export function requireOption(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new UsageError(`--${name} is required`);
  return value;
}

import { describe, expect, it } from 'vitest';
import { parseJsonPayload, parsePositiveInt, parseTargetUrl } from '../src/config.js';
import { UsageError } from '../src/errors.js';

describe('parsePositiveInt', () => {
  it('uses the fallback when the option is missing', () => {
    expect(parsePositiveInt('limit', undefined, 100)).toBe(100);
  });

  it.each(['0', '-1', '1.5', 'abc', '', '99999999999999999999'])('rejects %j', (raw) => {
    expect(() => parsePositiveInt('limit', raw, 1)).toThrow(UsageError);
  });
});

describe('parseTargetUrl', () => {
  it('accepts http and https', () => {
    expect(parseTargetUrl('https://example.test/hooks')).toBe('https://example.test/hooks');
  });

  it.each(['ftp://example.test', 'file:///etc/passwd', 'not a url'])('rejects %j', (raw) => {
    expect(() => parseTargetUrl(raw)).toThrow(UsageError);
  });
});

describe('parseJsonPayload', () => {
  it('keeps the payload text unchanged', () => {
    expect(parseJsonPayload('{"a": 1}')).toBe('{"a": 1}');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseJsonPayload('{a: 1}')).toThrow(UsageError);
  });
});

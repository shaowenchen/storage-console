import { describe, expect, it } from 'vitest';
import { maxQueuedUploadsFromEnv } from './upload.js';

describe('maxQueuedUploadsFromEnv', () => {
  it('treats an explicit 0 as "never wait", not as unset', () => {
    // This is the setting that makes the server refuse rather than queue. Losing
    // it to a falsy-check falls back to the default and silently restores the
    // waiting room, which is the bug this parser exists to avoid.
    expect(maxQueuedUploadsFromEnv('0')).toBe(0);
  });

  it('reads a positive count', () => {
    expect(maxQueuedUploadsFromEnv('8')).toBe(8);
    expect(maxQueuedUploadsFromEnv(' 12 ')).toBe(12);
  });

  it('addresses fractions rather than accepting them', () => {
    expect(maxQueuedUploadsFromEnv('3.7')).toBe(3);
  });

  it('falls back when the value is absent or unusable', () => {
    for (const raw of [undefined, '', '   ', 'many', '-1', '-0.5']) {
      expect(maxQueuedUploadsFromEnv(raw)).toBe(16);
    }
  });

  it('accepts an explicit 0 with different spacing', () => {
    expect(maxQueuedUploadsFromEnv(' 0 ')).toBe(0);
  });
});

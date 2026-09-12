import { describe, expect, it } from 'vitest';
import { backoffMs, isRetryableStatus, sleep } from './retry';

describe('isRetryableStatus', () => {
  it('trusts the server flag over the status class', () => {
    // A storage-side 502 is worth retrying; the server says so.
    expect(isRetryableStatus(502, true)).toBe(true);
    // A 400 that the server has marked permanent stays permanent, even though
    // 4xx would already be non-retryable — the flag is what is being tested.
    expect(isRetryableStatus(400, false)).toBe(false);
    // The interesting case: the server can retract a 5xx.
    expect(isRetryableStatus(503, false)).toBe(false);
    // ...and allow a retry on a status the class would refuse.
    expect(isRetryableStatus(409, true)).toBe(true);
  });

  it('falls back to the status class when no flag is present', () => {
    // An older server, or a proxy's own error page, carries no flag.
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('treats client errors as permanent', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });

  it('ignores a non-boolean flag rather than coercing it', () => {
    expect(isRetryableStatus(503, 'true')).toBe(true);
    expect(isRetryableStatus(400, undefined)).toBe(false);
    expect(isRetryableStatus(400, null)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('honours Retry-After over the computed schedule', () => {
    expect(backoffMs(0, '1')).toBe(1000);
    expect(backoffMs(9, '2')).toBe(2000);
  });

  it('caps Retry-After so a hostile value cannot park the upload', () => {
    expect(backoffMs(0, '600')).toBe(30_000);
  });

  it('ignores absent, zero and unparseable hints', () => {
    for (const hint of [null, undefined, '', '0', '-5', 'soon']) {
      const value = backoffMs(0, hint as string | null | undefined);
      expect(value).toBeGreaterThanOrEqual(500);
      expect(value).toBeLessThanOrEqual(1000);
    }
  });

  it('grows the window with each attempt, and jitters inside it', () => {
    // Attempt 0 → base 1000, so the value lands in [500, 1000].
    for (let i = 0; i < 20; i++) {
      const v = backoffMs(0);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
    // Attempt 3 → base 8000, jittered into [4000, 8000].
    for (let i = 0; i < 20; i++) {
      const v = backoffMs(3);
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThanOrEqual(8000);
    }
  });

  it('stops growing at the cap', () => {
    for (let i = 0; i < 20; i++) {
      const v = backoffMs(20);
      expect(v).toBeGreaterThanOrEqual(15_000);
      expect(v).toBeLessThanOrEqual(30_000);
    }
  });

  it('spreads a herd instead of retrying in lockstep', () => {
    // Ten in-flight uploads failing together must not all pick the same delay,
    // or they reproduce the overload they are backing off from.
    const values = new Set(Array.from({ length: 50 }, () => backoffMs(2)));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(10_000, controller.signal)).rejects.toThrow('Upload cancelled');
  });

  it('wakes early on abort rather than waiting out the delay', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const pending = sleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow('Upload cancelled');
    // The point of the test: it returned in milliseconds, not ten seconds.
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

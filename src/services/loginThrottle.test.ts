import { describe, expect, it, beforeEach } from 'vitest';
import {
  LOGIN_LOCK_AFTER_FAILURES,
  LOGIN_LOCK_BASE_MS,
  LOGIN_LOCK_MAX_MS,
  LoginThrottleStore,
  lockDurationMsForFailures,
} from './loginThrottle.js';

describe('lockDurationMsForFailures', () => {
  it('does not lock before the threshold', () => {
    expect(lockDurationMsForFailures(0)).toBe(0);
    expect(lockDurationMsForFailures(LOGIN_LOCK_AFTER_FAILURES - 1)).toBe(0);
  });

  it('doubles from the base duration and caps at max', () => {
    expect(lockDurationMsForFailures(3)).toBe(LOGIN_LOCK_BASE_MS);
    expect(lockDurationMsForFailures(4)).toBe(LOGIN_LOCK_BASE_MS * 2);
    expect(lockDurationMsForFailures(5)).toBe(LOGIN_LOCK_BASE_MS * 4);
    expect(lockDurationMsForFailures(20)).toBe(LOGIN_LOCK_MAX_MS);
  });
});

describe('LoginThrottleStore', () => {
  let store: LoginThrottleStore;
  const ip = '203.0.113.10';

  beforeEach(() => {
    store = new LoginThrottleStore();
  });

  it('locks after three failures with 30s, then doubles', () => {
    let now = 1_000_000;
    expect(store.recordFailure(ip, now).locked).toBe(false);
    expect(store.recordFailure(ip, now + 1).locked).toBe(false);

    const third = store.recordFailure(ip, now + 2);
    expect(third.locked).toBe(true);
    expect(third.lockDurationMs).toBe(30_000);
    expect(store.getLockStatus(ip, now + 2).locked).toBe(true);

    now = now + 2 + 30_000 + 1;
    expect(store.getLockStatus(ip, now).locked).toBe(false);

    const fourth = store.recordFailure(ip, now);
    expect(fourth.lockDurationMs).toBe(60_000);
  });

  it('clears state on successful login', () => {
    const now = 1_000_000;
    store.recordFailure(ip, now);
    store.recordFailure(ip, now);
    store.recordFailure(ip, now);
    expect(store.getLockStatus(ip, now).locked).toBe(true);

    store.clear(ip);
    expect(store.getLockStatus(ip, now).locked).toBe(false);
    expect(store.recordFailure(ip, now).failures).toBe(1);
  });

  it('resets the counter after a long idle while unlocked', () => {
    let now = 1_000_000;
    store.recordFailure(ip, now);
    store.recordFailure(ip, now + 1);
    now += 60 * 60 * 1000 + 2;
    const next = store.recordFailure(ip, now);
    expect(next.failures).toBe(1);
    expect(next.locked).toBe(false);
  });

  it('lists attempts with locked entries first', () => {
    const now = 1_000_000;
    store.recordFailure('10.0.0.1', now);
    store.recordFailure('10.0.0.2', now);
    store.recordFailure('10.0.0.2', now);
    store.recordFailure('10.0.0.2', now);

    const rows = store.listAttempts(now);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ip).toBe('10.0.0.2');
    expect(rows[0]?.locked).toBe(true);
    expect(rows[1]?.ip).toBe('10.0.0.1');
    expect(rows[1]?.locked).toBe(false);
  });
});

import type { Request } from 'express';

/** Failures required before the first lock. */
export const LOGIN_LOCK_AFTER_FAILURES = 3;
/** First lock duration after reaching the failure threshold. */
export const LOGIN_LOCK_BASE_MS = 30_000;
/** Cap for exponential lock growth. */
export const LOGIN_LOCK_MAX_MS = 60 * 60 * 1000;
/** Idle window after which the failure counter resets while unlocked. */
export const LOGIN_FAILURE_IDLE_RESET_MS = 60 * 60 * 1000;

type AttemptState = {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
};

export type LockStatus =
  | { locked: false }
  | { locked: true; retryAfterSeconds: number; lockedUntil: number };

export type FailureResult = {
  failures: number;
  locked: boolean;
  retryAfterSeconds: number;
  lockDurationMs: number;
};

export type LoginAttemptView = {
  ip: string;
  failures: number;
  locked: boolean;
  retryAfterSeconds: number;
  lockedUntil: number | null;
  lastFailureAt: number;
};

/**
 * Lock duration for a given consecutive failure count.
 * failures < 3 → 0; 3 → 30s; 4 → 60s; 5 → 120s; … capped at 1h.
 */
export function lockDurationMsForFailures(failures: number): number {
  if (failures < LOGIN_LOCK_AFTER_FAILURES) return 0;
  const lockIndex = failures - LOGIN_LOCK_AFTER_FAILURES;
  const duration = LOGIN_LOCK_BASE_MS * 2 ** lockIndex;
  return Math.min(duration, LOGIN_LOCK_MAX_MS);
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded[0]?.trim()) {
    return forwarded[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function retryAfterSeconds(lockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((lockedUntil - now) / 1000));
}

/** In-memory login throttle. Restart clears state (DB persistence is a follow-up). */
export class LoginThrottleStore {
  private readonly attempts = new Map<string, AttemptState>();

  getLockStatus(ip: string, now = Date.now()): LockStatus {
    const state = this.attempts.get(ip);
    if (!state || state.lockedUntil <= now) {
      return { locked: false };
    }
    return {
      locked: true,
      retryAfterSeconds: retryAfterSeconds(state.lockedUntil, now),
      lockedUntil: state.lockedUntil,
    };
  }

  recordFailure(ip: string, now = Date.now()): FailureResult {
    const existing = this.attempts.get(ip);
    let failures = existing?.failures ?? 0;

    if (
      existing &&
      existing.lockedUntil <= now &&
      now - existing.lastFailureAt > LOGIN_FAILURE_IDLE_RESET_MS
    ) {
      failures = 0;
    }

    failures += 1;
    const lockDurationMs = lockDurationMsForFailures(failures);
    const lockedUntil = lockDurationMs > 0 ? now + lockDurationMs : 0;

    this.attempts.set(ip, {
      failures,
      lockedUntil,
      lastFailureAt: now,
    });

    this.prune(now);

    return {
      failures,
      locked: lockDurationMs > 0,
      retryAfterSeconds: lockDurationMs > 0 ? retryAfterSeconds(lockedUntil, now) : 0,
      lockDurationMs,
    };
  }

  clear(ip: string): void {
    this.attempts.delete(ip);
  }

  /** Clear all tracked IPs (admin unlock). */
  clearAll(): void {
    this.attempts.clear();
  }

  /** Snapshot of tracked login attempts for the admin profile UI. */
  listAttempts(now = Date.now()): LoginAttemptView[] {
    const rows: LoginAttemptView[] = [];
    for (const [ip, state] of this.attempts) {
      const locked = state.lockedUntil > now;
      rows.push({
        ip,
        failures: state.failures,
        locked,
        retryAfterSeconds: locked ? retryAfterSeconds(state.lockedUntil, now) : 0,
        lockedUntil: locked ? state.lockedUntil : null,
        lastFailureAt: state.lastFailureAt,
      });
    }
    rows.sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? -1 : 1;
      return b.lastFailureAt - a.lastFailureAt;
    });
    return rows;
  }

  private prune(now: number): void {
    if (this.attempts.size < 500) return;
    for (const [ip, state] of this.attempts) {
      const idle = now - state.lastFailureAt > LOGIN_FAILURE_IDLE_RESET_MS;
      const unlocked = state.lockedUntil <= now;
      if (idle && unlocked) this.attempts.delete(ip);
    }
  }
}

export const loginThrottle = new LoginThrottleStore();

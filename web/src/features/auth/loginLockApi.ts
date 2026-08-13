import { apiFetch, parseJsonResponse } from '../../shared/api';

export type LoginAttemptRow = {
  ip: string;
  failures: number;
  locked: boolean;
  retryAfterSeconds: number;
  lockedUntil: number | null;
  lastFailureAt: number;
};

export type LoginLockStatus = {
  locked: boolean;
  lockedCount: number;
  attempts: LoginAttemptRow[];
};

export async function getLoginLockStatus(): Promise<LoginLockStatus> {
  const res = await apiFetch('/auth/profile/login-lock');
  return parseJsonResponse<LoginLockStatus>(res);
}

export async function unlockLoginLock(ip?: string): Promise<void> {
  const res = await apiFetch('/auth/profile/login-lock/unlock', {
    method: 'POST',
    body: JSON.stringify(ip ? { ip } : {}),
  });
  await parseJsonResponse<{ ok?: boolean }>(res);
}

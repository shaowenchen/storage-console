import { useCallback, useEffect, useState } from 'react';
import { confirm, notify, notifyError } from '../../shared/components/AppNotice';
import { getLoginLockStatus, unlockLoginLock, type LoginLockStatus } from './loginLockApi';

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

export function LoginLockPanel() {
  const [status, setStatus] = useState<LoginLockStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getLoginLockStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await getLoginLockStatus();
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) {
          notifyError(err instanceof Error ? err.message : 'Failed to load login lock status');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onUnlock(ip?: string) {
    const ok = await confirm(
      ip
        ? `Clear failed-login state for ${ip}. They will be able to try again immediately.`
        : 'Clear failed-login state for every IP. Attackers can try again immediately.',
      'Unlock login',
    );
    if (!ok) return;

    setBusy(true);
    try {
      await unlockLoginLock(ip);
      await refresh();
      notify(ip ? `Unlocked ${ip}.` : 'Cleared all login lockouts.');
    } catch (err) {
      notifyError(err instanceof Error ? err.message : 'Unlock failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !status) {
    return (
      <div className="profile-row">
        <div className="profile-label">Login lock</div>
        <div className="profile-value muted">Loading…</div>
      </div>
    );
  }

  const hasAttempts = status.attempts.length > 0;

  return (
    <>
      <div className="profile-row profile-row-lock">
        <div className="profile-label">Login lock</div>
        <div className="profile-lock-value">
          <div className="profile-lock-status">
            {status.locked ? (
              <span className="profile-lock-badge locked">
                Locked ({status.lockedCount} IP{status.lockedCount === 1 ? '' : 's'})
              </span>
            ) : (
              <span className="profile-lock-badge unlocked">Unlocked</span>
            )}
            <span className="profile-lock-hint">
              Per-IP brute-force protection (in-memory; cleared on restart)
            </span>
          </div>
          {hasAttempts ? (
            <button
              type="button"
              className="ghost-btn profile-unlock-btn"
              disabled={busy}
              onClick={() => void onUnlock()}
            >
              Unlock all
            </button>
          ) : null}
        </div>
      </div>

      {hasAttempts ? (
        <div className="profile-lock-list">
          {status.attempts.map((row) => (
            <div className="profile-lock-item" key={row.ip}>
              <div className="profile-lock-item-main">
                <code className="profile-lock-ip">{row.ip}</code>
                <span className="profile-lock-meta">
                  {row.locked
                    ? `Locked · ${formatRetry(row.retryAfterSeconds)} left · ${row.failures} failures`
                    : `${row.failures} failure${row.failures === 1 ? '' : 's'} · not locked yet`}
                </span>
              </div>
              <button
                type="button"
                className="ghost-btn profile-unlock-btn"
                disabled={busy}
                onClick={() => void onUnlock(row.ip)}
              >
                Unlock
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

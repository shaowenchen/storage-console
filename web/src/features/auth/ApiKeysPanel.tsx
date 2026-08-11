import { useEffect, useState } from 'react';
import { confirm, notify, notifyError } from '../../shared/components/AppNotice';
import { getApiKeys, rotateApiKey } from '../../shared/upload/api';

type KeyType = 'upload' | 'download';

function maskKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function KeyRow({
  type,
  label,
  value,
  busy,
  onCopy,
  onRotate,
}: {
  type: KeyType;
  label: string;
  value: string;
  busy: KeyType | null;
  onCopy: (label: string, value: string) => void;
  onRotate: (type: KeyType) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="profile-row">
      <div className="profile-label">{label}</div>
      <div className="profile-value">
        <div className="api-key-cell">
          <code className="api-key-chip" title={revealed ? value : undefined}>
            {revealed ? value || '—' : maskKey(value)}
          </code>
          <div className="api-key-actions">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setRevealed((prev) => !prev)}
              disabled={!value}
            >
              {revealed ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void onCopy(label, value)}
              disabled={!value}
            >
              Copy
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy !== null}
              onClick={() => void onRotate(type)}
            >
              {busy === type ? '…' : 'Rotate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ApiKeysPanel() {
  const [upload, setUpload] = useState('');
  const [download, setDownload] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<KeyType | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getApiKeys()
      .then((keys) => {
        if (cancelled) return;
        setUpload(keys.upload);
        setDownload(keys.download);
      })
      .catch(() => {
        if (!cancelled) notifyError('Failed to load API keys');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onCopy(label: string, value: string) {
    if (!value) return;
    const ok = await copyText(value);
    if (ok) notify(`${label} key copied`);
    else notifyError(`Failed to copy ${label} key`);
  }

  async function onRotate(type: KeyType) {
    const ok = await confirm(
      `The current ${type} key will stop working immediately. Scripts must use the new key.`,
      `Rotate ${type} key?`,
    );
    if (!ok) return;
    setBusy(type);
    try {
      const next = await rotateApiKey(type);
      if (type === 'upload') setUpload(next);
      else setDownload(next);
      notify(`${type} key rotated`);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : `Failed to rotate ${type} key`);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="profile-muted">Loading keys…</div>;
  }

  return (
    <>
      <KeyRow
        type="upload"
        label="Upload"
        value={upload}
        busy={busy}
        onCopy={onCopy}
        onRotate={onRotate}
      />
      <KeyRow
        type="download"
        label="Download"
        value={download}
        busy={busy}
        onCopy={onCopy}
        onRotate={onRotate}
      />
    </>
  );
}

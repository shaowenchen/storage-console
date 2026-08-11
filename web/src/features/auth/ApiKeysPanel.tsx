import { useEffect, useState } from 'react';
import { confirm, notify, notifyError } from '../../shared/components/AppNotice';
import { getApiKeys, rotateApiKey } from '../../shared/upload/api';

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

export function ApiKeysPanel() {
  const [upload, setUpload] = useState('');
  const [download, setDownload] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'upload' | 'download' | null>(null);

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

  async function onRotate(type: 'upload' | 'download') {
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
    return <div className="profile-card api-keys-muted">Loading…</div>;
  }

  return (
    <div className="profile-card api-keys-panel">
      <div className="api-keys-row">
        <div className="api-keys-meta">
          <span className="api-keys-label">Upload</span>
          <code className="api-keys-value" title={upload}>
            {maskKey(upload)}
          </code>
        </div>
        <div className="api-keys-actions">
          <button type="button" className="ghost-btn api-keys-btn" onClick={() => void onCopy('Upload', upload)}>
            Copy
          </button>
          <button
            type="button"
            className="ghost-btn api-keys-btn"
            disabled={busy !== null}
            onClick={() => void onRotate('upload')}
          >
            {busy === 'upload' ? '…' : 'Rotate'}
          </button>
        </div>
      </div>
      <div className="api-keys-row">
        <div className="api-keys-meta">
          <span className="api-keys-label">Download</span>
          <code className="api-keys-value" title={download}>
            {maskKey(download)}
          </code>
        </div>
        <div className="api-keys-actions">
          <button
            type="button"
            className="ghost-btn api-keys-btn"
            onClick={() => void onCopy('Download', download)}
          >
            Copy
          </button>
          <button
            type="button"
            className="ghost-btn api-keys-btn"
            disabled={busy !== null}
            onClick={() => void onRotate('download')}
          >
            {busy === 'download' ? '…' : 'Rotate'}
          </button>
        </div>
      </div>
    </div>
  );
}

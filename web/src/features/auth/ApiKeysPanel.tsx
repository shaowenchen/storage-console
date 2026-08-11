import { useEffect, useState } from 'react';
import { confirm, notify, notifyError } from '../../shared/components/AppNotice';
import { getApiKeys, rotateApiKey } from '../../shared/upload/api';

type KeyType = 'upload' | 'download';

const KEY_META: Record<KeyType, { label: string; description: string }> = {
  upload: {
    label: 'Upload',
    description: 'Authorize script and Pull & Run uploads',
  },
  download: {
    label: 'Download',
    description: 'Authorize script downloads and signed links',
  },
};

function maskKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 18) return key;
  return `${key.slice(0, 10)}…${key.slice(-6)}`;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function KeyCard({
  type,
  value,
  busy,
  onCopy,
  onRotate,
}: {
  type: KeyType;
  value: string;
  busy: KeyType | null;
  onCopy: (label: string, value: string) => void;
  onRotate: (type: KeyType) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const meta = KEY_META[type];

  return (
    <div className="api-key-card">
      <div className="api-key-card-head">
        <div className="api-key-card-title">{meta.label}</div>
        <div className="api-key-card-desc">{meta.description}</div>
      </div>
      <div className="api-key-field">
        <code className="api-key-field-value" title={revealed ? value : undefined}>
          {revealed ? value || '—' : maskKey(value)}
        </code>
        <div
          className="api-key-field-actions"
          role="group"
          aria-label={`${meta.label} key actions`}
        >
          <button
            type="button"
            className="api-key-action"
            onClick={() => setRevealed((prev) => !prev)}
            disabled={!value}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            className="api-key-action"
            onClick={() => void onCopy(meta.label, value)}
            disabled={!value}
          >
            Copy
          </button>
          <button
            type="button"
            className="api-key-action api-key-action-danger"
            disabled={busy !== null}
            onClick={() => void onRotate(type)}
          >
            {busy === type ? '…' : 'Rotate'}
          </button>
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
    <div className="api-keys-grid">
      <KeyCard type="upload" value={upload} busy={busy} onCopy={onCopy} onRotate={onRotate} />
      <KeyCard type="download" value={download} busy={busy} onCopy={onCopy} onRotate={onRotate} />
    </div>
  );
}

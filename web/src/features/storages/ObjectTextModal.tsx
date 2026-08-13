import { useEffect, useState } from 'react';
import { confirm } from '../../shared/components/AppNotice';
import { getObjectContent, putObjectContent } from './api';

export type ObjectTextMode = 'preview' | 'edit';

type Props = {
  open: boolean;
  bucketId: string;
  objectKey: string;
  mode: ObjectTextMode;
  onClose: () => void;
  onSaved: () => void;
};

export function ObjectTextModal({ open, bucketId, objectKey, mode, onClose, onSaved }: Props) {
  const [viewMode, setViewMode] = useState<ObjectTextMode>(mode);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [contentType, setContentType] = useState('text/plain');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = objectKey.split('/').filter(Boolean).pop() || objectKey;
  const dirty = content !== original;

  useEffect(() => {
    if (!open) return;
    setViewMode(mode);
    setContent('');
    setOriginal('');
    setError(null);
    setLoading(true);
    let cancelled = false;
    void getObjectContent(bucketId, objectKey)
      .then((data) => {
        if (cancelled) return;
        setContent(data.content);
        setOriginal(data.content);
        setContentType(data.contentType);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load object');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, bucketId, objectKey, mode]);

  if (!open) return null;

  async function requestClose() {
    if (viewMode === 'edit' && dirty) {
      if (!(await confirm('Discard unsaved changes?'))) return;
    }
    onClose();
  }

  async function onSave() {
    if (
      !(await confirm(`Overwrite "${objectKey}"? This cannot be undone.`))
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await putObjectContent(bucketId, { key: objectKey, content, contentType });
      setOriginal(content);
      onSaved();
      setViewMode('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save object');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => void requestClose()}>
      <div
        className="modal object-text-modal"
        role="dialog"
        aria-modal="true"
        aria-label={fileName}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header object-text-header">
          <div>
            <h2>{fileName}</h2>
            <p className="object-text-meta">
              {viewMode === 'preview' ? 'Preview' : 'Edit'}
              {contentType ? ` · ${contentType}` : ''}
            </p>
          </div>
        </div>

        {loading ? <p className="muted">Loading…</p> : null}
        {error ? <p className="object-text-error">{error}</p> : null}

        {!loading && !error ? (
          viewMode === 'preview' ? (
            <pre className="object-text-body object-text-preview">{content}</pre>
          ) : (
            <textarea
              className="object-text-body object-text-editor"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
            />
          )
        ) : null}

        <div className="modal-actions">
          {viewMode === 'preview' ? (
            <>
              {!error ? (
                <button type="button" onClick={() => setViewMode('edit')} disabled={loading}>
                  Edit
                </button>
              ) : null}
              <button type="button" className="button-ghost" onClick={() => void requestClose()}>
                Close
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button-ghost"
                onClick={() => void requestClose()}
                disabled={saving}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void onSave()} disabled={saving || loading || !!error}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

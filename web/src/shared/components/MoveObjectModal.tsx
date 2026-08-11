import { useEffect, useState, type FormEvent } from 'react';

type Props = {
  open: boolean;
  title: string;
  initialPath: string;
  onClose: () => void;
  onConfirm: (targetRelative: string) => void | Promise<void>;
};

export function MoveObjectModal({ open, title, initialPath, onClose, onConfirm }: Props) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setError(null);
    setSubmitting(false);
  }, [open, initialPath]);

  if (!open) return null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = path.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      setError('Target path is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(normalized);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move object');
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-object-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void onSubmit(e)}
      >
        <div className="modal-header">
          <h2 id="move-object-title">{title}</h2>
        </div>
        <div className="storage-modal-body">
          <label>
            Target path
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="folder/subfolder/file-name"
              autoFocus
            />
          </label>
          <p className="muted field-hint">Use a relative path under the storage prefix.</p>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="button-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Moving…' : 'Move'}
          </button>
        </div>
      </form>
    </div>
  );
}

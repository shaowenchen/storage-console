import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notify, notifyError } from './AppNotice';
import type { Storage } from '../../features/storages/types';
import { copyToClipboard } from '../format';
import { getUploadKey, storageUploadScriptUrl } from '../upload/api';
import { normalizeRelativePath, uploadRunCommand, uploadTargetPath } from '../upload/helpers';
import { runUpload } from '../upload/runUpload';
import './upload.css';

function storageOptionLabel(storage: Storage): string {
  return storage.name;
}

export type UploadModalConfig = {
  mode: 'storage';
  bucketId: string;
  relativePath?: string;
};

type Props = {
  open: boolean;
  config: UploadModalConfig | null;
  storages: Storage[];
  initialFiles?: File[] | null;
  onClose: () => void;
  onComplete: () => void;
};

export function UploadModal({ open, config, storages, initialFiles, onClose, onComplete }: Props) {
  const [bucketId, setBucketId] = useState('');
  const [relativePath, setRelativePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, message: 'Preparing upload…' });
  const [showProgress, setShowProgress] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [uploadKey, setUploadKey] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedBucket = storages.find((s) => s.id === bucketId);
  const targetPreview = uploadTargetPath(selectedBucket, relativePath);

  const scriptEndpoint = useMemo(() => {
    if (!config || !bucketId) return '';
    return storageUploadScriptUrl(bucketId, normalizeRelativePath(relativePath));
  }, [config, bucketId, relativePath]);

  const runCommand = scriptEndpoint ? uploadRunCommand(scriptEndpoint, uploadKey) : '';

  useEffect(() => {
    if (!open || !config) return;
    setError(null);
    setShowProgress(false);
    setProgress({ percent: 0, message: 'Preparing upload…' });
    setScriptExpanded(false);
    setUploadKey('');
    setPendingFiles(initialFiles ? [...initialFiles] : null);
    if (fileInputRef.current) fileInputRef.current.value = '';

    setBucketId(config.bucketId || storages[0]?.id || '');
    setRelativePath(config.relativePath || '');
  }, [open, config, initialFiles, storages]);

  useEffect(() => {
    if (!open || !scriptExpanded) return;
    let cancelled = false;
    getUploadKey()
      .then((key) => {
        if (!cancelled) setUploadKey(key);
      })
      .catch(() => {
        if (!cancelled) setUploadKey('');
      });
    return () => {
      cancelled = true;
    };
  }, [open, scriptExpanded, bucketId, relativePath, config]);

  function handleClose() {
    if (uploading) {
      notifyError('Upload is in progress. Cancel it before closing this dialog.');
      return;
    }
    onClose();
  }

  function handleCancelUpload() {
    abortRef.current?.abort();
    setProgress({ percent: 0, message: 'Cancelling upload…' });
  }

  async function handleCopyScript(part: 'file' | 'upload') {
    const value =
      part === 'file'
        ? 'export FILE_PATH="/path/to/file"'
        : runCommand || '# Choose an upload target first.';
    if (part === 'upload' && !runCommand) {
      try {
        const key = await getUploadKey();
        const cmd = uploadRunCommand(scriptEndpoint, key);
        const ok = await copyToClipboard(cmd);
        notify(ok ? 'Copied run command.' : 'Failed to copy run command.');
        return;
      } catch {
        notifyError('Failed to load upload key.');
        return;
      }
    }
    const ok = await copyToClipboard(value);
    notify(
      ok ? `Copied ${part === 'file' ? 'file path snippet' : 'run command'}.` : 'Copy failed.',
    );
  }

  const startUpload = useCallback(async () => {
    if (!config) return;
    const files =
      pendingFiles || (fileInputRef.current?.files ? Array.from(fileInputRef.current.files) : []);
    if (!bucketId) {
      setError('Choose a storage');
      return;
    }
    if (!files.length) {
      setError('Choose at least one file');
      return;
    }

    setError(null);
    setUploading(true);
    setShowProgress(true);
    abortRef.current = new AbortController();

    const uploadContext = {
      mode: 'storage' as const,
      bucketId,
      relativePath: normalizeRelativePath(relativePath),
    };

    try {
      await runUpload({
        files,
        context: uploadContext,
        onProgress: setProgress,
        signal: abortRef.current.signal,
      });
      setPendingFiles(null);
      onComplete();
      setTimeout(() => onClose(), 900);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      const display = message === 'Upload cancelled' ? 'Upload cancelled' : `Upload failed: ${message}`;
      setError(display);
      setProgress({
        percent: 0,
        message: display,
      });
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  }, [config, pendingFiles, bucketId, relativePath, onComplete, onClose]);

  if (!open || !config) return null;

  return (
    <div className="upload-modal-overlay" role="presentation" onClick={handleClose}>
      <div
        className="upload-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="upload-modal-title">Upload Files</h2>

        <div className="upload-field">
          <label htmlFor="upload-bucket">Storage</label>
          <div className="upload-select-wrap">
            <select
              id="upload-bucket"
              className="upload-control"
              value={bucketId}
              onChange={(e) => setBucketId(e.target.value)}
              disabled={uploading}
            >
              {storages.length === 0 ? (
                <option value="">No storages</option>
              ) : (
                storages.map((bucket) => (
                  <option key={bucket.id} value={bucket.id}>
                    {storageOptionLabel(bucket)}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
        <div className="upload-field">
          <label htmlFor="upload-relative-path">Relative Path</label>
          <input
            id="upload-relative-path"
            className="upload-control"
            value={relativePath}
            placeholder="e.g., datasets/raw"
            disabled={uploading}
            onChange={(e) => setRelativePath(e.target.value)}
          />
        </div>

        <div className="upload-target-card">
          <div className="upload-target-label">Upload Target</div>
          <div className="upload-target-path">{targetPreview}</div>
        </div>

        <div className="upload-field">
          <label htmlFor="upload-files-input">Files</label>
          <input
            id="upload-files-input"
            ref={fileInputRef}
            className="upload-control upload-file-input"
            type="file"
            multiple
            disabled={uploading}
            onChange={() => setPendingFiles(null)}
          />
        </div>

        <div className={`upload-script-card${scriptExpanded ? ' expanded' : ''}`}>
          <div className="upload-script-top">
            <div className="upload-script-title">Direct Upload CLI</div>
            <button
              type="button"
              className="button-outline"
              onClick={() => setScriptExpanded((v) => !v)}
            >
              {scriptExpanded ? 'Hide Script' : 'Show Script'}
            </button>
          </div>
          {scriptExpanded ? (
            <div className="upload-script-body">
              <div className="upload-script-section">
                <div className="upload-script-section-top">
                  <div>1. File Path</div>
                  <button
                    type="button"
                    className="button-outline"
                    onClick={() => handleCopyScript('file')}
                  >
                    Copy
                  </button>
                </div>
                <textarea
                  className="upload-script-code upload-script-code-small"
                  readOnly
                  value={'export FILE_PATH="/path/to/file"'}
                />
              </div>
              <div className="upload-script-section">
                <div className="upload-script-section-top">
                  <div>{'2. Pull & Run'}</div>
                  <button
                    type="button"
                    className="button-outline"
                    onClick={() => handleCopyScript('upload')}
                  >
                    Copy Command
                  </button>
                </div>
                <textarea
                  className="upload-script-code"
                  readOnly
                  value={
                    scriptEndpoint
                      ? runCommand || 'Loading upload key…'
                      : '# Choose an upload target first.'
                  }
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className={`upload-progress-card${showProgress ? ' show' : ''}`}>
          <div className="upload-progress-top">
            <div>Uploading</div>
            <div>{Math.round(progress.percent)}%</div>
          </div>
          <div className="upload-progress-line">
            <div className="bar" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="upload-progress-detail">{progress.message}</div>
          {uploading ? (
            <button type="button" className="button-ghost" onClick={handleCancelUpload}>
              Cancel upload
            </button>
          ) : null}
        </div>

        {error ? <p className="upload-error">{error}</p> : null}

        <div className="upload-modal-actions">
          <button type="button" className="button-ghost" disabled={uploading} onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={uploading}
            onClick={() => void startUpload()}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function openUploadBlockedMessage(_mode: 'storage'): string {
  return 'Choose a storage first.';
}

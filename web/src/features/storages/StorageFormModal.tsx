import { useEffect, useState, type FormEvent } from 'react';
import type { Storage, StorageFormValues, StorageTestResult } from './types';
import { createStorage, testStorage, updateStorage } from './api';

type Props = {
  open: boolean;
  storage: Storage | null;
  onClose: () => void;
  onSaved: () => void;
};

const emptyForm = (): StorageFormValues => ({
  name: '',
  storageType: 'ObjectStorage',
  endpoint: '',
  region: '',
  accessKey: '',
  secretKey: '',
  bucketName: '',
  bucketPath: '',
});

export function StorageFormModal({ open, storage, onClose, onSaved }: Props) {
  const [form, setForm] = useState<StorageFormValues>(emptyForm());
  const [maskedSecret, setMaskedSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<StorageTestResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (storage) {
      setForm({
        name: storage.name || '',
        storageType: storage.storageType || 'ObjectStorage',
        endpoint: storage.endpoint || '',
        region: storage.region || '',
        accessKey: storage.accessKey || '',
        secretKey: storage.secretKeyMasked || '',
        bucketName: storage.bucketName || '',
        bucketPath: storage.bucketPath || '',
      });
      setMaskedSecret(storage.secretKeyMasked || '');
    } else {
      setForm(emptyForm());
      setMaskedSecret('');
    }
    setError(null);
    setTestResult(null);
  }, [open, storage]);

  if (!open) return null;

  function buildPayload(): Partial<StorageFormValues> {
    const body: Partial<StorageFormValues> = {
      name: form.name.trim(),
      storageType: form.storageType,
      endpoint: form.endpoint.trim(),
      region: form.region.trim(),
      bucketName: form.bucketName.trim(),
      bucketPath: form.bucketPath.trim().replace(/^\/+|\/+$/g, ''),
    };
    if (form.accessKey.trim()) body.accessKey = form.accessKey.trim();
    if (form.secretKey.trim() && form.secretKey !== maskedSecret) {
      body.secretKey = form.secretKey.trim();
    }
    return body;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = buildPayload();
    if (!payload.name || !payload.endpoint || !payload.bucketName) {
      setError('Name, endpoint, and storage name are required');
      return;
    }
    setSubmitting(true);
    try {
      if (storage) {
        await updateStorage(storage.id, payload);
      } else {
        await createStorage(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save storage');
    } finally {
      setSubmitting(false);
    }
  }

  async function onTest() {
    setError(null);
    setTestResult(null);
    const payload = buildPayload();
    if (!payload.name || !payload.endpoint || !payload.bucketName) {
      setError('Name, endpoint, and storage name are required to test');
      return;
    }
    setTesting(true);
    try {
      let id = storage?.id;
      if (!id) {
        const created = await createStorage(payload);
        id = created.id;
      }
      await testStorage(id, payload);
      setTestResult({ ok: true, message: 'Connection successful' });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Test failed',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-modal-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
      >
        <div className="modal-header">
          <h2 id="storage-modal-title">{storage ? 'Edit Storage' : 'Add Storage'}</h2>
        </div>
        <div className="storage-modal-body">
          <label>
            Type
            <select
              value={form.storageType}
              onChange={(e) => setForm((f) => ({ ...f, storageType: e.target.value }))}
            >
              <option value="ObjectStorage">ObjectStorage</option>
            </select>
          </label>
          <label>
            Display Name
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g., Production Object Storage"
            />
          </label>
          <label>
            Endpoint URL
            <input
              value={form.endpoint}
              onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
              placeholder="https://s3.region.example.com"
            />
            <span className="muted field-hint">
              HTTPS S3-compatible endpoint. Region in the URL should match the region field below.
            </span>
          </label>
          <label>
            Region
            <input
              value={form.region}
              onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
              placeholder="e.g. us-east-1, cn-beijing"
            />
            <span className="muted field-hint">
              Required for most providers. Mismatched endpoint and region often cause auth errors.
            </span>
          </label>
          <label>
            Access Key
            <input
              value={form.accessKey}
              onChange={(e) => setForm((f) => ({ ...f, accessKey: e.target.value }))}
            />
          </label>
          <label>
            Secret Key
            <input
              type="password"
              value={form.secretKey}
              onChange={(e) => setForm((f) => ({ ...f, secretKey: e.target.value }))}
              placeholder="Your S3 secret access key"
            />
          </label>
          <label>
            Storage Name
            <input
              value={form.bucketName}
              onChange={(e) => setForm((f) => ({ ...f, bucketName: e.target.value }))}
              placeholder="my-storage-bucket"
            />
          </label>
          <label>
            Storage Path
            <input
              value={form.bucketPath}
              onChange={(e) => setForm((f) => ({ ...f, bucketPath: e.target.value }))}
              placeholder="optional/path/prefix"
            />
          </label>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        {testResult ? (
          <div className={testResult.ok ? 'test-result success' : 'test-result error'}>
            <p>
              {testResult.ok
                ? testResult.message || 'Connection successful'
                : testResult.message || 'Connection failed'}
            </p>
            {!testResult.ok ? (
              <p className="muted field-hint">
                Check endpoint URL, region, access key, secret key, and bucket name. Run Test
                Connection before saving.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-outline"
            disabled={testing}
            onClick={() => void onTest()}
          >
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : storage ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}

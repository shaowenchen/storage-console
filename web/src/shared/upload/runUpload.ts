import { apiUrl } from '../api';
import { formatApiError } from '../apiError';
import type { UploadProgress } from './types';
import { completeStorageUpload } from './api';
import { normalizeRelativePath } from './helpers';

type UploadContext = {
  mode: 'storage';
  bucketId: string;
  relativePath: string;
};

export type RunUploadOptions = {
  files: File[];
  context: UploadContext;
  onProgress: (progress: UploadProgress) => void;
  signal?: AbortSignal;
};

type ProxyUploadResult = {
  key: string;
  name: string;
  size: number;
  contentType: string;
};

function formatProxyUploadError(xhr: XMLHttpRequest, file: File): string {
  const raw = typeof xhr.responseText === 'string' ? xhr.responseText : '';
  if (raw) {
    try {
      const data: unknown = JSON.parse(raw);
      return formatApiError(data, `Upload of "${file.name}" failed`);
    } catch {
      const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
      if (xhr.status > 0) {
        return `Upload of "${file.name}" failed with HTTP ${xhr.status}: ${preview}`;
      }
    }
  }
  if (xhr.status > 0) {
    return `Upload of "${file.name}" failed with HTTP ${xhr.status}`;
  }
  return `Upload of "${file.name}" failed (network error)`;
}

/** Same-origin proxy PUT → server PutObject (avoids bucket CORS). */
function uploadFileViaProxy(
  bucketId: string,
  relativePath: string,
  file: File,
  onChunk: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ProxyUploadResult> {
  return new Promise((resolve, reject) => {
    const contentType = file.type || 'application/octet-stream';
    const params = new URLSearchParams({
      relativePath,
      name: file.name,
      contentType,
    });
    const url = apiUrl(`/storages/${encodeURIComponent(bucketId)}/upload-object?${params}`);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);

    if (signal) {
      if (signal.aborted) {
        reject(new Error('Upload cancelled'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onChunk(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as Partial<ProxyUploadResult>;
          resolve({
            key: String(data.key || ''),
            name: String(data.name || file.name),
            size: Number(data.size) || file.size,
            contentType: String(data.contentType || contentType),
          });
        } catch {
          reject(new Error(`Upload of "${file.name}" succeeded but returned invalid JSON`));
        }
        return;
      }
      reject(new Error(formatProxyUploadError(xhr, file)));
    };
    xhr.onerror = () => reject(new Error(formatProxyUploadError(xhr, file)));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });
}

export async function runUpload({
  files,
  context,
  onProgress,
  signal,
}: RunUploadOptions): Promise<void> {
  if (!files.length) return;

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;
  let uploadedBeforeCurrent = 0;
  const relativePath = normalizeRelativePath(context.relativePath);

  const completed: Array<{
    key: string;
    name: string;
    size: number;
    contentType: string;
    relativePath: string;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new Error('Upload cancelled');
    const file = files[i]!;
    onProgress({
      percent: 5 + (uploadedBeforeCurrent / totalBytes) * 85,
      message: `Uploading ${i + 1}/${files.length}: ${file.name}`,
    });

    const uploaded = await uploadFileViaProxy(
      context.bucketId,
      relativePath,
      file,
      (loaded) => {
        const percent = 5 + ((uploadedBeforeCurrent + loaded) / totalBytes) * 85;
        onProgress({ percent, message: `Uploading ${i + 1}/${files.length}: ${file.name}` });
      },
      signal,
    );

    if (!uploaded.key) {
      throw new Error(`Upload of "${file.name}" did not return an object key`);
    }

    uploadedBeforeCurrent += file.size;
    completed.push({
      key: uploaded.key,
      name: uploaded.name,
      size: uploaded.size,
      contentType: uploaded.contentType,
      relativePath,
    });
  }

  if (signal?.aborted) throw new Error('Upload cancelled');

  onProgress({ percent: 92, message: 'Finalizing upload records…' });

  try {
    await completeStorageUpload(context.bucketId, completed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Upload PUT succeeded but finalize failed: ${detail}`);
  }

  onProgress({ percent: 100, message: 'Upload complete' });
}

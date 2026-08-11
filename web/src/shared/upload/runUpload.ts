import type { UploadLink, UploadProgress } from './types';
import { completeStorageUpload, createStorageUploadLinks } from './api';
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

function uploadFileWithProgress(
  upload: UploadLink,
  file: File,
  onChunk: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', upload.url);
    const headers = upload.headers || { 'Content-Type': file.type || 'application/octet-stream' };
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));

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
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Direct upload failed with HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Direct upload failed'));
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

  onProgress({ percent: 5, message: `Preparing ${files.length} direct upload link(s)…` });

  const fileMeta = files.map((file) => ({
    name: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
  }));

  const relativePath = normalizeRelativePath(context.relativePath);

  const linkData = await createStorageUploadLinks(context.bucketId, relativePath, fileMeta);

  const uploads = linkData.uploads || [];
  const completed: Array<{
    key: string;
    name: string;
    size: number;
    contentType: string;
    relativePath: string;
  }> = [];

  for (let i = 0; i < uploads.length; i++) {
    if (signal?.aborted) throw new Error('Upload cancelled');
    const upload = uploads[i]!;
    const file = files[i]!;
    onProgress({
      percent: 5 + (uploadedBeforeCurrent / totalBytes) * 85,
      message: `Uploading ${i + 1}/${uploads.length}: ${file.name}`,
    });
    await uploadFileWithProgress(
      upload,
      file,
      (loaded) => {
        const percent = 5 + ((uploadedBeforeCurrent + loaded) / totalBytes) * 85;
        onProgress({ percent, message: `Uploading ${i + 1}/${uploads.length}: ${file.name}` });
      },
      signal,
    );
    uploadedBeforeCurrent += file.size;
    completed.push({
      key: upload.key,
      name: upload.name,
      size: upload.size,
      contentType: upload.contentType,
      relativePath,
    });
  }

  if (signal?.aborted) throw new Error('Upload cancelled');

  onProgress({ percent: 92, message: 'Finalizing upload records…' });

  await completeStorageUpload(context.bucketId, completed);

  onProgress({ percent: 100, message: 'Upload complete' });
}

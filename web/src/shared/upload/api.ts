import { apiFetch, apiUrl, parseJsonResponse } from '../api';
import type { CompletedUpload, UploadFileMeta, UploadLinksResponse } from './types';

async function parseJson<T>(res: Response): Promise<T> {
  return parseJsonResponse<T>(res);
}

export async function createStorageUploadLinks(
  bucketId: string,
  relativePath: string,
  files: UploadFileMeta[],
): Promise<UploadLinksResponse> {
  const res = await apiFetch(`/storages/${bucketId}/upload-links`, {
    method: 'POST',
    body: JSON.stringify({ relativePath, files }),
  });
  return parseJson<UploadLinksResponse>(res);
}

export async function completeStorageUpload(
  bucketId: string,
  files: CompletedUpload[],
): Promise<void> {
  const res = await apiFetch(`/storages/${bucketId}/upload-complete`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });
  await parseJson<{ ok?: boolean }>(res);
}

export async function getUploadKey(): Promise<string> {
  const res = await apiFetch('/auth/profile/keys/upload');
  const data = await parseJson<{ key?: string }>(res);
  return data.key || '';
}

export async function getDownloadKey(): Promise<string> {
  const res = await apiFetch('/auth/profile/keys/download');
  const data = await parseJson<{ key?: string }>(res);
  return data.key || '';
}

export async function getApiKeys(): Promise<{ upload: string; download: string }> {
  const res = await apiFetch('/auth/profile/keys');
  const data = await parseJson<{ upload?: string; download?: string }>(res);
  return { upload: data.upload || '', download: data.download || '' };
}

export async function rotateApiKey(type: 'upload' | 'download'): Promise<string> {
  const res = await apiFetch(`/auth/profile/keys/${type}/rotate`, { method: 'POST' });
  const data = await parseJson<{ key?: string }>(res);
  return data.key || '';
}

/** Absolute API root for CLI scripts, e.g. https://host/api or https://host/prefix/api */
export function scriptApiBase(): string {
  const relativeApiRoot = apiUrl('/').replace(/\/$/, '');
  if (/^https?:\/\//i.test(relativeApiRoot)) return relativeApiRoot;
  return `${window.location.origin}${relativeApiRoot}`;
}

export function storageUploadScriptUrl(bucketId: string, relativePath: string): string {
  const apiBase = scriptApiBase();
  const params = new URLSearchParams({ apiBase });
  if (relativePath) params.set('relativePath', relativePath);
  return `${apiBase}/storages/${encodeURIComponent(bucketId)}/upload-script?${params}`;
}

export function storageDownloadScriptUrl(bucketId: string, key: string, output?: string): string {
  const apiBase = scriptApiBase();
  const params = new URLSearchParams({ apiBase, key });
  if (output) params.set('output', output);
  return `${apiBase}/storages/${encodeURIComponent(bucketId)}/download-script?${params}`;
}

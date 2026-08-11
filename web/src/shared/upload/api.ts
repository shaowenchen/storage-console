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

export function scriptApiBase(): string {
  return apiUrl('').replace(/\/api\/?$/, '');
}

export function storageUploadScriptUrl(bucketId: string, relativePath: string): string {
  const params = new URLSearchParams({ apiBase: scriptApiBase() });
  if (relativePath) params.set('relativePath', relativePath);
  return `${scriptApiBase()}/api/storages/${encodeURIComponent(bucketId)}/upload-script?${params}`;
}


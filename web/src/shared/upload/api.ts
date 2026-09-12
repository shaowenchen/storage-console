import { apiFetch, apiUrl, parseJsonResponse } from '../api';
import type { CompletedUpload, UploadLimits, UploadedPart } from './types';

async function parseJson<T>(res: Response): Promise<T> {
  return parseJsonResponse<T>(res);
}

export async function fetchUploadLimits(): Promise<UploadLimits> {
  const res = await apiFetch('/storages/upload-limits');
  const data = await parseJson<Partial<UploadLimits>>(res);
  return {
    maxFiles: Number(data.maxFiles) || 0,
    maxBytes: Number(data.maxBytes) || 0,
  };
}

/**
 * Absolute URL for starting a chunked upload.
 *
 * Returned rather than fetched so the caller can drive it with an XHR, which is
 * what reports upload progress — `fetch` has no equivalent for a request body.
 */
export function uploadMultipartUrl(
  bucketId: string,
  relativePath: string,
  file: File,
): string {
  const params = new URLSearchParams({
    relativePath,
    name: file.name,
    contentType: file.type || 'application/octet-stream',
    size: String(file.size),
  });
  return apiUrl(`/storages/${encodeURIComponent(bucketId)}/upload-multipart?${params}`);
}

/**
 * URL for one part PUT; the body is the raw slice.
 *
 * Only the part number is sent: which part is last, and therefore how long it
 * must be, is derived by the server from the signed session. A client-declared
 * "this is the last part" would be a way to break the storage's minimum-size
 * rule.
 */
export function uploadPartUrl(bucketId: string, uploadToken: string, partNumber: number): string {
  const params = new URLSearchParams({
    uploadToken,
    partNumber: String(partNumber),
  });
  return apiUrl(`/storages/${encodeURIComponent(bucketId)}/upload-part?${params}`);
}

/** Finish a chunked upload from the parts the server acknowledged. */
export async function completeMultipartUpload(
  bucketId: string,
  uploadToken: string,
  parts: UploadedPart[],
): Promise<{
  key: string;
  name: string;
  size: number;
  contentType: string;
}> {
  const res = await apiFetch(`/storages/${bucketId}/upload-multipart/complete`, {
    method: 'POST',
    body: JSON.stringify({
      uploadToken,
      parts: parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    }),
  });
  return parseJson(res);
}

/**
 * Abandon a chunked upload.
 *
 * Best-effort by design: this runs on cancel and failure paths, where a throw
 * would replace the real error with a cleanup one. The server treats an unknown
 * token as success, so a retry after the session aged out is harmless.
 */
export async function abortMultipartUpload(bucketId: string, uploadToken: string): Promise<void> {
  await apiFetch(`/storages/${bucketId}/upload-multipart/abort`, {
    method: 'POST',
    body: JSON.stringify({ uploadToken }),
  }).catch(() => undefined);
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

import { apiFetch, parseJsonResponse } from '../../shared/api';
import type { Storage, StorageFilesResponse, StorageFormValues, StorageTestResult } from './types';

async function parseJson<T>(res: Response): Promise<T> {
  return parseJsonResponse<T>(res);
}

export async function listStorages(): Promise<Storage[]> {
  const res = await apiFetch('/storages');
  return parseJson<Storage[]>(res);
}

export async function createStorage(body: Partial<StorageFormValues>): Promise<Storage> {
  const res = await apiFetch('/storages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseJson<Storage>(res);
}

export async function updateStorage(
  id: string,
  body: Partial<StorageFormValues>,
): Promise<Storage> {
  const res = await apiFetch(`/storages/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return parseJson<Storage>(res);
}

export async function deleteStorage(id: string): Promise<void> {
  const res = await apiFetch(`/storages/${id}`, { method: 'DELETE' });
  await parseJson<{ ok: boolean }>(res);
}

export async function testStorage(
  id: string,
  body?: Partial<StorageFormValues>,
): Promise<StorageTestResult> {
  const res = await apiFetch(`/storages/${id}/test`, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseJson<StorageTestResult>(res);
}

export async function listStorageFiles(
  bucketId: string,
  prefix = '',
  cursor?: string | null,
): Promise<StorageFilesResponse> {
  const params = new URLSearchParams({ prefix });
  if (cursor) params.set('cursor', cursor);
  const res = await apiFetch(`/storages/${bucketId}/files?${params}`);
  return parseJson<StorageFilesResponse>(res);
}

export async function getObjectAccess(
  bucketId: string,
  key: string,
): Promise<{ isPublic: boolean; publicUrl?: string; aclSupported?: boolean }> {
  const params = new URLSearchParams({ key });
  const res = await apiFetch(`/storages/${bucketId}/object-access?${params}`);
  return parseJson<{ isPublic: boolean; publicUrl?: string; aclSupported?: boolean }>(res);
}

export async function getDownloadLink(
  bucketId: string,
  key: string,
): Promise<{ url: string; expiresInSeconds?: number; direct?: boolean }> {
  const params = new URLSearchParams({ key });
  const res = await apiFetch(`/storages/${bucketId}/download-object-link?${params}`);
  return parseJson<{ url: string; expiresInSeconds?: number; direct?: boolean }>(res);
}

export async function deleteStorageObject(
  bucketId: string,
  key: string,
  isPrefix = false,
): Promise<void> {
  const recursive = isPrefix || key.endsWith('/');
  const params = new URLSearchParams({ key, isPrefix: recursive ? '1' : '0' });
  const res = await apiFetch(`/storages/${bucketId}/object?${params}`, { method: 'DELETE' });
  await parseJson<{ ok: boolean; objectCount?: number }>(res);
}

export async function moveStorageObject(
  bucketId: string,
  key: string,
  targetKey: string,
  isPrefix = false,
): Promise<void> {
  const res = await apiFetch(`/storages/${bucketId}/object/move`, {
    method: 'POST',
    body: JSON.stringify({ key, targetKey, isPrefix }),
  });
  await parseJson<{ ok: boolean }>(res);
}

export async function setObjectPublic(
  bucketId: string,
  key: string,
  isPrefix = false,
): Promise<void> {
  // Directories always recurse under the prefix (including nested keys).
  const recursive = isPrefix || key.endsWith('/');
  const res = await apiFetch(`/storages/${bucketId}/object/public`, {
    method: 'POST',
    body: JSON.stringify({ key, isPrefix: recursive }),
  });
  await parseJson<{ ok: boolean; objectCount?: number }>(res);
}

export async function setObjectPrivate(
  bucketId: string,
  key: string,
  isPrefix = false,
): Promise<void> {
  const recursive = isPrefix || key.endsWith('/');
  const res = await apiFetch(`/storages/${bucketId}/object/private`, {
    method: 'POST',
    body: JSON.stringify({ key, isPrefix: recursive }),
  });
  await parseJson<{ ok: boolean; objectCount?: number }>(res);
}

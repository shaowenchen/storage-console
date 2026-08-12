import type { Storage } from '../../features/storages/types';

export function normalizeRelativePath(path = ''): string {
  return String(path)
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

export function uploadTargetPath(
  bucket: Pick<Storage, 'name' | 'bucketPath'> | null | undefined,
  relativePath = '',
): string {
  if (!bucket) return 'Choose a storage';
  const path = [bucket.bucketPath, relativePath]
    .map((part) => String(part || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return path ? `${bucket.name}/${path}` : bucket.name;
}

export function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

export function uploadRunCommand(endpoint: string, uploadKey: string): string {
  return `export STORAGE_CONSOLE_UPLOAD_KEY=${shellQuote(uploadKey)} && curl -fsSL -H "X-API-Key: $STORAGE_CONSOLE_UPLOAD_KEY" ${shellQuote(endpoint)} | bash`;
}

export function downloadRunCommand(endpoint: string, downloadKey: string): string {
  return `export STORAGE_CONSOLE_DOWNLOAD_KEY=${shellQuote(downloadKey)} && curl -fsSL -H "X-API-Key: $STORAGE_CONSOLE_DOWNLOAD_KEY" ${shellQuote(endpoint)} | bash`;
}

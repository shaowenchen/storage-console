import type { Storage } from '../../features/storages/types';

export function normalizeRelativePath(path = ''): string {
  return String(path)
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

export function uploadTargetPath(
  bucket: Pick<Storage, 'name' | 'bucketName' | 'bucketPath'> | null | undefined,
  relativePath = '',
): string {
  if (!bucket) return 'Choose a storage';
  const path = [bucket.bucketPath, relativePath]
    .map((part) => String(part || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `${bucket.name} - ${bucket.bucketName}${path ? `/${path}` : ''}`;
}

export function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

export function uploadRunCommand(endpoint: string, uploadKey: string): string {
  return `export STORAGE_CONSOLE_UPLOAD_KEY=${shellQuote(uploadKey)} && curl -fsSL -H "X-API-Key: $STORAGE_CONSOLE_UPLOAD_KEY" ${shellQuote(endpoint)} | bash`;
}

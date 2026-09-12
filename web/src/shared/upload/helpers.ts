import type { Storage } from '../../features/storages/types';
import { formatSize } from '../format';
import type { UploadLimits } from './types';

export function normalizeRelativePath(path = ''): string {
  return String(path)
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Describe an oversized file and the limit it broke.
 *
 * A file of 1 GB + 1 byte and a 1 GB limit both render as "1.00 GB", giving the
 * useless message "1.00 GB, over the 1.00 GB limit" — and extra decimals only
 * trade that for "1.000 GB over 1.00 GB", still indistinguishable at a glance.
 * When the rounded forms collide, both sides fall back to the exact byte counts
 * the server actually compares; otherwise the readable units are kept.
 */
function describeSizeLimit(actual: number, limit: number): string {
  const actualText = formatSize(actual);
  const limitText = formatSize(limit);
  if (actualText !== limitText) {
    return `${actualText}, over the ${limitText} per-file limit`;
  }
  return `${actual} bytes, over the ${limit} byte per-file limit`;
}

/**
 * Check a selection against the server's limits before any bytes are sent.
 *
 * The file count matters most: it is only enforced when the batch is finalized,
 * so without this check every file would be uploaded to the bucket and the batch
 * would still fail as a whole — worse than refusing it up front.
 *
 * Returns null when the selection is acceptable.
 */
export function validateUploadSelection(files: File[], limits: UploadLimits | null): string | null {
  if (!files.length) return 'Choose at least one file';
  if (!limits) return null;

  if (limits.maxFiles > 0 && files.length > limits.maxFiles) {
    return `Too many files: ${files.length} selected, but at most ${limits.maxFiles} can be uploaded at once`;
  }

  if (limits.maxBytes > 0) {
    const oversized = files.filter((file) => file.size > limits.maxBytes);
    if (oversized.length) {
      const [first] = oversized;
      if (!first) return null;
      const extra = oversized.length > 1 ? ` (and ${oversized.length - 1} more)` : '';
      return `"${first.name}" is ${describeSizeLimit(first.size, limits.maxBytes)}${extra}`;
    }
  }

  return null;
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
  return [
    `export STORAGE_CONSOLE_UPLOAD_KEY=${shellQuote(uploadKey)}`,
    `curl -fsSL -H "X-API-Key: $STORAGE_CONSOLE_UPLOAD_KEY" ${shellQuote(endpoint)} | bash`,
  ].join('\n');
}

export function downloadRunCommand(endpoint: string, downloadKey: string): string {
  return [
    `export STORAGE_CONSOLE_DOWNLOAD_KEY=${shellQuote(downloadKey)}`,
    `curl -fsSL -H "X-API-Key: $STORAGE_CONSOLE_DOWNLOAD_KEY" ${shellQuote(endpoint)} | bash`,
  ].join('\n');
}

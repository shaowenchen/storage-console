export function formatSize(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(value?: number): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

export function objectRelativePath(bucketPath = '', key = ''): string {
  const base = String(bucketPath).replace(/^\/+|\/+$/g, '');
  if (base && key.startsWith(`${base}/`)) return key.slice(base.length + 1);
  return key.replace(/^\/+/, '');
}

export function objectAbsoluteKey(bucketPath = '', relativePath = ''): string {
  return [bucketPath, relativePath]
    .map((part) => String(part || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(input);
    return ok;
  }
}

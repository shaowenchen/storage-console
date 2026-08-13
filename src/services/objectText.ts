export const MAX_OBJECT_TEXT_BYTES = 1_048_576;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'xml',
  'csv',
  'tsv',
  'log',
  'env',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'hh',
  'sh',
  'bash',
  'zsh',
  'toml',
  'ini',
  'cfg',
  'conf',
  'sql',
  'graphql',
  'gql',
  'gitignore',
  'dockerignore',
  'editorconfig',
  'properties',
  'plist',
  'svg',
  'r',
  'php',
  'lua',
  'pl',
  'pm',
  'dart',
  'scala',
  'clj',
  'ex',
  'exs',
  'erl',
  'hs',
  'tf',
  'hcl',
  'proto',
  'dockerfile',
  'makefile',
  'cmake',
  'gradle',
  'pom',
]);

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  log: 'text/plain',
  env: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  toml: 'application/toml',
  svg: 'image/svg+xml',
  sql: 'application/sql',
  graphql: 'application/graphql',
  gql: 'application/graphql',
};

function extensionOf(keyOrName: string): string {
  const base = keyOrName.split('/').filter(Boolean).pop() || keyOrName;
  if (!base.includes('.')) {
    const lower = base.toLowerCase();
    if (lower === 'dockerfile' || lower === 'makefile' || lower === 'jenkinsfile') return lower;
    return '';
  }
  return base.split('.').pop()?.toLowerCase() || '';
}

export function looksLikeTextObjectKey(keyOrName: string): boolean {
  const ext = extensionOf(keyOrName);
  if (!ext) return false;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Dotfiles like `.env`, `.gitignore`
  const base = (keyOrName.split('/').filter(Boolean).pop() || '').toLowerCase();
  if (base.startsWith('.') && TEXT_EXTENSIONS.has(base.slice(1))) return true;
  return false;
}

export function isTextContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  return (
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/ecmascript' ||
    mime === 'application/typescript' ||
    mime === 'application/yaml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/toml' ||
    mime === 'application/sql' ||
    mime === 'application/graphql' ||
    mime === 'application/x-sh' ||
    mime === 'application/x-httpd-php' ||
    mime === 'image/svg+xml'
  );
}

export function isEditableTextObject(options: {
  key: string;
  contentType?: string | null;
}): boolean {
  return looksLikeTextObjectKey(options.key) || isTextContentType(options.contentType);
}

export function guessTextContentType(key: string): string {
  const ext = extensionOf(key);
  return EXTENSION_CONTENT_TYPES[ext] || 'text/plain; charset=utf-8';
}

export type ObjectTextGateFailure =
  | { ok: false; reason: 'too_large'; maxBytes: number; size: number }
  | { ok: false; reason: 'not_text'; contentType: string | null }
  | { ok: true; size: number; contentType: string | null };

export function gateObjectTextAccess(options: {
  key: string;
  contentLength?: number | null;
  contentType?: string | null;
}): ObjectTextGateFailure {
  const size = options.contentLength ?? 0;
  if (size > MAX_OBJECT_TEXT_BYTES) {
    return { ok: false, reason: 'too_large', maxBytes: MAX_OBJECT_TEXT_BYTES, size };
  }
  if (!isEditableTextObject({ key: options.key, contentType: options.contentType })) {
    return { ok: false, reason: 'not_text', contentType: options.contentType ?? null };
  }
  return { ok: true, size, contentType: options.contentType ?? null };
}

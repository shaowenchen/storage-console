const DEFAULT_MAX_UPLOAD_MB = 500;

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const DOWNLOAD_LINK_EXPIRES_SECONDS = 2 * 60 * 60;
export const UPLOAD_LINK_EXPIRES_SECONDS = 2 * 60 * 60;
export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_BYTES = numberFromEnv('MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
export const S3_CONCURRENCY = 8;

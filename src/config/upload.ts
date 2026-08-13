const DEFAULT_MAX_UPLOAD_MB = 500;
const DEFAULT_DIRECT_EXPIRES_SECONDS = 900;

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Presigned GET TTL. */
export const DOWNLOAD_LINK_EXPIRES_SECONDS = numberFromEnv(
  'S3_DIRECT_DOWNLOAD_EXPIRES_SECONDS',
  numberFromEnv('S3_DIRECT_UPLOAD_EXPIRES_SECONDS', DEFAULT_DIRECT_EXPIRES_SECONDS),
);

/** Presigned PUT TTL. */
export const UPLOAD_LINK_EXPIRES_SECONDS = numberFromEnv(
  'S3_DIRECT_UPLOAD_EXPIRES_SECONDS',
  DEFAULT_DIRECT_EXPIRES_SECONDS,
);

export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_BYTES = numberFromEnv('MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
export const S3_CONCURRENCY = 8;

/** Exclude SDK checksum headers from the signature (KS3 / compatible stores). */
export const S3_PRESIGN_UNSIGNABLE_HEADERS = new Set([
  'x-amz-checksum-crc32',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-sha1',
  'x-amz-checksum-sha256',
  'x-amz-sdk-checksum-algorithm',
]);

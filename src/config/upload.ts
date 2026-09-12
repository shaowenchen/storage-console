const DEFAULT_MAX_UPLOAD_MB = 1024;
const DEFAULT_DIRECT_EXPIRES_SECONDS = 900;

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Like {@link numberFromEnv}, but 0 is a real setting rather than "unset".
 *
 * A queue length of 0 meaningfully says "never wait, refuse instead", which is
 * the opposite of the fallback — so it cannot share a parser that treats 0 as
 * absent.
 */
export function maxQueuedUploadsFromEnv(raw: string | undefined, fallback = 16): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
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

/**
 * Browser upload PUTs processed at once, and how many more may wait.
 *
 * PutObject streams the request body to the bucket rather than buffering it, so
 * this bound is not about holding whole files. It is about what a client can
 * make the process do: without it, in-flight uploads are whatever the browser
 * decides to open, and the bucket client's connection pool and transient heap
 * both scale with that. Bounding it makes memory a function of configuration.
 *
 * The queue absorbs a client that briefly overshoots, so it waits for a slot
 * instead of being refused and paying a backoff round trip.
 */
export const MAX_CONCURRENT_UPLOADS = numberFromEnv('MAX_CONCURRENT_UPLOADS', 4);
export const MAX_QUEUED_UPLOADS = maxQueuedUploadsFromEnv(process.env.MAX_QUEUED_UPLOADS);

/** Exclude SDK checksum headers from the signature (KS3 / compatible stores). */
export const S3_PRESIGN_UNSIGNABLE_HEADERS = new Set([
  'x-amz-checksum-crc32',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-sha1',
  'x-amz-checksum-sha256',
  'x-amz-sdk-checksum-algorithm',
]);

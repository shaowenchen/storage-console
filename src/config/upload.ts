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

/**
 * How long a connection to the bucket may take to establish.
 *
 * The SDK's own default is no timeout at all. A host that accepts the packet
 * and never completes the handshake then parks the operation forever.
 */
export const S3_CONNECT_TIMEOUT_MS = numberFromEnv('S3_CONNECT_TIMEOUT_SECONDS', 10) * 1000;

/**
 * How long a bucket connection may sit idle before its request is failed.
 *
 * This is the one that matters most. Measured in inactivity rather than total
 * duration, so a large object on a slow link is not punished for taking a long
 * time — only for going quiet.
 *
 * Without it a stalled storage is not merely slow, it is terminal for the
 * transfer: the upload proxy feeds its PutObject from the browser's request
 * body, so a request that never returns means the body stops being read, the
 * browser's socket buffers fill, and the upload sits at a fixed byte offset
 * with no error and no timeout, forever. The bytes already sent make it look
 * like progress stopped rather than failed.
 *
 * The default is deliberately generous because a storage can legitimately go
 * quiet for a while — reassembling a multipart upload, or copying a large
 * object server-side, produces no traffic until it is done. Lower it if a
 * stalled transfer should surface faster than this.
 */
export const S3_SOCKET_TIMEOUT_MS = numberFromEnv('S3_SOCKET_TIMEOUT_SECONDS', 120) * 1000;

/**
 * Absolute ceiling on one bucket request, counting the whole transfer.
 *
 * Unlike the socket timeout this does penalise a genuinely slow link, so it is
 * set well past any transfer this console should be asked to perform. Its job is
 * to bound the unbounded, not to police throughput.
 */
export const S3_REQUEST_TIMEOUT_MS = numberFromEnv('S3_REQUEST_TIMEOUT_SECONDS', 3600) * 1000;

/** Exclude SDK checksum headers from the signature (KS3 / compatible stores). */
export const S3_PRESIGN_UNSIGNABLE_HEADERS = new Set([
  'x-amz-checksum-crc32',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-sha1',
  'x-amz-checksum-sha256',
  'x-amz-sdk-checksum-algorithm',
]);

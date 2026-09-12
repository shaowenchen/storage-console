const DEFAULT_MAX_UPLOAD_MB = 1024;const DEFAULT_DIRECT_EXPIRES_SECONDS = 900;

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
 * Size of one piece of a browser upload.
 *
 * This number is the whole point of the chunked upload path, so it is worth
 * stating what it is defending against. The browser used to PUT the entire file
 * through the app in a single request. Every hop in front of the app then has to
 * accept that whole body within its own patience, and a request-body window is
 * something essentially every reverse proxy, load balancer and ingress imposes
 * — the typical figure is a few minutes, measured from the first byte.
 *
 * A 1 GB body required a sustained 28.6 Mbps to finish inside five minutes, so a
 * slower upstream was not merely slow — it was cut off, surfacing as an opaque
 * 502 that no amount of server-side timeout or retry tuning could prevent. At
 * 8 MB a single request needs 0.22 Mbps to finish inside that same window,
 * leaving roughly two orders of magnitude of headroom, and a retry re-sends one
 * piece instead of the whole file.
 *
 * The default sits just above S3's 5 MB minimum for a non-final part, so the
 * part count stays low (a 1 GB object is 128 requests, against S3's 10000-part
 * ceiling) without making any single request large enough to matter again.
 */
export const UPLOAD_PART_SIZE_BYTES = numberFromEnv('UPLOAD_PART_MB', 8) * 1024 * 1024;

/**
 * The request-body window this deployment should assume, in seconds.
 *
 * Only used to sanity-check that the part size leaves enough headroom to be
 * worth having — see the assertion in `upload.test.ts`. The default matches the
 * most common proxy behaviour (a few minutes); raise it if the proxies in front
 * of this service are known to be more patient, and lower it if they are
 * stricter.
 */
export const ASSUMED_PROXY_BODY_WINDOW_SECONDS = numberFromEnv(
  'PROXY_BODY_WINDOW_SECONDS',
  5 * 60,
);

/**
 * Smallest a non-final part may be, per S3.
 *
 * Enforced here rather than left to the storage so a misbehaving client gets a
 * clear rejection at the offending part instead of an `EntityTooSmall` at
 * completion, after every other part has already been uploaded.
 */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;

/** S3's hard ceiling on parts per multipart upload. */
export const UPLOAD_MAX_PARTS = 10000;

/**
 * How long an unfinished multipart upload is kept before it is cleaned up.
 *
 * A multipart upload holds its uploaded parts in the bucket, invisible to
 * listing, until it is completed or aborted — so an abandoned one costs storage
 * indefinitely. The registry sweeps entries older than this and aborts them.
 *
 * Generous because the upload is only abandoned in the registry's view: a client
 * that is still slowly sending parts should not have the upload pulled out from
 * under it between two of them.
 */
export const UPLOAD_SESSION_TTL_MS =
  numberFromEnv('UPLOAD_SESSION_TTL_HOURS', 24) * 60 * 60 * 1000;

/**
 * Lifetime of a presigned per-part URL, in seconds.
 *
 * Short on purpose, because it costs nothing to be: a URL is minted as its part
 * is about to be sent, so the file's total duration never has to fit inside this
 * window. Keeping it brief bounds how long a leaked URL stays usable.
 */
export const UPLOAD_PART_URL_EXPIRES_SECONDS = numberFromEnv(
  'UPLOAD_PART_URL_EXPIRES_SECONDS',
  900,
);

/**
 * How long a spooled part may sit before a later process may delete it.
 *
 * Cleanup is belt-and-braces: a live process removes its own files on every
 * path, and this is what reclaims the files of a process that was killed
 * outright. Generous, because deleting a file another instance is still writing
 * would be far worse than leaving it a little longer.
 */
export const UPLOAD_SPOOL_TTL_MS =
  numberFromEnv('UPLOAD_SPOOL_TTL_MINUTES', 60) * 60 * 1000;

/**
 * Attempts, per part, to get the bytes into the storage.
 *
 * The server can retry on its own here — and this is the point of spooling —
 * because the part is on disk and re-readable. A transient storage failure then
 * costs a little time rather than a round trip back to the browser.
 */
export const UPLOAD_PART_UPLOAD_ATTEMPTS = numberFromEnv('UPLOAD_PART_UPLOAD_ATTEMPTS', 4);

/**
 * Longest this service may spend on one part before it gives up.
 *
 * The browser needs to know this and be more patient than it. A client timeout
 * shorter than the server's budget is worse than useless: it abandons the
 * request while the server is still retrying, so the server's retries are never
 * seen, the part is re-sent from scratch, and the client's own retry budget is
 * spent on a part that was about to succeed. That is exactly what happened with
 * a 60 s client timeout against this budget — five client attempts, ~300 s, all
 * of them cut short and the upload abandoned at 5 minutes with the storage
 * untouched.
 *
 * Derived from the real settings rather than written down as a second number,
 * so changing the socket timeout or the attempt count cannot leave the client
 * cutting the server off mid-retry.
 */
export function partUploadBudgetMs(): number {
  const attempts = UPLOAD_PART_UPLOAD_ATTEMPTS;
  // The backoff this service sleeps between attempts: 500ms, 1s, 2s, ...
  let backoffMs = 0;
  for (let attempt = 0; attempt < attempts - 1; attempt++) {
    backoffMs += Math.min(500 * 2 ** attempt, 5000);
  }
  return attempts * S3_SOCKET_TIMEOUT_MS + backoffMs;
}

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
 * Part request bodies processed at once, and how many more may wait.
 *
 * Deliberately separate from, and much larger than, {@link MAX_CONCURRENT_UPLOADS}.
 * That gate was sized for whole-file transfers, where one request could be
 * streaming a gigabyte through the process; a part is a bounded 8 MB that is
 * finished in seconds. Keeping them on one small gate would mean a single
 * browser — which opens a few parts in parallel by design — spending the entire
 * allowance and starving every other uploader, so the bound that exists to be
 * fair would be the thing enforcing unfairness.
 *
 * Sized so several files can be in flight at once while the process still does a
 * bounded amount of work: a client sends a few parts per file, so this admits
 * roughly five concurrent uploaders before the queue absorbs the rest.
 */
export const MAX_CONCURRENT_UPLOAD_PARTS = numberFromEnv('MAX_CONCURRENT_UPLOAD_PARTS', 16);
export const MAX_QUEUED_UPLOAD_PARTS = numberFromEnv('MAX_QUEUED_UPLOAD_PARTS', 32);

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

import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  type CORSRule,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Bucket } from '../db/store.js';
import { getS3Client, bucketLogMeta } from './s3.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('s3-cors');

/**
 * Cross-origin access for the bucket, so the browser can upload straight to it.
 *
 * Sending bytes through this service means they travel the whole way here and
 * then all the way back out to the bucket, and the storage is often in a
 * different region from the console — a round trip that is slow for a large file
 * and fragile for any of them. A presigned URL lets the browser talk to the
 * bucket directly, which removes this service from the data path entirely.
 *
 * That only works if the bucket allows the console's origin, which is what this
 * module arranges.
 */

/** The methods a browser needs to complete a multipart upload directly. */
const UPLOAD_METHODS = ['PUT', 'GET', 'HEAD'];

/**
 * Headers the browser must be able to *read* off the response.
 *
 * `ETag` is the one that matters and the one that is easy to miss: completion
 * needs every part's ETag, and a cross-origin response's headers are invisible
 * to JavaScript unless they are named here. Without it each part uploads
 * successfully and the upload then fails with no usable parts to submit.
 */
const EXPOSED_HEADERS = ['ETag'];

/** Headers the browser sends on a part PUT. */
const ALLOWED_HEADERS = ['*'];

/**
 * Buckets whose CORS is known to permit a given origin.
 *
 * Keyed by origin as well as bucket: a console reachable at more than one
 * hostname is a different origin each time, and remembering only the bucket
 * would report a second origin as already covered — sending its browser to a
 * bucket that has never heard of it, where every part would fail CORS.
 */
const configured = new Set<string>();

function cacheKey(bucketId: string, origin: string): string {
  return `${bucketId}|${origin}`;
}

/** The origin browsers will upload from; unset means "derive from the request". */
function configuredOrigin(): string {
  return (process.env.UPLOAD_CORS_ORIGIN || '').trim();
}

/**
 * Whether an origin may be written into the bucket's CORS policy.
 *
 * This value comes from a request header, and it ends up in bucket
 * configuration, so it is checked rather than trusted: a malformed or
 * open-ended value (a bare `*` in particular, which would let any site on the
 * internet drive uploads with a signed URL) is refused. Only a real scheme and
 * host is accepted.
 */
export function isAcceptableOrigin(origin: string): boolean {
  const value = origin.trim();
  if (!value || value === '*') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Credentials or a path mean this is not a plain origin.
    if (url.username || url.password) return false;
    if (url.pathname !== '/' && url.pathname !== '') return false;
    if (url.search || url.hash) return false;
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** The origin header of a request, if it is one we are willing to record. */
export function originFromRequest(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers['origin'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return isAcceptableOrigin(value) ? value.trim().replace(/\/+$/, '') : null;
}

/** Whether an existing rule already grants `origin` the methods uploads need. */
function ruleCoversOrigin(rule: CORSRule, origin: string): boolean {
  const origins = rule.AllowedOrigins ?? [];
  const matches = origins.some((allowed) => allowed === '*' || allowed === origin);
  if (!matches) return false;

  const methods = rule.AllowedMethods ?? [];
  const hasMethods = UPLOAD_METHODS.every((method) => methods.includes(method));
  if (!hasMethods) return false;

  // A rule that already exposes ETag is fine as-is; one that does not must be
  // replaced rather than added alongside, or the browser still cannot read it.
  const exposed = rule.ExposeHeaders ?? [];
  return EXPOSED_HEADERS.every((header) => exposed.includes(header));
}

/** The rule this console needs, expressed against one origin. */
function ruleFor(origin: string): CORSRule {
  return {
    AllowedOrigins: [origin],
    AllowedMethods: UPLOAD_METHODS,
    AllowedHeaders: ALLOWED_HEADERS,
    ExposeHeaders: EXPOSED_HEADERS,
    MaxAgeSeconds: 3000,
  };
}

export type CorsSetupResult = { ok: true } | { ok: false; reason: string };

/**
 * Make sure the bucket permits direct uploads from `origin`.
 *
 * Existing rules are preserved: a bucket may serve other applications, and
 * replacing the whole policy would break them. A rule that already covers the
 * origin is left alone, and one that covers the origin but does not expose
 * `ETag` is replaced, since it would let parts upload and then fail at
 * completion.
 *
 * Failure is reported rather than thrown. Direct upload is an optimisation over
 * the proxy path, so a bucket that refuses CORS changes only how bytes travel —
 * it should not be able to fail the upload.
 */
export async function ensureBucketCors(
  client: S3Client,
  bucket: Bucket,
  origin: string,
): Promise<CorsSetupResult> {
  if (configured.has(cacheKey(bucket.id, origin))) return { ok: true };

  if (!isAcceptableOrigin(origin)) {
    return { ok: false, reason: `Not a usable origin: ${origin || '(empty)'}` };
  }

  let existing: CORSRule[];
  try {
    const current = await client.send(
      new GetBucketCorsCommand({ Bucket: bucket.bucketName }),
    );
    existing = current.CORSRules ?? [];
  } catch (err: unknown) {
    // A bucket with no policy answers with an error rather than an empty list.
    // Treated as "no rules", which is the state we are about to fix — but any
    // other failure (no permission to read CORS in particular) means we cannot
    // safely rewrite the policy, because we would be clobbering rules we cannot
    // see.
    if (!isNoSuchCorsError(err)) {
      return {
        ok: false,
        reason: `Cannot read the bucket's CORS configuration: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    existing = [];
  }

  if (existing.some((rule) => ruleCoversOrigin(rule, origin))) {
    configured.add(cacheKey(bucket.id, origin));
    log.debug('Bucket CORS already permits this origin', { ...bucketLogMeta(bucket), origin });
    return { ok: true };
  }

  // Drop a rule for this origin that is missing the exposed ETag, so the
  // replacement does not sit alongside a rule the browser will match first.
  const kept = existing.filter(
    (rule) => !(rule.AllowedOrigins ?? []).includes(origin),
  );

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket.bucketName,
        CORSConfiguration: { CORSRules: [...kept, ruleFor(origin)] },
      }),
    );
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `Cannot update the bucket's CORS configuration: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  configured.add(cacheKey(bucket.id, origin));
  log.info('Configured bucket CORS for direct browser uploads', {
    ...bucketLogMeta(bucket),
    origin,
    replacedRules: existing.length - kept.length,
    keptRules: kept.length,
  });
  return { ok: true };
}

/** Whether the storage reports that the bucket has no CORS policy at all. */
function isNoSuchCorsError(err: unknown): boolean {
  const code = String((err as { Code?: unknown })?.Code ?? (err as { code?: unknown })?.code ?? '');
  const name = String((err as { name?: unknown })?.name ?? '');
  if (code === 'NoSuchCORSConfiguration' || name === 'NoSuchCORSConfiguration') return true;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } })?.$metadata?.httpStatusCode;
  // Some S3-compatible stores answer 404 for a bucket with no policy, which is
  // indistinguishable from "no policy" for our purposes.
  return status === 404;
}

/**
 * Whether direct uploads should be offered for this bucket.
 *
 * The origin is taken from configuration when set, so a deployment can pin it
 * rather than depend on whatever header arrives; otherwise the request's own
 * Origin is used, which is correct for a console reached at several hostnames.
 */
export async function prepareDirectUpload(
  bucket: Bucket,
  headers: Record<string, string | string[] | undefined>,
): Promise<CorsSetupResult> {
  const origin = configuredOrigin() || originFromRequest(headers);
  if (!origin) {
    return { ok: false, reason: 'No usable Origin for direct upload' };
  }
  return ensureBucketCors(getS3Client(bucket), bucket, origin);
}

/** Forget cached CORS results. Tests only — the cache is process-global. */
export function resetCorsCacheForTests(): void {
  configured.clear();
}

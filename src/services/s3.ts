import { createHash } from 'crypto';
import {
  CopyObjectCommand,
  GetObjectAclCommand,
  PutObjectAclCommand,
  S3Client,
  type Grant,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from '@aws-sdk/client-s3';
import type { BuildMiddleware } from '@smithy/types';
import { type Bucket } from '../db/store.js';
import { createLogger, redactUrl } from '../utils/logger.js';

const log = createLogger('s3');
const s3Clients = new Map<string, S3Client>();

function objectProp(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return prop && typeof prop === 'object' ? (prop as Record<string, unknown>) : undefined;
}

function stringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' && prop.trim() ? prop : undefined;
}

function numberProp(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'number' ? prop : undefined;
}

export function normalizeS3Endpoint(value: string): string {
  const trimmed = String(value || '')
    .trim()
    .replace(/\/+$/g, '');
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function normalizeS3Region(value: string, _endpoint: string): string {
  const trimmed = String(value || '').trim();
  return trimmed || 'us-east-1';
}

export function shouldForcePathStyle(endpoint: string): boolean {
  try {
    const hostname = new URL(normalizeS3Endpoint(endpoint)).hostname;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
    if (/^\[[0-9a-f:]+\]$/i.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

export function normalizeBucketPath(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

export function bucketObjectKey(bucket: Bucket, ...parts: string[]): string {
  return [normalizeBucketPath(bucket.bucketPath), ...parts]
    .map((part) => String(part || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function bucketListPrefix(bucket: Bucket): string {
  const path = normalizeBucketPath(bucket.bucketPath);
  return path ? `${path}/` : '';
}

export function relativeObjectKey(bucket: Bucket, key: string): string {
  const basePrefix = bucketListPrefix(bucket);
  return basePrefix && key.startsWith(basePrefix) ? key.slice(basePrefix.length) : key;
}

export function objectDisplayName(key: string): string {
  const parts = key.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || key;
  return last.trim();
}

/**
 * Content-Disposition for S3 ResponseContentDisposition (query-encoded on the
 * signed URL). Use a single filename parameter — emitting both `filename=` and
 * `filename*` causes some providers/browsers to save names like
 * `file.sh%3B filename%3DUTF-8%27%27file.sh`.
 */
export function attachmentContentDisposition(filename: string): string {
  const trimmed = filename.trim() || 'download';
  const sanitized = trimmed.replace(/[\r\n\\"]/g, '_');

  // Printable ASCII without ';': quoted filename is enough and downloads cleanly.
  if (/^[\x20-\x7E]+$/.test(sanitized) && !sanitized.includes(';')) {
    return `attachment; filename="${sanitized}"`;
  }

  // Non-ASCII / special: RFC 5987 only (no companion filename=).
  return `attachment; filename*=UTF-8''${encodeURIComponent(sanitized)}`;
}

export function encodeS3Key(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function s3CopySource(bucketName: string, key: string): string {
  return `${bucketName}/${encodeS3Key(key)}`;
}

export function publicObjectUrl(bucket: Bucket, key: string): string {
  const url = new URL(normalizeS3Endpoint(bucket.endpoint));
  if (shouldForcePathStyle(bucket.endpoint)) {
    url.pathname = `/${bucket.bucketName}/${encodeS3Key(key)}`;
  } else {
    url.hostname = `${bucket.bucketName}.${url.hostname}`;
    url.pathname = `/${encodeS3Key(key)}`;
  }
  return url.toString();
}

export function bucketLogMeta(bucket: Bucket): Record<string, unknown> {
  return {
    bucketId: bucket.id,
    displayName: bucket.name,
    endpoint: redactUrl(normalizeS3Endpoint(bucket.endpoint)),
    region: normalizeS3Region(bucket.region, bucket.endpoint),
    forcePathStyle: shouldForcePathStyle(bucket.endpoint),
    bucketName: bucket.bucketName,
    bucketPath: bucket.bucketPath,
    accessKeyLength: bucket.accessKey.length,
    accessKeyFingerprint: createHash('sha256').update(bucket.accessKey).digest('hex').slice(0, 12),
  };
}

export function s3ErrorLogMeta(err: unknown): Record<string, unknown> {
  const metadata = objectProp(err, '$metadata');
  const cause = objectProp(err, 'cause');
  return {
    name: stringProp(err, 'name'),
    code: stringProp(err, 'Code') || stringProp(err, 'code'),
    message: stringProp(err, 'message'),
    httpStatusCode: numberProp(metadata, 'httpStatusCode'),
    requestId: stringProp(metadata, 'requestId'),
    extendedRequestId: stringProp(metadata, 'extendedRequestId'),
    attempts: numberProp(metadata, 'attempts'),
    totalRetryDelay: numberProp(metadata, 'totalRetryDelay'),
    causeCode: stringProp(cause, 'code'),
    causeMessage: stringProp(cause, 'message'),
  };
}

function inferS3ErrorMessage(err: unknown): string {
  const metadata = objectProp(err, '$metadata');
  const status = numberProp(metadata, 'httpStatusCode');
  const name = stringProp(err, 'name');
  const code = stringProp(err, 'Code') || stringProp(err, 'code') || name;
  const message = stringProp(err, 'message');
  const cause = objectProp(err, 'cause');
  const causeCode = stringProp(cause, 'code');

  if (causeCode === 'ENOTFOUND') return 'Cannot connect: endpoint host could not be resolved';
  if (causeCode === 'ECONNREFUSED') return 'Cannot connect: endpoint refused the connection';
  if (causeCode === 'ETIMEDOUT' || causeCode === 'ECONNRESET')
    return 'Cannot connect: network connection timed out or was reset';
  if (code === 'SecondLevelDomainForbidden') {
    return 'Cannot connect: endpoint requires virtual-host style bucket addressing';
  }
  if (
    status === 403 ||
    code === 'AccessDenied' ||
    code === 'InvalidAccessKeyId' ||
    code === 'SignatureDoesNotMatch'
  ) {
    return 'Cannot connect: access denied or credentials are invalid';
  }
  if (status === 404 || code === 'NoSuchBucket' || code === 'NotFound')
    return 'Cannot connect: storage does not exist or is not accessible';
  if (status === 301 || code === 'PermanentRedirect')
    return 'Cannot connect: storage region or endpoint is incorrect';
  if (status === 400)
    return 'Cannot connect: S3 rejected the request, check endpoint, region, and storage name';

  if (message && message !== 'UnknownError') return message;
  if (code && code !== 'UnknownError') return code;
  if (status) return `S3 returned HTTP ${status}`;
  return 'Unknown S3 error';
}

export function s3ErrorHttpStatus(err: unknown): number {
  const metadata = objectProp(err, '$metadata');
  const status = numberProp(metadata, 'httpStatusCode');
  if (status && status >= 400 && status < 600) return status;
  return 502;
}

export function formatS3RequestError(
  err: unknown,
  bucket: Bucket,
): { message: string; details: string[]; status: number } {
  const metadata = objectProp(err, '$metadata');
  const httpStatus = numberProp(metadata, 'httpStatusCode');
  const requestId = stringProp(metadata, 'requestId') || stringProp(metadata, 'extendedRequestId');
  const name = stringProp(err, 'name');
  const code = stringProp(err, 'Code') || stringProp(err, 'code') || name;
  const sdkMessage = stringProp(err, 'message');
  const cause = objectProp(err, 'cause');
  const causeCode = stringProp(cause, 'code');
  const causeMessage = stringProp(cause, 'message');

  const details = [
    `Endpoint: ${bucket.endpoint}`,
    `Storage: ${bucket.bucketName}`,
    `Storage path: ${normalizeBucketPath(bucket.bucketPath) || '(root)'}`,
    `Configured region: ${bucket.region || '(empty)'}`,
    `Signing region: ${normalizeS3Region(bucket.region, bucket.endpoint)}`,
    `Addressing style: ${shouldForcePathStyle(bucket.endpoint) ? 'path-style' : 'virtual-host'}`,
    `Access key length: ${bucket.accessKey.trim().length}`,
    `Secret key length: ${bucket.secretKey.trim().length}`,
  ];

  if (httpStatus) details.push(`HTTP status: ${httpStatus}`);
  if (code) details.push(`Error code: ${code}`);
  if (sdkMessage && sdkMessage !== code) details.push(`SDK message: ${sdkMessage}`);
  if (requestId) details.push(`Request ID: ${requestId}`);
  if (causeCode || causeMessage)
    details.push(`Network cause: ${[causeCode, causeMessage].filter(Boolean).join(' - ')}`);

  const message =
    sdkMessage && sdkMessage !== 'UnknownError' ? sdkMessage : inferS3ErrorMessage(err);

  return { message, details, status: s3ErrorHttpStatus(err) };
}

export function createS3Client(bucket: Bucket): S3Client {
  const client = new S3Client({
    endpoint: normalizeS3Endpoint(bucket.endpoint),
    region: normalizeS3Region(bucket.region, bucket.endpoint),
    forcePathStyle: shouldForcePathStyle(bucket.endpoint),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: bucket.accessKey.trim(),
      secretAccessKey: bucket.secretKey.trim(),
    },
  });

  // KS3 and other S3-compatible providers require Content-MD5 on DeleteObjects.
  // Use build-step middleware (not addRelativeTo flexibleChecksumsMiddleware) so
  // commands like ListObjectsV2 still resolve when checksum middleware is omitted.
  // See: https://github.com/aws/aws-sdk-js-v3/issues/6920
  const md5Middleware: BuildMiddleware<ServiceInputTypes, ServiceOutputTypes> =
    (next, context) => async (args) => {
      if (context.commandName !== 'DeleteObjectsCommand') return next(args);
      const request = args.request as {
        headers?: Record<string, string>;
        body?: Uint8Array | string;
      };
      const headers = request.headers ?? {};
      request.headers = headers;
      Object.keys(headers).forEach((header) => {
        const lowerHeader = header.toLowerCase();
        if (
          lowerHeader.startsWith('x-amz-checksum-') ||
          lowerHeader.startsWith('x-amz-sdk-checksum-')
        ) {
          delete headers[header];
        }
      });
      if (request.body) {
        const bodyContent = Buffer.from(request.body);
        headers['Content-MD5'] = createHash('md5').update(bodyContent).digest('base64');
      }
      return next(args);
    };
  client.middlewareStack.add(md5Middleware, {
    step: 'build',
    name: 'addMD5ChecksumForDeleteObjects',
    tags: ['MD5_FALLBACK'],
  });

  return client;
}

function s3ClientCacheKey(bucket: Bucket): string {
  const credentialFingerprint = createHash('sha256')
    .update(`${bucket.accessKey.trim()}:${bucket.secretKey.trim()}`)
    .digest('hex')
    .slice(0, 16);
  return [
    bucket.id,
    normalizeS3Endpoint(bucket.endpoint),
    normalizeS3Region(bucket.region, bucket.endpoint),
    shouldForcePathStyle(bucket.endpoint) ? 'path' : 'virtual',
    credentialFingerprint,
  ].join('|');
}

export function getS3Client(bucket: Bucket): S3Client {
  const key = s3ClientCacheKey(bucket);
  if (!s3Clients.has(key)) {
    log.debug('Creating S3 client', bucketLogMeta(bucket));
    s3Clients.set(key, createS3Client(bucket));
  }
  return s3Clients.get(key)!;
}

export function clearS3Client(bucketId: string): void {
  for (const [key, client] of s3Clients) {
    if (!key.startsWith(`${bucketId}|`)) continue;
    client.destroy();
    s3Clients.delete(key);
    log.debug('Cleared cached S3 client', { bucketId });
  }
}

export function clearAllS3ClientsForTests(): void {
  for (const [key, client] of s3Clients) {
    client.destroy();
    s3Clients.delete(key);
    log.debug('Cleared cached S3 client', { cacheKey: key });
  }
}

export type ObjectAccessResult = {
  isPublic: boolean;
  /** False when the provider/bucket does not support object ACLs. */
  aclSupported: boolean;
  publicUrl?: string;
};

function grantUri(grant: Grant): string {
  return String(grant.Grantee?.URI || '');
}

function isPublicReadGrant(grant: Grant): boolean {
  const uri = grantUri(grant);
  // Match AWS + common S3-compatible AllUsers URIs (URI shape varies by provider).
  const isAllUsers =
    /AllUsers$/i.test(uri) || /groups\/global\/AllUsers/i.test(uri) || /\/AllUsers\b/i.test(uri);
  if (!isAllUsers) return false;
  const permission = String(grant.Permission || '');
  return permission === 'READ' || permission === 'FULL_CONTROL';
}

function isAclUnsupportedError(err: unknown): boolean {
  const code = String(
    stringProp(err, 'Code') || stringProp(err, 'code') || stringProp(err, 'name') || '',
  );
  const message = String(err instanceof Error ? err.message : err || '');
  const status = numberProp(objectProp(err, '$metadata'), 'httpStatusCode');
  return (
    status === 405 ||
    status === 501 ||
    /AccessControlListNotSupported|NotImplemented|MethodNotAllowed|InvalidRequest/i.test(code) ||
    /AccessControlListNotSupported|ACL.?s? (are )?disabled|does not (allow|support).{0,40}ACL/i.test(
      message,
    )
  );
}

/** Best-effort public/private probe via GetObjectAcl (lazy; not part of ListObjects). */
export async function resolveObjectAccess(
  client: S3Client,
  bucket: Bucket,
  key: string,
): Promise<ObjectAccessResult> {
  try {
    const acl = await client.send(
      new GetObjectAclCommand({
        Bucket: bucket.bucketName,
        Key: key,
      }),
    );
    const isPublic = (acl.Grants || []).some(isPublicReadGrant);
    return {
      isPublic,
      aclSupported: true,
      publicUrl: isPublic ? publicObjectUrl(bucket, key) : undefined,
    };
  } catch (err: unknown) {
    log.debug('Unable to read object ACL', {
      ...bucketLogMeta(bucket),
      key,
      ...s3ErrorLogMeta(err),
    });
    if (isAclUnsupportedError(err)) {
      return { isPublic: false, aclSupported: false };
    }
    return { isPublic: false, aclSupported: true };
  }
}

export async function isObjectPublic(
  client: S3Client,
  bucket: Bucket,
  key: string,
): Promise<boolean> {
  const access = await resolveObjectAccess(client, bucket, key);
  return access.isPublic;
}

/**
 * Set canned object ACL. Prefer PutObjectAcl; fall back to self-CopyObject with ACL
 * for providers that reject PutObjectAcl but accept ACL on copy.
 */
export async function setObjectCannedAcl(
  client: S3Client,
  bucket: Bucket,
  key: string,
  acl: 'public-read' | 'private',
): Promise<void> {
  try {
    await client.send(
      new PutObjectAclCommand({
        Bucket: bucket.bucketName,
        Key: key,
        ACL: acl,
      }),
    );
    return;
  } catch (err: unknown) {
    log.debug('PutObjectAcl failed; trying CopyObject ACL fallback', {
      ...bucketLogMeta(bucket),
      key,
      acl,
      ...s3ErrorLogMeta(err),
    });
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket.bucketName,
          Key: key,
          CopySource: s3CopySource(bucket.bucketName, key),
          ACL: acl,
          MetadataDirective: 'COPY',
        }),
      );
    } catch (copyErr: unknown) {
      log.warn('Failed to set object ACL via PutObjectAcl and CopyObject', {
        ...bucketLogMeta(bucket),
        key,
        acl,
        putError: s3ErrorLogMeta(err),
        copyError: s3ErrorLogMeta(copyErr),
      });
      throw err;
    }
  }
}

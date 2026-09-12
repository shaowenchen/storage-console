import { Router } from 'express';
import { createReadStream } from 'fs';
import { sendApiError } from '../domain/apiError.js';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  requireAdmin,
  requireAdminDownloadAuth,
  requireAdminUploadAuth,
} from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { mapWithConcurrency, createGate } from '../lib/concurrency.js';
import {
  DOWNLOAD_LINK_EXPIRES_SECONDS,
  MAX_CONCURRENT_UPLOAD_PARTS,
  MAX_CONCURRENT_UPLOADS,
  MAX_QUEUED_UPLOAD_PARTS,
  MAX_QUEUED_UPLOADS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  S3_CONCURRENCY,
  S3_PRESIGN_UNSIGNABLE_HEADERS,
  UPLOAD_LINK_EXPIRES_SECONDS,
  UPLOAD_MAX_PARTS,
  UPLOAD_PART_SIZE_BYTES,
  UPLOAD_PART_UPLOAD_ATTEMPTS,
} from '../config/upload.js';
import { createLogger } from '../utils/logger.js';
import { directDownloadShellScript } from '../services/downloadScript.js';
import {
  gateObjectTextAccess,
  guessTextContentType,
  looksLikeTextObjectKey,
  MAX_OBJECT_TEXT_BYTES,
} from '../services/objectText.js';
import { directUploadShellScript } from '../services/uploadScript.js';
import {
  createSessionToken,
  expectedPartLength,
  parseSessionToken,
  sessionPartCount,
} from '../services/multipartUpload.js';
import { withSpooled } from '../services/uploadSpool.js';
import {
  attachmentContentDisposition,
  bucketListPrefix,
  bucketLogMeta,
  bucketObjectKey,
  clearS3Client,
  createS3Client,
  formatS3RequestError,
  getS3Client,
  isObjectPublic,
  isRetryableS3Error,
  normalizeBucketPath,
  objectDisplayName,
  publicObjectUrl,
  relativeObjectKey,
  resolveObjectAccess,
  s3CopySource,
  s3ErrorLogMeta,
  setObjectCannedAcl,
} from '../services/s3.js';
import {
  createBucket,
  listBuckets,
  getBucketById,
  deleteBucket,
  updateBucket,
  type Bucket,
} from '../db/store.js';

const router = Router();
const log = createLogger('storage');

const DEFAULT_FILE_LIST_LIMIT = 100;
const MAX_FILE_LIST_LIMIT = 200;

interface StorageFilesCursor {
  prefix: string;
  continuationToken?: string;
}

function parseFileListLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_FILE_LIST_LIMIT;
  return Math.min(parsed, MAX_FILE_LIST_LIMIT);
}

function encodeStorageFilesCursor(cursor: StorageFilesCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeStorageFilesCursor(raw: unknown, expectedPrefix: string): StorageFilesCursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as StorageFilesCursor;
    if (!parsed || parsed.prefix !== expectedPrefix) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeStorageType(value: unknown): string {
  const storageType = typeof value === 'string' ? value.trim() : '';
  return storageType || 'ObjectStorage';
}

function isSupportedStorageType(value: string): boolean {
  return value === 'ObjectStorage';
}

function stringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' && prop.trim() ? prop : undefined;
}

function optionalStringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' ? prop : undefined;
}

function numberProp(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'number' ? prop : undefined;
}

function formatS3ConnectionError(
  err: unknown,
  bucket: Bucket,
): { error: string; details: string[] } {
  const formatted = formatS3RequestError(err, bucket);
  return { error: formatted.message, details: formatted.details };
}

function isS3NotFoundError(err: unknown): boolean {
  const name = stringProp(err, 'name');
  const code = stringProp(err, 'Code') || stringProp(err, 'code') || name;
  const metadata =
    err && typeof err === 'object'
      ? ((err as { $metadata?: { httpStatusCode?: number } }).$metadata ?? undefined)
      : undefined;
  const status = metadata?.httpStatusCode;
  return (
    status === 404 ||
    code === 'NotFound' ||
    code === 'NoSuchKey' ||
    code === 'NoSuchBucket' ||
    name === 'NotFound' ||
    name === 'NoSuchKey'
  );
}

async function readS3BodyUtf8(body: unknown): Promise<string> {
  if (!body) return '';
  if (
    typeof body === 'object' &&
    body &&
    typeof (body as { transformToString?: (encoding?: string) => Promise<string> })
      .transformToString === 'function'
  ) {
    return (body as { transformToString: (encoding?: string) => Promise<string> }).transformToString(
      'utf-8',
    );
  }
  if (
    typeof body === 'object' &&
    body &&
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray ===
      'function'
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes).toString('utf8');
  }
  throw new Error('Unsupported object body stream');
}

function maskSecretKey(secretKey: string): string {
  if (secretKey.length <= 8) return '*'.repeat(secretKey.length);
  return `${secretKey.slice(0, 4)}${'*'.repeat(Math.min(16, secretKey.length - 8))}${secretKey.slice(-4)}`;
}

async function listObjectKeysByPrefix(
  client: ReturnType<typeof getS3Client>,
  bucket: Bucket,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    keys.push(
      ...(result.Contents || [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key)),
    );
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Folders (trailing `/` or isPrefix) recurse under the prefix; files stay single-key. */
async function resolveMutationKeys(
  client: ReturnType<typeof getS3Client>,
  bucket: Bucket,
  key: string,
  isPrefixFlag: unknown,
): Promise<{ keys: string[]; isPrefix: boolean }> {
  const isPrefix = isTruthyFlag(isPrefixFlag) || key.endsWith('/');
  if (!isPrefix) return { keys: [key], isPrefix: false };
  const prefix = key.endsWith('/') ? key : `${key}/`;
  return {
    keys: await listObjectKeysByPrefix(client, bucket, prefix),
    isPrefix: true,
  };
}

async function deleteObjectKeys(
  client: ReturnType<typeof getS3Client>,
  bucket: Bucket,
  keys: string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (!chunk.length) continue;
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket.bucketName,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
}

async function setObjectAclForKeys(
  client: ReturnType<typeof getS3Client>,
  bucket: Bucket,
  keys: string[],
  acl: 'public-read' | 'private',
): Promise<void> {
  await mapWithConcurrency(keys, S3_CONCURRENCY, async (key) => {
    await setObjectCannedAcl(client, bucket, key, acl);
  });
}

function serializeBucket(bucket: Bucket) {
  return {
    id: bucket.id,
    name: bucket.name,
    storageType: bucket.storageType,
    endpoint: bucket.endpoint,
    region: bucket.region,
    accessKey: bucket.accessKey,
    secretKeyMasked: maskSecretKey(bucket.secretKey),
    bucketName: bucket.bucketName,
    bucketPath: bucket.bucketPath,
    createdAt: bucket.createdAt,
    deletedAt: bucket.deletedAt,
  };
}

/* ---------- buckets ---------- */

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, endpoint, region, accessKey, secretKey, bucketName } = req.body;
    const storageType = normalizeStorageType(req.body?.storageType);
    const bucketPath = normalizeBucketPath(req.body.bucketPath);
    if (!isSupportedStorageType(storageType)) {
      sendApiError(res, 400, 'Unsupported storage type');
      return;
    }
    if (!name || !endpoint || !accessKey || !secretKey || !bucketName) {
      sendApiError(res, 400, 'name, endpoint, accessKey, secretKey, and storage name are required');
      return;
    }

    const bucket = await createBucket(
      name,
      storageType,
      endpoint,
      region || '',
      accessKey,
      secretKey,
      bucketName,
      bucketPath,
      req.userKeyAuth!.userId,
    );
    log.info('Created storage', {
      ...bucketLogMeta(bucket),
      createdBy: req.userKeyAuth!.userId,
    });
    res.status(201).json(serializeBucket(bucket));
  }),
);

router.get(
  '/',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const buckets = await listBuckets();
    res.json(buckets.map(serializeBucket));
  }),
);

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    log.info('Marking storage as deleted', bucketLogMeta(bucket));

    clearS3Client(bucket.id);
    await deleteBucket(bucket.id);
    log.info('Marked storage as deleted', { bucketId: bucket.id, bucketName: bucket.bucketName });
    res.json({ ok: true });
  }),
);

router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const { name, endpoint, region, accessKey, secretKey, bucketName } = req.body;
    const storageType = normalizeStorageType(req.body?.storageType ?? bucket.storageType);
    if (!isSupportedStorageType(storageType)) {
      sendApiError(res, 400, 'Unsupported storage type');
      return;
    }
    const bucketPath =
      optionalStringProp(req.body, 'bucketPath') !== undefined
        ? normalizeBucketPath(req.body.bucketPath)
        : undefined;
    const accessKeyWillChange = Boolean(accessKey && accessKey !== bucket.accessKey);
    const secretWillChange = Boolean(secretKey && secretKey !== maskSecretKey(bucket.secretKey));
    const updated = await updateBucket(bucket.id, {
      name,
      storageType,
      endpoint,
      region,
      accessKey: accessKeyWillChange ? accessKey : undefined,
      secretKey: secretWillChange ? secretKey : undefined,
      bucketName,
      bucketPath,
    });
    clearS3Client(bucket.id);
    log.info('Updated storage', {
      ...bucketLogMeta(updated!),
      accessKeyChanged: accessKeyWillChange,
      secretKeyChanged: secretWillChange,
    });
    res.json(serializeBucket(updated!));
  }),
);

router.post(
  '/:id/test',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const body = req.body || {};
    const requestedSecret = stringProp(body, 'secretKey');
    const secretFromStored =
      !requestedSecret || requestedSecret === maskSecretKey(bucket.secretKey);
    const effectiveBucket: Bucket = {
      ...bucket,
      name: stringProp(body, 'name') || bucket.name,
      endpoint: stringProp(body, 'endpoint') || bucket.endpoint,
      region: stringProp(body, 'region') || bucket.region,
      accessKey: stringProp(body, 'accessKey') || bucket.accessKey,
      secretKey: secretFromStored ? bucket.secretKey : requestedSecret,
      bucketName: stringProp(body, 'bucketName') || bucket.bucketName,
      bucketPath:
        optionalStringProp(body, 'bucketPath') !== undefined
          ? normalizeBucketPath(optionalStringProp(body, 'bucketPath'))
          : bucket.bucketPath,
    };

    if (
      !effectiveBucket.endpoint ||
      !effectiveBucket.accessKey ||
      !effectiveBucket.secretKey ||
      !effectiveBucket.bucketName
    ) {
      sendApiError(
        res,
        400,
        'endpoint, accessKey, secretKey, and storage name are required to test',
      );
      return;
    }

    const client = createS3Client(effectiveBucket);
    const startedAt = Date.now();
    const healthcheckKey = bucketObjectKey(
      effectiveBucket,
      '.storage-console-healthcheck',
      `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    let uploaded = false;
    log.info('Testing storage connection', {
      ...bucketLogMeta(effectiveBucket),
      key: healthcheckKey,
      usingUnsavedConfig:
        JSON.stringify(serializeBucket(effectiveBucket)) !==
        JSON.stringify(serializeBucket(bucket)),
      secretKeySource: secretFromStored ? 'stored' : 'request',
    });

    // Read probe first: listing the bucket is what browsing the console needs.
    // A read-only key fails the old write-only probe yet works perfectly for
    // browsing, so only hard-fail when read access is denied.
    try {
      await client.send(
        new ListObjectsV2Command({
          Bucket: effectiveBucket.bucketName,
          Prefix: bucketListPrefix(effectiveBucket) || undefined,
          MaxKeys: 1,
        }),
      );
    } catch (err: unknown) {
      log.warn('Storage bucket connection failed (read probe)', {
        ...bucketLogMeta(effectiveBucket),
        key: healthcheckKey,
        durationMs: Date.now() - startedAt,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3ConnectionError(err, effectiveBucket);
      const details = [
        `Healthcheck key: ${healthcheckKey}`,
        `Secret key source: ${secretFromStored ? 'stored' : 'request'}`,
        ...formatted.details,
      ];
      sendApiError(res, 400, formatted.error, 'storage_connection_failed', details);
      client.destroy();
      return;
    }

    // Write probe (optional): PUT + DELETE a healthcheck object. A read-only
    // key is still usable for browsing, so a write denial is reported as a
    // warning instead of failing the connection test.
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: effectiveBucket.bucketName,
          Key: healthcheckKey,
          Body: '',
          ContentType: 'text/plain',
        }),
      );
      uploaded = true;
      log.debug('Storage bucket healthcheck object uploaded', {
        ...bucketLogMeta(effectiveBucket),
        key: healthcheckKey,
      });

      await client.send(
        new DeleteObjectCommand({
          Bucket: effectiveBucket.bucketName,
          Key: healthcheckKey,
        }),
      );
      uploaded = false;

      log.info('Storage bucket read/write connection succeeded', {
        ...bucketLogMeta(effectiveBucket),
        key: healthcheckKey,
        durationMs: Date.now() - startedAt,
      });
      res.json({ ok: true, writeVerified: true });
    } catch (err: unknown) {
      log.warn('Storage bucket connection read-only (write probe denied)', {
        ...bucketLogMeta(effectiveBucket),
        key: healthcheckKey,
        uploadedBeforeFailure: uploaded,
        durationMs: Date.now() - startedAt,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3ConnectionError(err, effectiveBucket);
      res.json({
        ok: true,
        writeVerified: false,
        message: `Connected (read-only): browsing works, but writing test objects is not permitted (${formatted.error}). Uploads may be unavailable.`,
      });
    } finally {
      client.destroy();
    }
  }),
);

/* ---------- files ---------- */

router.get(
  '/:id/files',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const client = getS3Client(bucket);
    const relativePrefix = normalizeBucketPath(String(req.query.prefix || ''));
    const includeAcl = req.query.includeAcl === '1';
    const limit = parseFileListLimit(req.query.limit);
    const decodedCursor = decodeStorageFilesCursor(req.query.cursor, relativePrefix);
    const prefix = bucketObjectKey(bucket, relativePrefix);
    const listPrefix = prefix ? `${prefix}/` : '';
    const items: Array<{
      type: 'folder' | 'file';
      key: string;
      path: string;
      name: string;
      size?: number;
      createdAt?: number;
      isPublic?: boolean;
      publicUrl?: string;
      relativePath?: string;
    }> = [];
    const seenFolders = new Set<string>();

    try {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket.bucketName,
          Prefix: listPrefix || undefined,
          Delimiter: '/',
          ContinuationToken: decodedCursor?.continuationToken,
          MaxKeys: limit,
        }),
      );
      for (const commonPrefix of result.CommonPrefixes || []) {
        if (!commonPrefix.Prefix || seenFolders.has(commonPrefix.Prefix)) continue;
        seenFolders.add(commonPrefix.Prefix);
        const folderRelativePath = relativeObjectKey(bucket, commonPrefix.Prefix).replace(
          /\/$/g,
          '',
        );
        items.push({
          type: 'folder',
          key: commonPrefix.Prefix,
          path: commonPrefix.Prefix,
          name: objectDisplayName(folderRelativePath),
          relativePath: folderRelativePath,
        });
      }
      const fileEntries = (result.Contents || []).filter(
        (object) => object.Key && !object.Key.endsWith('/'),
      );
      const fileItems = await mapWithConcurrency(fileEntries, S3_CONCURRENCY, async (object) => {
        const key = object.Key!;
        const publicAcl = includeAcl ? await isObjectPublic(client, bucket, key) : false;
        return {
          type: 'file' as const,
          key,
          path: key,
          name: objectDisplayName(key),
          size: object.Size || 0,
          createdAt: object.LastModified?.getTime() || 0,
          isPublic: publicAcl,
          publicUrl: publicAcl ? publicObjectUrl(bucket, key) : undefined,
        };
      });
      items.push(...fileItems);

      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const nextCursor =
        result.IsTruncated && result.NextContinuationToken
          ? encodeStorageFilesCursor({
              prefix: relativePrefix,
              continuationToken: result.NextContinuationToken,
            })
          : null;
      log.debug('Listed storage files', {
        ...bucketLogMeta(bucket),
        prefix: listPrefix || '(root)',
        itemCount: items.length,
        hasMore: Boolean(nextCursor),
        requestedBy: req.userKeyAuth!.user,
      });
      const parentPrefix = relativePrefix.split('/').filter(Boolean).slice(0, -1).join('/');
      res.json({
        prefix: relativePrefix,
        parentPrefix,
        basePrefix: bucketListPrefix(bucket).replace(/\/$/g, ''),
        items,
        nextCursor,
      });
    } catch (err: unknown) {
      log.warn('Failed to list storage files', {
        ...bucketLogMeta(bucket),
        prefix: listPrefix || '(root)',
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3RequestError(err, bucket);
      sendApiError(
        res,
        formatted.status,
        formatted.message,
        'storage_list_failed',
        formatted.details,
      );
    }
  }),
);

router.get(
  '/:id/object-access',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.query.key || '');
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }

    const client = getS3Client(bucket);
    const access = await resolveObjectAccess(client, bucket, key);
    res.json({
      isPublic: access.isPublic,
      aclSupported: access.aclSupported,
      publicUrl: access.publicUrl,
    });
  }),
);

router.get(
  '/:id/object-content',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.query.key || '').trim();
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }

    const client = getS3Client(bucket);
    try {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: bucket.bucketName,
          Key: key,
        }),
      );
      const gate = gateObjectTextAccess({
        key,
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      });
      if (!gate.ok) {
        if (gate.reason === 'too_large') {
          sendApiError(
            res,
            413,
            `File exceeds ${MAX_OBJECT_TEXT_BYTES} bytes; use Download instead.`,
            'object_too_large',
          );
          return;
        }
        sendApiError(
          res,
          400,
          'This object is not editable as text. Use Download instead.',
          'object_not_text',
        );
        return;
      }

      const object = await client.send(
        new GetObjectCommand({
          Bucket: bucket.bucketName,
          Key: key,
        }),
      );
      const content = await readS3BodyUtf8(object.Body);
      const contentType = head.ContentType || object.ContentType || guessTextContentType(key);
      const size = Buffer.byteLength(content, 'utf8');
      if (size > MAX_OBJECT_TEXT_BYTES) {
        sendApiError(
          res,
          413,
          `File exceeds ${MAX_OBJECT_TEXT_BYTES} bytes; use Download instead.`,
          'object_too_large',
        );
        return;
      }

      log.info('Loaded object text content', {
        ...bucketLogMeta(bucket),
        key,
        size,
        contentType,
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Object-Content-Type', contentType);
      res.setHeader('X-Object-Size', String(size));
      res.send(content);
    } catch (err) {
      if (isS3NotFoundError(err)) {
        sendApiError(res, 404, 'Object not found');
        return;
      }
      const formatted = formatS3RequestError(err, bucket);
      log.warn('Failed to load object text content', {
        ...bucketLogMeta(bucket),
        key,
        ...s3ErrorLogMeta(err),
      });
      sendApiError(res, formatted.status, formatted.message, 'object_content_failed', formatted.details);
    }
  }),
);

router.put(
  '/:id/object-content',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.body?.key || '').trim();
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }
    if (typeof req.body?.content !== 'string') {
      sendApiError(res, 400, 'content must be a string');
      return;
    }
    const content = req.body.content as string;
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_OBJECT_TEXT_BYTES) {
      sendApiError(
        res,
        413,
        `Content exceeds ${MAX_OBJECT_TEXT_BYTES} bytes; save a smaller file or use Upload.`,
        'object_too_large',
      );
      return;
    }

    const client = getS3Client(bucket);
    let existingContentType: string | undefined;
    let preserveAcl: 'public-read' | 'private' | null = null;
    try {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: bucket.bucketName,
          Key: key,
        }),
      );
      existingContentType = head.ContentType || undefined;
      const gate = gateObjectTextAccess({
        key,
        contentLength: Math.min(head.ContentLength ?? 0, size),
        contentType: head.ContentType,
      });
      // Allow overwrite when key looks like text even if prior MIME was wrong.
      if (!gate.ok && gate.reason === 'not_text' && !looksLikeTextObjectKey(key)) {
        sendApiError(
          res,
          400,
          'This object is not editable as text. Use Upload instead.',
          'object_not_text',
        );
        return;
      }
      const access = await resolveObjectAccess(client, bucket, key);
      if (access.aclSupported) {
        preserveAcl = access.isPublic ? 'public-read' : 'private';
      }
    } catch (err) {
      if (!isS3NotFoundError(err)) {
        const formatted = formatS3RequestError(err, bucket);
        sendApiError(res, formatted.status, formatted.message, 'object_content_failed', formatted.details);
        return;
      }
      // Missing object: allow create/overwrite for text-like keys.
      if (!looksLikeTextObjectKey(key)) {
        sendApiError(
          res,
          400,
          'This object is not editable as text. Use Upload instead.',
          'object_not_text',
        );
        return;
      }
    }

    const requestedType =
      typeof req.body?.contentType === 'string' ? req.body.contentType.trim() : '';
    const contentType = requestedType || existingContentType || guessTextContentType(key);

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket.bucketName,
          Key: key,
          Body: content,
          ContentType: contentType,
        }),
      );
      // PutObject resets canned ACL on many providers; restore prior Public/Private.
      if (preserveAcl) {
        try {
          await setObjectCannedAcl(client, bucket, key, preserveAcl);
        } catch (aclErr) {
          log.warn('Saved object text but failed to restore ACL', {
            ...bucketLogMeta(bucket),
            key,
            preserveAcl,
            ...s3ErrorLogMeta(aclErr),
          });
        }
      }
      log.info('Saved object text content', {
        ...bucketLogMeta(bucket),
        key,
        size,
        contentType,
        preserveAcl,
      });
      res.json({ ok: true, key, size, contentType, acl: preserveAcl });
    } catch (err) {
      const formatted = formatS3RequestError(err, bucket);
      log.warn('Failed to save object text content', {
        ...bucketLogMeta(bucket),
        key,
        ...s3ErrorLogMeta(err),
      });
      sendApiError(res, formatted.status, formatted.message, 'object_content_failed', formatted.details);
    }
  }),
);

router.get(
  '/:id/download-object',
  requireAdminDownloadAuth,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.query.key || '');
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }

    const client = getS3Client(bucket);
    const filename = objectDisplayName(key) || 'download';
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket.bucketName,
        Key: key,
        ResponseContentDisposition: attachmentContentDisposition(filename),
      }),
      {
        expiresIn: DOWNLOAD_LINK_EXPIRES_SECONDS,
        unsignableHeaders: S3_PRESIGN_UNSIGNABLE_HEADERS,
      },
    );

    log.info('Redirecting storage object download to signed URL', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      expiresInSeconds: DOWNLOAD_LINK_EXPIRES_SECONDS,
      direct: true,
    });
    res.redirect(url);
  }),
);

router.get(
  '/:id/download-object-link',
  requireAdminDownloadAuth,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.query.key || '');
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }

    const client = getS3Client(bucket);
    const filename = objectDisplayName(key) || 'download';
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket.bucketName,
        Key: key,
        ResponseContentDisposition: attachmentContentDisposition(filename),
      }),
      {
        expiresIn: DOWNLOAD_LINK_EXPIRES_SECONDS,
        unsignableHeaders: S3_PRESIGN_UNSIGNABLE_HEADERS,
      },
    );

    log.info('Created storage object signed download link', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      expiresInSeconds: DOWNLOAD_LINK_EXPIRES_SECONDS,
      direct: true,
    });
    res.json({
      ok: true,
      direct: true,
      url,
      expiresInSeconds: DOWNLOAD_LINK_EXPIRES_SECONDS,
      expiresAt: Date.now() + DOWNLOAD_LINK_EXPIRES_SECONDS * 1000,
    });
  }),
);

router.get(
  '/:id/download-script',
  requireAdminDownloadAuth,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.query.key || '').trim();
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }
    const apiBase = String(req.query.apiBase || '').trim();
    const output = String(req.query.output || '').trim() || undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/x-shellscript').send(
      directDownloadShellScript({
        apiBase,
        bucketId: bucket.id,
        key,
        output,
      }),
    );
  }),
);

router.delete(
  '/:id/object',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.query.key || '');
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }
    const client = getS3Client(bucket);
    // Prefer isPrefix; accept legacy `prefix=1` for older clients.
    const { keys, isPrefix } = await resolveMutationKeys(
      client,
      bucket,
      key,
      req.query.isPrefix ?? req.query.prefix,
    );
    if (!keys.length) {
      sendApiError(res, 404, 'Object not found');
      return;
    }

    log.info('Marking storage object as deleted', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      isPrefix,
      objectCount: keys.length,
    });

    await deleteObjectKeys(client, bucket, keys);
    res.json({ ok: true, objectCount: keys.length });
  }),
);

router.post(
  '/:id/copy-object',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const sourceKey = String(req.body?.key || '').trim();
    const targetKey = String(req.body?.targetKey || '')
      .trim()
      .replace(/^\/+/, '');
    if (!sourceKey || !targetKey) {
      sendApiError(res, 400, 'Source key and target key are required');
      return;
    }

    const client = getS3Client(bucket);
    log.info('Copying storage object', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      sourceKey,
      targetKey,
    });
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket.bucketName,
        CopySource: s3CopySource(bucket.bucketName, sourceKey),
        Key: targetKey,
      }),
    );

    res.json({ ok: true, key: targetKey });
  }),
);

router.post(
  '/:id/object/move',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const sourceKey = String(req.body?.key || '').trim();
    const targetKey = String(req.body?.targetKey || '')
      .trim()
      .replace(/^\/+/, '');
    const isPrefix = Boolean(req.body?.isPrefix);
    if (!sourceKey || !targetKey) {
      sendApiError(res, 400, 'Source key and target key are required');
      return;
    }

    const client = getS3Client(bucket);
    const sourcePrefix = sourceKey.endsWith('/') ? sourceKey : `${sourceKey}/`;
    const targetPrefix = targetKey.endsWith('/') ? targetKey : `${targetKey}/`;
    const sourceKeys = isPrefix
      ? await listObjectKeysByPrefix(client, bucket, sourcePrefix)
      : [sourceKey];
    if (!sourceKeys.length) {
      sendApiError(res, 404, 'Object not found');
      return;
    }
    const moved = await mapWithConcurrency(sourceKeys, S3_CONCURRENCY, async (objectKey) => {
      const nextKey = isPrefix
        ? `${targetPrefix}${objectKey.slice(sourcePrefix.length)}`
        : targetKey;
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket.bucketName,
          CopySource: s3CopySource(bucket.bucketName, objectKey),
          Key: nextKey,
        }),
      );
      return { key: nextKey };
    });
    await deleteObjectKeys(client, bucket, sourceKeys);

    log.info('Moved storage object', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      sourceKey,
      targetKey,
      isPrefix,
      objectCount: moved.length,
    });
    res.json({ ok: true, moved });
  }),
);

router.post(
  '/:id/object/public',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.body?.key || '').trim();
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }

    const client = getS3Client(bucket);
    const { keys, isPrefix } = await resolveMutationKeys(client, bucket, key, req.body?.isPrefix);
    if (!keys.length) {
      sendApiError(res, 404, 'Object not found');
      return;
    }
    log.info('Making storage object public', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      isPrefix,
      objectCount: keys.length,
    });
    await setObjectAclForKeys(client, bucket, keys, 'public-read');

    res.json({
      ok: true,
      key,
      objectCount: keys.length,
      publicUrl: isPrefix ? undefined : publicObjectUrl(bucket, key),
    });
  }),
);

router.post(
  '/:id/object/private',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const key = String(req.body?.key || '').trim();
    if (!key) {
      sendApiError(res, 400, 'Object key is required');
      return;
    }

    const client = getS3Client(bucket);
    const { keys, isPrefix } = await resolveMutationKeys(client, bucket, key, req.body?.isPrefix);
    if (!keys.length) {
      sendApiError(res, 404, 'Object not found');
      return;
    }
    log.info('Making storage object private', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      isPrefix,
      objectCount: keys.length,
    });
    await setObjectAclForKeys(client, bucket, keys, 'private');

    res.json({ ok: true, key, objectCount: keys.length });
  }),
);

/**
 * Upload constraints, so the browser checks them before it starts rather than
 * after. Without this the UI could only learn the limits by exceeding one — and
 * the file-count limit is only enforced at finalize, by which point every file
 * has already been written to the bucket and the batch still fails as a whole.
 *
 * Must stay above the `/:id` routes so the literal path is not read as an id.
 */
router.get(
  '/upload-limits',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      maxFiles: MAX_UPLOAD_FILES,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }),
);

/**
 * Browser upload PUTs processed at once.
 *
 * Acquired at the top of the route rather than around the PutObject call,
 * because the request body is what an unbounded number of them would be
 * streaming through the process at the same time. Shedding load here keeps the
 * in-flight set a function of configuration instead of browser behaviour.
 */
const uploadGate = createGate(MAX_CONCURRENT_UPLOADS, MAX_QUEUED_UPLOADS);

/**
 * Chunked upload part bodies processed at once.
 *
 * Separate from {@link uploadGate} and sized much larger: a part is a bounded
 * few megabytes finished in seconds, where a whole-file request could stream a
 * gigabyte. Sharing one small gate would let a single browser — which opens a
 * few parts at once by design — consume the whole allowance and starve every
 * other uploader. The starting call keeps using `uploadGate`, since it does the
 * same unbounded-ish work a whole-file PUT did.
 */
const uploadPartGate = createGate(MAX_CONCURRENT_UPLOAD_PARTS, MAX_QUEUED_UPLOAD_PARTS);

/**
 * Browser upload proxy: PUT object bytes through the console (same-origin), then
 * server PutObject with stored credentials. Avoids bucket CORS on direct-to-S3 PUTs.
 * CLI scripts continue to use /upload-links + presigned URLs.
 */
router.put(
  '/:id/upload-object',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const release = await uploadGate.acquire();
    if (!release) {
      // 503 + Retry-After tells the client to back off and re-send this file.
      // Re-sending is safe: the PUT is idempotent for a given key, and the
      // client only finalizes records after every file has landed.
      //
      // Drain the body before replying. Answering while the client is still
      // writing ends the response with unread data in flight, which Node
      // resolves by destroying the socket — the client then sees a connection
      // reset instead of this status, and a reset reads as a network failure
      // rather than an instruction to retry.
      req.resume();
      res.setHeader('Retry-After', '1');
      sendApiError(
        res,
        503,
        'Server is busy uploading; retry this file shortly',
        'server_busy',
        undefined,
        true,
      );
      return;
    }
    // Released when the response finishes, or when the client goes away
    // mid-upload — whichever comes first.
    res.on('close', release);

    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const relativePath = normalizeBucketPath(String(req.query.relativePath || ''));
    const name = String(req.query.name || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const contentType =
      String(req.query.contentType || '').trim() ||
      String(req.headers['content-type'] || '').trim() ||
      'application/octet-stream';
    const contentLength = Number(req.headers['content-length'] || 0);

    if (!name) {
      sendApiError(res, 400, 'File name is required');
      return;
    }
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      sendApiError(res, 400, 'Content-Length is required');
      return;
    }
    if (contentLength > MAX_UPLOAD_BYTES) {
      sendApiError(
        res,
        400,
        `File "${name}" exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`,
      );
      return;
    }

    const key = bucketObjectKey(bucket, relativePath, name);
    const client = getS3Client(bucket);

    log.info('Proxy uploading storage object', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      contentType,
      contentLength,
    });

    try {
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket.bucketName,
          Key: key,
          Body: req,
          ContentType: contentType,
          ContentLength: contentLength,
        },
      });
      await upload.done();
    } catch (err: unknown) {
      log.warn('Proxy storage upload failed', {
        ...bucketLogMeta(bucket),
        key,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3RequestError(err, bucket);
      sendApiError(
        res,
        formatted.status,
        formatted.message,
        'storage_upload_failed',
        formatted.details,
        isRetryableS3Error(err),
      );
      return;
    }

    res.status(201).json({
      ok: true,
      key,
      name,
      size: contentLength,
      contentType,
      relativePath,
    });
  }),
);

/**
 * A part whose length disagreed with the length the session requires.
 *
 * Distinct from a storage failure because it is the client's mistake: re-sending
 * the same bytes would fail identically, so it must not be reported as something
 * worth retrying.
 */
class PartLengthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartLengthError';
  }
}

/**
 * Send a spooled part to the storage, retrying transient failures here.
 *
 * The SDK does not retry a request whose body is a stream or a file — it cannot
 * know the body is replayable — so a retry is the caller's job, and having a file
 * on disk is what makes it possible. Only failures the storage itself calls
 * transient are retried: re-sending a part it rejected as malformed would just
 * fail again more slowly.
 */
async function uploadPartWithRetry(
  client: S3Client,
  bucket: Bucket,
  session: { key: string; uploadId: string },
  partNumber: number,
  filePath: string,
  bytes: number,
  abortSignal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.send(
        new UploadPartCommand({
          Bucket: bucket.bucketName,
          Key: session.key,
          UploadId: session.uploadId,
          PartNumber: partNumber,
          Body: createReadStream(filePath),
          ContentLength: bytes,
        }),
        { abortSignal },
      );
    } catch (err: unknown) {
      // A part that no longer exists is not worth retrying, and neither is one
      // the storage rejected on its merits.
      if (isUploadGoneError(err) || !isRetryableS3Error(err)) throw err;
      if (attempt >= UPLOAD_PART_UPLOAD_ATTEMPTS - 1) throw err;
      if (abortSignal.aborted) throw err;

      const waitMs = Math.min(500 * 2 ** attempt, 5000);
      log.warn('Retrying multipart part upload', {
        ...bucketLogMeta(bucket),
        key: session.key,
        partNumber,
        attempt: attempt + 1,
        waitMs,
        ...s3ErrorLogMeta(err),
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Whether the storage says this multipart upload no longer exists.
 *
 * Ambiguous on its own, and deliberately not treated as failure anywhere: an
 * upload is gone either because it was already completed (and only the reply was
 * lost) or because it was aborted or aged out. The caller decides by looking at
 * whether the object is actually there.
 */
function isUploadGoneError(err: unknown): boolean {
  const code = String(
    (err as { Code?: unknown })?.Code ?? (err as { code?: unknown })?.code ?? '',
  );
  if (code === 'NoSuchUpload') return true;
  const name = String((err as { name?: unknown })?.name ?? '');
  if (name === 'NoSuchUpload') return true;
  const status = (err as { $metadata?: { httpStatusCode?: unknown } })?.$metadata?.httpStatusCode;
  return status === 404;
}

/** Abort a session's storage-side upload, logging rather than throwing. */
async function abortSessionUpload(session: { bucketId: string; key: string; uploadId: string }) {
  const bucket = await getBucketById(session.bucketId);
  if (!bucket) return;
  try {
    await getS3Client(bucket).send(
      new AbortMultipartUploadCommand({
        Bucket: bucket.bucketName,
        Key: session.key,
        UploadId: session.uploadId,
      }),
    );
    log.info('Aborted multipart upload', { ...bucketLogMeta(bucket), key: session.key });
  } catch (err: unknown) {
    // Best-effort: the session is already gone from the registry, and a
    // leftover upload is reclaimed by the bucket's lifecycle rule.
    log.warn('Failed to abort multipart upload', {
      ...bucketLogMeta(bucket),
      key: session.key,
      ...s3ErrorLogMeta(err),
    });
  }
}

/**
 * Begin a chunked browser upload.
 *
 * The browser used to PUT the whole file through this service in one request.
 * Every hop in front of the service has to accept that body within its own
 * request-body window — a limit essentially every proxy imposes — and a 1 GB
 * body needed a sustained 28.6 Mbps to finish inside a typical one, so a slower
 * upstream was cut off and surfaced as an opaque 502 that no amount of
 * server-side timeout tuning could prevent. Splitting the file lets each request
 * finish in seconds.
 *
 * The object key is computed here, from the bucket's configured path and the
 * client's requested name, and sealed into a signed token. The client never
 * receives the storage's upload id, because the id plus an arbitrary key would
 * let it write outside the configured bucket path.
 */
router.post(
  '/:id/upload-multipart',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const release = await uploadGate.acquire();
    if (!release) {
      req.resume();
      res.setHeader('Retry-After', '1');
      sendApiError(
        res,
        503,
        'Server is busy uploading; retry this file shortly',
        'server_busy',
        undefined,
        true,
      );
      return;
    }
    res.on('close', release);

    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const relativePath = normalizeBucketPath(String(req.query.relativePath || ''));
    const name = String(req.query.name || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const contentType =
      String(req.query.contentType || '').trim() ||
      String(req.headers['content-type'] || '').trim() ||
      'application/octet-stream';
    const size = Number(req.query.size || 0);

    if (!name) {
      sendApiError(res, 400, 'File name is required');
      return;
    }
    if (!Number.isFinite(size) || size <= 0) {
      sendApiError(res, 400, 'File size is required');
      return;
    }
    if (size > MAX_UPLOAD_BYTES) {
      sendApiError(
        res,
        400,
        `File "${name}" exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`,
        'too_large',
        undefined,
        false,
      );
      return;
    }
    const partCount = Math.ceil(size / UPLOAD_PART_SIZE_BYTES);
    if (partCount > UPLOAD_MAX_PARTS) {
      sendApiError(
        res,
        400,
        `File "${name}" needs ${partCount} parts, over the ${UPLOAD_MAX_PARTS} part limit`,
        'too_many_parts',
        undefined,
        false,
      );
      return;
    }

    const key = bucketObjectKey(bucket, relativePath, name);
    const client = getS3Client(bucket);

    let uploadId: string;
    try {
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket.bucketName,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!created.UploadId) {
        throw new Error('Storage did not return a multipart upload id');
      }
      uploadId = created.UploadId;
    } catch (err: unknown) {
      log.warn('Failed to start multipart upload', {
        ...bucketLogMeta(bucket),
        key,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3RequestError(err, bucket);
      sendApiError(
        res,
        formatted.status,
        formatted.message,
        'storage_upload_failed',
        formatted.details,
        isRetryableS3Error(err),
      );
      return;
    }

    // The final part carries the remainder, and is the only one allowed to be
    // smaller than the part size. Sealed into the token rather than left to the
    // client to declare per request, so the expected length of every part is
    // known server-side.
    const lastPartSize = size - UPLOAD_PART_SIZE_BYTES * (partCount - 1);

    const token = createSessionToken({
      uploadId,
      bucketId: bucket.id,
      key,
      contentType,
      size,
      partSize: UPLOAD_PART_SIZE_BYTES,
      lastPartSize,
      userId: req.userKeyAuth!.userId,
    });

    log.info('Started multipart storage upload', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      contentType,
      size,
      partCount,
      partSize: UPLOAD_PART_SIZE_BYTES,
    });

    res.status(201).json({
      uploadToken: token,
      key,
      name,
      size,
      contentType,
      relativePath,
      partSize: UPLOAD_PART_SIZE_BYTES,
      partCount,
    });
  }),
);

/**
 * One piece of a chunked upload.
 *
 * The body is spooled to a temporary file and then sent to the storage from
 * there, rather than being piped straight through. The difference is what
 * happens when the storage stumbles: a stream can be read exactly once, so a
 * piped part that fails upstream can only be retried by asking the browser to
 * send those bytes again. A file can be read as many times as needed, so the
 * retry happens here, in seconds, without the client noticing.
 *
 * Spooling also makes the size check exact. The expected length of this part is
 * derived from the signed session — the client cannot claim a part is the last
 * one to escape the minimum size rule — and the copy to disk is capped at that
 * length as it arrives, so an oversized body is refused before it can fill the
 * disk.
 */
router.put(
  '/:id/upload-part',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const release = await uploadPartGate.acquire();
    if (!release) {
      // Drain before answering, or the client sees a reset instead of this
      // status and cannot tell "retry" from "the network failed".
      req.resume();
      res.setHeader('Retry-After', '1');
      sendApiError(
        res,
        503,
        'Server is busy uploading; retry this part shortly',
        'server_busy',
        undefined,
        true,
      );
      return;
    }
    res.on('close', release);

    const token = String(req.query.uploadToken || '').trim();
    const partNumber = Number(req.query.partNumber || 0);

    if (!token) {
      req.resume();
      sendApiError(res, 400, 'Upload token is required', 'invalid_part', undefined, false);
      return;
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > UPLOAD_MAX_PARTS) {
      req.resume();
      sendApiError(
        res,
        400,
        `Part number must be between 1 and ${UPLOAD_MAX_PARTS}`,
        'invalid_part',
        undefined,
        false,
      );
      return;
    }

    const session = parseSessionToken(token);
    if (!session) {
      // Forged, or past its lifetime. Not retryable: re-sending the same part
      // cannot bring back a session the server will no longer accept.
      req.resume();
      sendApiError(
        res,
        404,
        'Upload session not found or expired; restart the upload',
        'upload_session_expired',
        undefined,
        false,
      );
      return;
    }

    // The token is the session; it carries the bucket it was minted for, so a
    // token cannot be pointed at a different storage than the one the key was
    // computed against.
    if (session.bucketId !== req.params.id) {
      req.resume();
      sendApiError(
        res,
        400,
        'Upload token does not belong to this storage',
        'invalid_part',
        undefined,
        false,
      );
      return;
    }
    if (session.userId !== req.userKeyAuth!.userId) {
      req.resume();
      sendApiError(res, 403, 'Upload token belongs to another account', 'invalid_part', undefined, false);
      return;
    }

    const partCount = sessionPartCount(session);
    if (partNumber > partCount) {
      req.resume();
      sendApiError(
        res,
        400,
        `Part number ${partNumber} is beyond the ${partCount} parts this upload declares`,
        'invalid_part',
        undefined,
        false,
      );
      return;
    }

    const expectedBytes = expectedPartLength(session, partNumber);
    const contentLength = Number(req.headers['content-length'] || 0);
    // Content-Length is a fast rejection for the honest mistake and for a client
    // that would otherwise stream a whole file at us; the spool cap below is what
    // actually enforces the bound, since a header can be absent or wrong.
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== expectedBytes) {
      req.resume();
      sendApiError(
        res,
        400,
        `Part ${partNumber} must be ${expectedBytes} bytes, but ${contentLength} were declared`,
        'invalid_part',
        undefined,
        false,
      );
      return;
    }

    const bucket = await getBucketById(session.bucketId);
    if (!bucket) {
      req.resume();
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const client = getS3Client(bucket);

    // A part that is already fully delivered should still be cleaned up if the
    // browser vanishes rather than waiting for a response it will never read.
    const partAbort = new AbortController();
    const abortPartIfClientGone = () => {
      if (!res.writableEnded) partAbort.abort();
    };
    req.on('aborted', abortPartIfClientGone);
    req.on('error', abortPartIfClientGone);

    // The spool cap is the exact expected length: anything longer is a protocol
    // violation, not a part to store.
    //
    // The response is deliberately sent from the `.then` below rather than from
    // inside the callback. `withSpooled` removes the file as the callback
    // returns, and answering first would acknowledge a part while its bytes were
    // still on disk — a process that died in that window would leave the file
    // for a sweep that may be hours away.
    await withSpooled(req, expectedBytes, async (spooled) => {
      if (spooled.bytes !== expectedBytes) {
        throw new PartLengthError(
          `Part ${partNumber} must be ${expectedBytes} bytes, but ${spooled.bytes} arrived`,
        );
      }

      const uploaded = await uploadPartWithRetry(
        client,
        bucket,
        session,
        partNumber,
        spooled.path,
        expectedBytes,
        partAbort.signal,
      );
      return uploaded.ETag || '';
    })
      .then((etag) => {
        if (res.headersSent || res.writableEnded) return;
        res.status(200).json({ ok: true, partNumber, etag, size: expectedBytes });
      })
      .catch((err: unknown) => {
        if (res.headersSent || res.writableEnded) return;

        // A part whose length disagreed with the session is the client's
        // mistake and will fail identically if re-sent.
        if (err instanceof PartLengthError) {
          sendApiError(res, 400, err.message, 'invalid_part', undefined, false);
          return;
        }

        log.warn('Multipart part upload failed', {
          ...bucketLogMeta(bucket),
          key: session.key,
          partNumber,
          ...s3ErrorLogMeta(err),
        });

        // The upload disappeared underneath this part — most likely it was
        // completed or aborted while parts were still in flight. Retrying the
        // part can never work, so say so plainly rather than reporting a
        // retryable storage failure the client would burn its budget on.
        if (isUploadGoneError(err)) {
          sendApiError(
            res,
            409,
            'Upload session is no longer active; restart the upload',
            'upload_session_expired',
            undefined,
            false,
          );
          return;
        }
        const formatted = formatS3RequestError(err, bucket);
        sendApiError(
          res,
          formatted.status,
          formatted.message,
          'storage_upload_failed',
          formatted.details,
          isRetryableS3Error(err),
        );
      })
      .finally(() => {
        req.off('aborted', abortPartIfClientGone);
        req.off('error', abortPartIfClientGone);
      });
  }),
);

/**
 * Finish a chunked upload from the parts the client reported. *
 * The assembled size is checked against what the client declared at creation:
 * the storage will happily complete an upload whose parts are shorter than
 * intended, producing a silently truncated object, so a mismatch is an error
 * rather than something to discover later from the stored bytes.
 */
router.post(
  '/:id/upload-multipart/complete',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const token = stringProp(req.body || {}, 'uploadToken') || '';
    const rawParts = Array.isArray(req.body?.parts) ? req.body.parts : [];

    if (!token) {
      sendApiError(res, 400, 'Upload token is required', 'invalid_part', undefined, false);
      return;
    }
    if (!rawParts.length) {
      sendApiError(res, 400, 'No parts provided', 'invalid_part', undefined, false);
      return;
    }

    const session = parseSessionToken(token);
    if (!session) {
      sendApiError(
        res,
        404,
        'Upload session not found or expired; restart the upload',
        'upload_session_expired',
        undefined,
        false,
      );
      return;
    }

    // Every part the session declares must be accounted for, or the completed
    // object would silently be missing a chunk. The count is derived from the
    // signed session rather than taken from the request.
    const expectedCount = sessionPartCount(session);
    const parts: { ETag: string; PartNumber: number }[] = [];
    const seen = new Set<number>();
    for (const item of rawParts) {
      const partNumber = numberProp(item, 'partNumber');
      const etag = stringProp(item, 'etag');
      if (!Number.isInteger(partNumber) || !partNumber || partNumber < 1 || !etag) {
        sendApiError(res, 400, 'Each part needs a partNumber and etag', 'invalid_part', undefined, false);
        return;
      }
      if (!partNumber || partNumber > expectedCount) {
        sendApiError(
          res,
          400,
          `Part number ${partNumber} is beyond the ${expectedCount} parts this upload declares`,
          'invalid_part',
          undefined,
          false,
        );
        return;
      }
      if (seen.has(partNumber)) {
        sendApiError(res, 400, `Part ${partNumber} was reported twice`, 'invalid_part', undefined, false);
        return;
      }
      seen.add(partNumber);
      parts.push({ ETag: etag, PartNumber: partNumber });
    }

    if (parts.length !== expectedCount) {
      sendApiError(
        res,
        400,
        `Upload has ${parts.length} of ${expectedCount} parts; completing it would lose data`,
        'missing_parts',
        undefined,
        false,
      );
      return;
    }
    // The storage requires parts in ascending order.
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    const bucket = await getBucketById(session.bucketId);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const client = getS3Client(bucket);

    // Reading the object back is how both a fresh completion and a duplicate one
    // are resolved: it is the only way to tell "the object is there and whole"
    // from "the upload is gone and nothing landed".
    const verifyObject = async () => {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket.bucketName, Key: session.key }),
      );
      return { size: head.ContentLength || 0, contentType: head.ContentType };
    };

    try {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket.bucketName,
          Key: session.key,
          UploadId: session.uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err: unknown) {
      // The completion may already have happened and only its response been
      // lost — a retry then arrives to find the upload gone. Re-sending the
      // whole file because a reply went missing would throw away everything
      // already transferred, so the object itself is asked instead.
      const alreadyGone = isUploadGoneError(err);
      if (alreadyGone) {
        const existing = await verifyObject().catch(() => null);
        if (existing && existing.size === session.size) {
          log.info('Multipart upload had already completed', {
            ...bucketLogMeta(bucket),
            key: session.key,
            size: existing.size,
          });
          res.status(201).json({
            ok: true,
            key: session.key,
            name: objectDisplayName(session.key),
            size: existing.size,
            contentType: existing.contentType || session.contentType,
          });
          return;
        }
      }

      log.warn('Failed to complete multipart upload', {
        ...bucketLogMeta(bucket),
        key: session.key,
        partCount: parts.length,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3RequestError(err, bucket);
      sendApiError(
        res,
        formatted.status,
        formatted.message,
        'storage_upload_failed',
        formatted.details,
        isRetryableS3Error(err),
      );
      return;
    }

    // The upload is done at the storage. There is nothing to drop server-side —
    // the session lives in the token, which the client will not present again.
    const head = await verifyObject();
    const actualSize = head.size;
    if (actualSize !== session.size) {
      sendApiError(
        res,
        502,
        `Uploaded object is ${actualSize} bytes but ${session.size} were declared`,
        'size_mismatch',
        [`Object: ${session.key}`],
        // The bytes are already stored and wrong; re-sending parts cannot help.
        false,
      );
      return;
    }

    log.info('Completed multipart storage upload', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key: session.key,
      size: actualSize,
      partCount: parts.length,
    });

    res.status(201).json({
      ok: true,
      key: session.key,
      name: objectDisplayName(session.key),
      size: actualSize,
      contentType: head.contentType || session.contentType,
    });
  }),
);

/**
 * Abandon a chunked upload, so its already-uploaded parts stop occupying the
 * bucket. Uploaded parts are invisible to listing until completion, so an
 * upload that is never completed or aborted is pure invisible cost.
 */
router.post(
  '/:id/upload-multipart/abort',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const token = stringProp(req.body || {}, 'uploadToken') || '';
    const session = token ? parseSessionToken(token) : null;

    // A token is a bearer value the client already holds, so aborting is not a
    // state change here — it is a request to release the parts the storage is
    // holding. Only a valid token proves the caller had the upload to begin
    // with; an unrecognised one is treated as already gone.
    if (session && session.bucketId === req.params.id) {
      await abortSessionUpload(session);
    }

    // Idempotent: an unknown or expired token is success, not an error. The
    // client calls this from cancel and failure paths, where failing it again
    // would only obscure the original problem.
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/upload-links',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const relativePath = normalizeBucketPath(stringProp(req.body || {}, 'relativePath'));
    const requestedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
    if (requestedFiles.length === 0) {
      sendApiError(res, 400, 'No files provided');
      return;
    }
    if (requestedFiles.length > MAX_UPLOAD_FILES) {
      sendApiError(res, 400, `At most ${MAX_UPLOAD_FILES} files can be uploaded at once`);
      return;
    }

    const client = getS3Client(bucket);
    const uploadInputs = [];
    for (const item of requestedFiles) {
      const name = (stringProp(item, 'name') || '').replace(/^\/+|\/+$/g, '');
      const contentType = stringProp(item, 'contentType') || 'application/octet-stream';
      const size = numberProp(item, 'size') || 0;
      if (!name) {
        sendApiError(res, 400, 'File name is required');
        return;
      }
      if (size > MAX_UPLOAD_BYTES) {
        sendApiError(res, 400, `File "${name}" exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`);
        return;
      }

      uploadInputs.push({
        name,
        contentType,
        size,
        key: bucketObjectKey(bucket, relativePath, name),
      });
    }
    const uploads = await mapWithConcurrency(uploadInputs, S3_CONCURRENCY, async (input) => {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket.bucketName,
          Key: input.key,
          ContentType: input.contentType,
        }),
        {
          expiresIn: UPLOAD_LINK_EXPIRES_SECONDS,
          unsignableHeaders: S3_PRESIGN_UNSIGNABLE_HEADERS,
        },
      );
      return {
        name: input.name,
        key: input.key,
        size: input.size,
        contentType: input.contentType,
        url,
        headers: { 'Content-Type': input.contentType },
        expiresInSeconds: UPLOAD_LINK_EXPIRES_SECONDS,
        direct: true,
      };
    });

    log.info('Created storage direct upload links', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      relativePath: relativePath || '(root)',
      fileCount: uploads.length,
      totalBytes: uploads.reduce((sum, file) => sum + file.size, 0),
      expiresInSeconds: UPLOAD_LINK_EXPIRES_SECONDS,
      direct: true,
    });
    res.json({
      uploads,
      expiresInSeconds: UPLOAD_LINK_EXPIRES_SECONDS,
      direct: true,
    });
  }),
);

router.get(
  '/:id/upload-script',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }
    const apiBase = String(req.query.apiBase || '').trim();
    const relativePath = normalizeBucketPath(String(req.query.relativePath || ''));
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/x-shellscript').send(
      directUploadShellScript({
        apiBase,
        bucketId: bucket.id,
        relativePath,
      }),
    );
  }),
);

router.post(
  '/:id/upload-complete',
  requireAdminUploadAuth,
  asyncHandler(async (req, res) => {
    const bucket = await getBucketById(req.params.id);
    if (!bucket) {
      sendApiError(res, 404, 'Storage not found');
      return;
    }

    const completedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
    if (completedFiles.length === 0) {
      sendApiError(res, 400, 'No completed files provided');
      return;
    }
    if (completedFiles.length > MAX_UPLOAD_FILES) {
      sendApiError(res, 400, `At most ${MAX_UPLOAD_FILES} files can be completed at once`);
      return;
    }

    const client = getS3Client(bucket);
    const username = req.userKeyAuth!.user;
    const completedInputs = [];

    for (const item of completedFiles) {
      const key = stringProp(item, 'key') || '';
      const basePrefix = bucketListPrefix(bucket);
      if (!key || (basePrefix && !key.startsWith(basePrefix))) {
        sendApiError(res, 400, 'Completed object key is outside the configured bucket path');
        return;
      }
      const name = stringProp(item, 'name') || objectDisplayName(key);
      const contentType = stringProp(item, 'contentType') || null;
      completedInputs.push({ key, name, contentType });
    }

    const results = await mapWithConcurrency(completedInputs, S3_CONCURRENCY, async (item) => {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: bucket.bucketName,
          Key: item.key,
        }),
      );
      return {
        name: item.name,
        size: head.ContentLength || 0,
        key: item.key,
        contentType: head.ContentType || item.contentType,
      };
    });

    log.info('Completed direct storage uploads', {
      ...bucketLogMeta(bucket),
      requestedBy: username,
      fileCount: results.length,
    });
    res.status(201).json(results);
  }),
);

export default router;

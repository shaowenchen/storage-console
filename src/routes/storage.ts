import { Router } from 'express';
import { sendApiError } from '../domain/apiError.js';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectAclCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  requireAdmin,
  requireAdminDownloadAuth,
  requireAdminUploadAuth,
} from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { mapWithConcurrency } from '../lib/concurrency.js';
import {
  DOWNLOAD_LINK_EXPIRES_SECONDS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  S3_CONCURRENCY,
  UPLOAD_LINK_EXPIRES_SECONDS,
} from '../config/upload.js';
import { createLogger } from '../utils/logger.js';
import { directUploadShellScript } from '../services/uploadScript.js';
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
  normalizeBucketPath,
  objectDisplayName,
  publicObjectUrl,
  relativeObjectKey,
  s3CopySource,
  s3ErrorLogMeta,
} from '../services/s3.js';
import {
  createBucket,
  listBuckets,
  getBucketById,
  deleteBucket,
  updateBucket,
  listFilesByBucketPaths,
  createFileRecord,
  deleteFileRecord,
  getFileRecordByBucketPath,
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
    await client.send(
      new PutObjectAclCommand({
        Bucket: bucket.bucketName,
        Key: key,
        ACL: acl,
      }),
    );
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
    const secretWillChange = Boolean(secretKey && secretKey !== maskSecretKey(bucket.secretKey));
    const updated = await updateBucket(bucket.id, {
      name,
      storageType,
      endpoint,
      region,
      accessKey,
      secretKey: secretWillChange ? secretKey : undefined,
      bucketName,
      bucketPath,
    });
    clearS3Client(bucket.id);
    log.info('Updated storage', {
      ...bucketLogMeta(updated!),
      accessKeyChanged: Boolean(accessKey && accessKey !== bucket.accessKey),
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
      '.studio-healthcheck',
      `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    let uploaded = false;
    log.info('Testing storage read/write connection', {
      ...bucketLogMeta(effectiveBucket),
      key: healthcheckKey,
      usingUnsavedConfig:
        JSON.stringify(serializeBucket(effectiveBucket)) !==
        JSON.stringify(serializeBucket(bucket)),
      secretKeySource: secretFromStored ? 'stored' : 'request',
    });
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
      res.json({ ok: true });
    } catch (err: unknown) {
      log.warn('Storage bucket read/write connection failed', {
        ...bucketLogMeta(effectiveBucket),
        key: healthcheckKey,
        uploadedBeforeFailure: uploaded,
        durationMs: Date.now() - startedAt,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3ConnectionError(err, effectiveBucket);
      const details = [
        `Healthcheck key: ${healthcheckKey}`,
        `Uploaded before failure: ${uploaded ? 'yes' : 'no'}`,
        `Secret key source: ${secretFromStored ? 'stored' : 'request'}`,
        ...formatted.details,
      ];
      sendApiError(res, 400, formatted.error, 'storage_connection_failed', details);
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
      id?: string;
      key: string;
      path: string;
      name: string;
      size?: number;
      username?: string;
      createdAt?: number;
      contentType?: string | null;
      source?: 's3' | 'studio';
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
      const fileKeys = (result.Contents || [])
        .filter((object) => object.Key && !object.Key.endsWith('/'))
        .map((object) => object.Key!);
      const storedFiles = await listFilesByBucketPaths(bucket.id, fileKeys);
      const recordsByPath = new Map(storedFiles.map((file) => [file.path, file]));
      const fileItems = await mapWithConcurrency(fileKeys, S3_CONCURRENCY, async (key) => {
        const record = recordsByPath.get(key);
        const object = (result.Contents || []).find((item) => item.Key === key);
        const publicAcl = includeAcl ? await isObjectPublic(client, bucket, key) : false;
        return {
          type: 'file',
          id: record?.id,
          key,
          path: key,
          name: record?.name || objectDisplayName(key),
          size: object?.Size || 0,
          username: record?.username || '-',
          createdAt: record?.createdAt || object?.LastModified?.getTime() || 0,
          contentType: record?.contentType || null,
          source: record ? 'studio' : 's3',
          isPublic: publicAcl,
          publicUrl: publicAcl ? publicObjectUrl(bucket, key) : undefined,
        } as const;
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
    try {
      const publicAcl = await isObjectPublic(client, bucket, key);
      res.json({
        isPublic: publicAcl,
        publicUrl: publicAcl ? publicObjectUrl(bucket, key) : undefined,
      });
    } catch (err: unknown) {
      log.warn('Failed to read object access', {
        ...bucketLogMeta(bucket),
        key,
        ...s3ErrorLogMeta(err),
      });
      const formatted = formatS3RequestError(err, bucket);
      sendApiError(
        res,
        formatted.status,
        formatted.message,
        'object_access_failed',
        formatted.details,
      );
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
      { expiresIn: DOWNLOAD_LINK_EXPIRES_SECONDS },
    );

    log.info('Redirecting storage object download to signed URL', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      expiresInSeconds: DOWNLOAD_LINK_EXPIRES_SECONDS,
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
      { expiresIn: DOWNLOAD_LINK_EXPIRES_SECONDS },
    );

    log.info('Created storage object signed download link', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      key,
      expiresInSeconds: DOWNLOAD_LINK_EXPIRES_SECONDS,
    });
    res.json({
      ok: true,
      url,
      expiresInSeconds: DOWNLOAD_LINK_EXPIRES_SECONDS,
      expiresAt: Date.now() + DOWNLOAD_LINK_EXPIRES_SECONDS * 1000,
    });
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
    const isPrefix = req.query.prefix === '1';
    const client = getS3Client(bucket);
    const keys = isPrefix
      ? await listObjectKeysByPrefix(client, bucket, key.endsWith('/') ? key : `${key}/`)
      : [key];
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
    await Promise.all(
      keys.map(async (objectKey) => {
        const record = await getFileRecordByBucketPath(bucket.id, objectKey);
        if (record) await deleteFileRecord(record.id);
      }),
    );
    res.json({ ok: true });
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
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: bucket.bucketName,
          Key: nextKey,
        }),
      );
      const oldRecord = await getFileRecordByBucketPath(bucket.id, objectKey);
      if (oldRecord) await deleteFileRecord(oldRecord.id);
      const record = await createFileRecord(
        bucket.id,
        req.userKeyAuth!.userId,
        req.userKeyAuth!.user,
        nextKey,
        objectDisplayName(nextKey),
        head.ContentLength || 0,
        head.ContentType || oldRecord?.contentType || null,
        {
          eTag: head.ETag || null,
          lastModified: head.LastModified?.getTime() || Date.now(),
          storageClass: head.StorageClass || null,
          metadata: oldRecord?.metadata || null,
          source: oldRecord?.source || 'studio',
        },
      );
      return { key: nextKey, id: record.id };
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
    const isPrefix = Boolean(req.body?.isPrefix);
    const keys = isPrefix
      ? await listObjectKeysByPrefix(client, bucket, key.endsWith('/') ? key : `${key}/`)
      : [key];
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

    res.json({ ok: true, key, publicUrl: isPrefix ? undefined : publicObjectUrl(bucket, key) });
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
    const isPrefix = Boolean(req.body?.isPrefix);
    const keys = isPrefix
      ? await listObjectKeysByPrefix(client, bucket, key.endsWith('/') ? key : `${key}/`)
      : [key];
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

    res.json({ ok: true, key });
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
        { expiresIn: UPLOAD_LINK_EXPIRES_SECONDS },
      );
      return {
        name: input.name,
        key: input.key,
        size: input.size,
        contentType: input.contentType,
        url,
        headers: { 'Content-Type': input.contentType },
        expiresInSeconds: UPLOAD_LINK_EXPIRES_SECONDS,
      };
    });

    log.info('Created storage direct upload links', {
      ...bucketLogMeta(bucket),
      requestedBy: req.userKeyAuth!.user,
      relativePath: relativePath || '(root)',
      fileCount: uploads.length,
      totalBytes: uploads.reduce((sum, file) => sum + file.size, 0),
    });
    res.json({ uploads, expiresInSeconds: UPLOAD_LINK_EXPIRES_SECONDS });
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
        mode: 'storage',
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
    const userId = req.userKeyAuth!.userId;
    const username = req.userKeyAuth!.user;
    const completedInputs = [];

    for (const item of completedFiles) {
      const key = stringProp(item, 'key') || '';
      const relativePath = normalizeBucketPath(stringProp(item, 'relativePath'));
      const basePrefix = bucketListPrefix(bucket);
      if (!key || (basePrefix && !key.startsWith(basePrefix))) {
        sendApiError(res, 400, 'Completed object key is outside the configured bucket path');
        return;
      }
      const name = stringProp(item, 'name') || objectDisplayName(key);
      const contentType = stringProp(item, 'contentType') || null;
      completedInputs.push({ key, name, contentType, relativePath });
    }

    const results = await mapWithConcurrency(completedInputs, S3_CONCURRENCY, async (item) => {
      const head = await client.send(
        new HeadObjectCommand({
          Bucket: bucket.bucketName,
          Key: item.key,
        }),
      );
      const record = await createFileRecord(
        bucket.id,
        userId,
        username,
        item.key,
        item.name,
        head.ContentLength || 0,
        head.ContentType || item.contentType,
        {
          eTag: head.ETag || null,
          lastModified: head.LastModified?.getTime() || Date.now(),
          storageClass: head.StorageClass || null,
          metadata: { relativePath: item.relativePath },
          source: 'studio',
        },
      );
      return { id: record.id, name: record.name, size: record.size, key: record.path };
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

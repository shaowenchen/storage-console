import { randomUUID } from 'crypto';
import { getAdapter } from '../internal.js';
import { rowToStorageFile } from '../rowMappers.js';
import { sqlPlaceholders } from '../sql.js';
import type { StorageFile } from '../types.js';

export async function createFileRecord(
  bucketId: string,
  userId: string,
  username: string,
  path: string,
  name: string,
  size: number,
  contentType: string | null,
  fields: {
    eTag?: string | null;
    lastModified?: number | null;
    storageClass?: string | null;
    metadata?: Record<string, unknown> | null;
    source?: string;
  } = {},
): Promise<StorageFile> {
  const db = await getAdapter();
  const now = Date.now();
  const file: StorageFile = {
    id: randomUUID(),
    bucketId,
    userId,
    username,
    path,
    name,
    size,
    contentType,
    eTag: fields.eTag || null,
    lastModified: fields.lastModified ?? null,
    storageClass: fields.storageClass || null,
    metadata: fields.metadata || null,
    source: fields.source || 'studio',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const existing = await db.get(
    'SELECT id, created_at FROM storage_files WHERE bucket_id = ? AND path = ?',
    [bucketId, path],
  );
  if (existing) {
    file.id = existing.id as string;
    file.createdAt = Number(existing.created_at);
    await db.run(
      `UPDATE storage_files
       SET user_id = ?, username = ?, name = ?, size = ?, content_type = ?,
           etag = ?, last_modified = ?, storage_class = ?, metadata = ?, source = ?,
           updated_at = ?, deleted_at = NULL
       WHERE id = ?`,
      [
        file.userId,
        file.username,
        file.name,
        file.size,
        file.contentType,
        file.eTag,
        file.lastModified,
        file.storageClass,
        JSON.stringify(file.metadata || null),
        file.source,
        file.updatedAt,
        file.id,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO storage_files (
        id, bucket_id, user_id, username, path, name, size, content_type,
        etag, last_modified, storage_class, metadata, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.id,
        file.bucketId,
        file.userId,
        file.username,
        file.path,
        file.name,
        file.size,
        file.contentType,
        file.eTag,
        file.lastModified,
        file.storageClass,
        JSON.stringify(file.metadata || null),
        file.source,
        file.createdAt,
        file.updatedAt,
      ],
    );
  }

  return file;
}

export async function listFiles(
  bucketId: string,
  userId?: string,
  options: { includeDeleted?: boolean; pathPrefix?: string } = {},
): Promise<StorageFile[]> {
  const db = await getAdapter();
  const deletedFilter = options.includeDeleted ? '' : 'AND deleted_at IS NULL';
  const prefixFilter = options.pathPrefix ? 'AND path LIKE ?' : '';
  const prefixParams = options.pathPrefix ? [`${options.pathPrefix}%`] : [];
  if (userId) {
    const rows = await db.all(
      `SELECT * FROM storage_files WHERE bucket_id = ? AND user_id = ? ${deletedFilter} ${prefixFilter} ORDER BY created_at DESC`,
      [bucketId, userId, ...prefixParams],
    );
    return rows.map(rowToStorageFile);
  }
  const rows = await db.all(
    `SELECT * FROM storage_files WHERE bucket_id = ? ${deletedFilter} ${prefixFilter} ORDER BY created_at DESC`,
    [bucketId, ...prefixParams],
  );
  return rows.map(rowToStorageFile);
}

export async function getFileRecord(fileId: string): Promise<StorageFile | undefined> {
  const db = await getAdapter();
  const row = await db.get('SELECT * FROM storage_files WHERE id = ?', [fileId]);
  return row ? rowToStorageFile(row) : undefined;
}

export async function getFileRecordByBucketPath(
  bucketId: string,
  path: string,
): Promise<StorageFile | undefined> {
  const db = await getAdapter();
  const row = await db.get('SELECT * FROM storage_files WHERE bucket_id = ? AND path = ?', [
    bucketId,
    path,
  ]);
  return row ? rowToStorageFile(row) : undefined;
}

export async function listFilesByBucketPaths(
  bucketId: string,
  paths: string[],
): Promise<StorageFile[]> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!uniquePaths.length) return [];
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT * FROM storage_files WHERE bucket_id = ? AND path IN (${sqlPlaceholders(uniquePaths.length)})`,
    [bucketId, ...uniquePaths],
  );
  return rows.map(rowToStorageFile);
}

export async function listFileRecordsByIds(ids: string[]): Promise<StorageFile[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT * FROM storage_files WHERE id IN (${sqlPlaceholders(uniqueIds.length)})`,
    uniqueIds,
  );
  return rows.map(rowToStorageFile);
}

export async function deleteFileRecord(fileId: string): Promise<void> {
  const db = await getAdapter();
  await db.run('UPDATE storage_files SET deleted_at = ?, updated_at = ? WHERE id = ?', [
    Date.now(),
    Date.now(),
    fileId,
  ]);
}

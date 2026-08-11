import { decryptCredential } from '../utils/credentialsCrypto.js';
import type { Bucket, StorageFile } from './types.js';

export function rowToBucket(row: Record<string, unknown>): Bucket {
  return {
    id: row.id as string,
    name: row.name as string,
    storageType: (row.storage_type as string) || 'ObjectStorage',
    endpoint: row.endpoint as string,
    region: (row.region as string) || '',
    accessKey: decryptCredential(row.access_key as string),
    secretKey: decryptCredential(row.secret_key as string),
    bucketName: row.bucket_name as string,
    bucketPath: (row.bucket_path as string) || '',
    createdBy: row.created_by as string,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  };
}

export function rowToStorageFile(row: Record<string, unknown>): StorageFile {
  return {
    id: row.id as string,
    bucketId: row.bucket_id as string,
    userId: row.user_id as string,
    username: row.username as string,
    path: row.path as string,
    name: row.name as string,
    size: Number(row.size),
    contentType: (row.content_type as string) || null,
    eTag: (row.etag as string) || null,
    lastModified:
      row.last_modified === null || row.last_modified === undefined
        ? null
        : Number(row.last_modified),
    storageClass: (row.storage_class as string) || null,
    metadata: row.metadata ? (JSON.parse(row.metadata as string) as Record<string, unknown>) : null,
    source: (row.source as string) || 'studio',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  };
}

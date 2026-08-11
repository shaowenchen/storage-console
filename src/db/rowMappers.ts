import { decryptCredential } from '../utils/credentialsCrypto.js';
import { createLogger } from '../utils/logger.js';
import type { Bucket } from './types.js';

const log = createLogger('rowMappers');

function credentialString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value == null) return '';
  return String(value);
}

/** Decrypt at-rest credentials; never throw (wrong key / corrupt ciphertext → empty). */
function decryptBucketCredential(
  value: unknown,
  field: 'access_key' | 'secret_key',
  bucketId: string,
): string {
  const raw = credentialString(value);
  if (!raw) return '';
  try {
    return decryptCredential(raw);
  } catch (error) {
    log.warn('Failed to decrypt bucket credential', {
      bucketId,
      field,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

export function rowToBucket(row: Record<string, unknown>): Bucket {
  const id = row.id as string;
  return {
    id,
    name: row.name as string,
    storageType: (row.storage_type as string) || 'ObjectStorage',
    endpoint: row.endpoint as string,
    region: (row.region as string) || '',
    accessKey: decryptBucketCredential(row.access_key, 'access_key', id),
    secretKey: decryptBucketCredential(row.secret_key, 'secret_key', id),
    bucketName: row.bucket_name as string,
    bucketPath: (row.bucket_path as string) || '',
    createdBy: row.created_by as string,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  };
}

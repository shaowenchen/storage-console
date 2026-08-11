import { randomUUID } from 'crypto';
import { encryptCredential, isEncryptedCredential } from '../../utils/credentialsCrypto.js';
import { getAdapter } from '../internal.js';
import { rowToBucket } from '../rowMappers.js';
import type { Bucket } from '../types.js';

export async function createBucket(
  name: string,
  storageType: string,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
  bucketName: string,
  bucketPath: string,
  createdBy: string,
): Promise<Bucket> {
  const db = await getAdapter();
  const now = Date.now();
  const bucket: Bucket = {
    id: randomUUID(),
    name,
    storageType: storageType || 'ObjectStorage',
    endpoint,
    region: region || '',
    accessKey,
    secretKey,
    bucketName,
    bucketPath,
    createdBy,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  await db.run(
    `INSERT INTO buckets (id, name, storage_type, endpoint, region, access_key, secret_key, bucket_name, bucket_path, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bucket.id,
      bucket.name,
      bucket.storageType,
      bucket.endpoint,
      bucket.region,
      encryptCredential(bucket.accessKey),
      encryptCredential(bucket.secretKey),
      bucket.bucketName,
      bucket.bucketPath,
      bucket.createdBy,
      bucket.createdAt,
      bucket.updatedAt,
    ],
  );

  return bucket;
}

export async function listBuckets(options: { includeDeleted?: boolean } = {}): Promise<Bucket[]> {
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT * FROM buckets ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY created_at ASC`,
    [],
  );
  return rows.map(rowToBucket);
}

export async function getBucketById(id: string): Promise<Bucket | undefined> {
  const db = await getAdapter();
  const row = await db.get('SELECT * FROM buckets WHERE id = ?', [id]);
  return row ? rowToBucket(row) : undefined;
}

export async function deleteBucket(id: string): Promise<void> {
  const db = await getAdapter();
  const now = Date.now();
  await db.run('UPDATE storage_files SET deleted_at = ?, updated_at = ? WHERE bucket_id = ?', [
    now,
    now,
    id,
  ]);
  await db.run('UPDATE buckets SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
}

export async function restoreBucket(id: string): Promise<void> {
  const db = await getAdapter();
  const now = Date.now();
  await db.run('UPDATE storage_files SET deleted_at = NULL, updated_at = ? WHERE bucket_id = ?', [
    now,
    id,
  ]);
  await db.run('UPDATE buckets SET deleted_at = NULL, updated_at = ? WHERE id = ?', [now, id]);
}

export async function permanentlyDeleteBucket(id: string): Promise<void> {
  const db = await getAdapter();
  await db.run('DELETE FROM storage_files WHERE bucket_id = ?', [id]);
  await db.run('DELETE FROM buckets WHERE id = ?', [id]);
}

export async function updateBucket(
  id: string,
  fields: {
    name?: string;
    storageType?: string;
    endpoint?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    bucketName?: string;
    bucketPath?: string;
  },
): Promise<Bucket | undefined> {
  const db = await getAdapter();
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (fields.name !== undefined) {
    setClauses.push('name = ?');
    params.push(fields.name);
  }
  if (fields.storageType !== undefined) {
    setClauses.push('storage_type = ?');
    params.push(fields.storageType);
  }
  if (fields.endpoint !== undefined) {
    setClauses.push('endpoint = ?');
    params.push(fields.endpoint);
  }
  if (fields.region !== undefined) {
    setClauses.push('region = ?');
    params.push(fields.region);
  }
  if (fields.accessKey !== undefined) {
    setClauses.push('access_key = ?');
    params.push(encryptCredential(fields.accessKey));
  }
  if (fields.secretKey !== undefined) {
    setClauses.push('secret_key = ?');
    params.push(encryptCredential(fields.secretKey));
  }
  if (fields.bucketName !== undefined) {
    setClauses.push('bucket_name = ?');
    params.push(fields.bucketName);
  }
  if (fields.bucketPath !== undefined) {
    setClauses.push('bucket_path = ?');
    params.push(fields.bucketPath);
  }

  if (setClauses.length === 0) return getBucketById(id);

  setClauses.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  await db.run(`UPDATE buckets SET ${setClauses.join(', ')} WHERE id = ?`, params);

  const row = await db.get('SELECT * FROM buckets WHERE id = ?', [id]);
  return row ? rowToBucket(row) : undefined;
}

export async function migratePlaintextBucketCredentials(): Promise<number> {
  const db = await getAdapter();
  const rows = await db.all('SELECT id, access_key, secret_key FROM buckets', []);
  let migrated = 0;
  for (const row of rows) {
    const accessKey = String(row.access_key || '');
    const secretKey = String(row.secret_key || '');
    const needsAccess = accessKey && !isEncryptedCredential(accessKey);
    const needsSecret = secretKey && !isEncryptedCredential(secretKey);
    if (!needsAccess && !needsSecret) continue;
    await db.run('UPDATE buckets SET access_key = ?, secret_key = ? WHERE id = ?', [
      needsAccess ? encryptCredential(accessKey) : accessKey,
      needsSecret ? encryptCredential(secretKey) : secretKey,
      row.id,
    ]);
    migrated += 1;
  }
  return migrated;
}

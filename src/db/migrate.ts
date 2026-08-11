import type { DatabaseAdapter } from './adapter.js';
import { ensureAuthKeys } from './repos/authKeys.js';

async function ensureColumn(
  adapter: DatabaseAdapter,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const cols = await adapter.columns(table);
  if (cols.has(column)) return;
  await adapter.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureIndex(
  adapter: DatabaseAdapter,
  table: string,
  name: string,
  columns: string,
): Promise<void> {
  const indexes = await adapter.indexes(table);
  if (indexes.has(name)) return;
  await adapter.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns})`);
}

let storageTablesReady: Promise<void> | undefined;

export async function ensureStorageTables(adapter: DatabaseAdapter): Promise<void> {
  storageTablesReady ||= ensureStorageTablesOnce(adapter);
  await storageTablesReady;
}

export function resetMigrateForTests(): void {
  storageTablesReady = undefined;
}

async function ensureStorageTablesOnce(adapter: DatabaseAdapter): Promise<void> {
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS buckets (
      id VARCHAR(36) PRIMARY KEY,
      name TEXT NOT NULL,
      storage_type VARCHAR(64) NOT NULL DEFAULT 'ObjectStorage',
      endpoint TEXT NOT NULL,
      region VARCHAR(64) NOT NULL DEFAULT '',
      access_key TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      bucket_name TEXT NOT NULL,
      bucket_path VARCHAR(1024) NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT
    );
  `);

  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS storage_files (
      id VARCHAR(36) PRIMARY KEY,
      bucket_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      username TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size BIGINT NOT NULL,
      content_type TEXT,
      etag TEXT,
      last_modified BIGINT,
      storage_class TEXT,
      metadata TEXT,
      source VARCHAR(32) NOT NULL DEFAULT 'studio',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0,
      deleted_at BIGINT
    );
  `);

  await ensureColumn(adapter, 'buckets', 'bucket_path', "VARCHAR(1024) NOT NULL DEFAULT ''");
  await ensureColumn(
    adapter,
    'buckets',
    'storage_type',
    "VARCHAR(64) NOT NULL DEFAULT 'ObjectStorage'",
  );
  await ensureColumn(adapter, 'buckets', 'deleted_at', 'BIGINT');
  await adapter.run(`UPDATE buckets SET region = '' WHERE region = 'auto'`, []);
  await ensureColumn(adapter, 'storage_files', 'etag', 'TEXT');
  await ensureColumn(adapter, 'storage_files', 'last_modified', 'BIGINT');
  await ensureColumn(adapter, 'storage_files', 'storage_class', 'TEXT');
  await ensureColumn(adapter, 'storage_files', 'metadata', 'TEXT');
  await ensureColumn(adapter, 'storage_files', 'source', "VARCHAR(32) NOT NULL DEFAULT 'studio'");
  await ensureColumn(adapter, 'storage_files', 'updated_at', 'BIGINT NOT NULL DEFAULT 0');
  await ensureColumn(adapter, 'storage_files', 'deleted_at', 'BIGINT');
  await ensureIndex(adapter, 'buckets', 'idx_buckets_deleted_created', 'deleted_at, created_at');
  await ensureIndex(adapter, 'storage_files', 'idx_storage_files_bucket_path', 'bucket_id, path');
  await ensureIndex(
    adapter,
    'storage_files',
    'idx_storage_files_bucket_deleted_created',
    'bucket_id, deleted_at, created_at',
  );

  await migrateAuthKeysTable(adapter);
  await ensureAuthKeys(adapter);
}

async function tableExists(adapter: DatabaseAdapter, name: string): Promise<boolean> {
  const row = await adapter.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return Boolean(row);
}

/** Prefer auth_keys; rename legacy app_keys when present. */
async function migrateAuthKeysTable(adapter: DatabaseAdapter): Promise<void> {
  const hasAuthKeys = await tableExists(adapter, 'auth_keys');
  const hasAppKeys = await tableExists(adapter, 'app_keys');

  if (!hasAuthKeys && hasAppKeys) {
    await adapter.exec(`ALTER TABLE app_keys RENAME TO auth_keys`);
    return;
  }

  if (!hasAuthKeys) {
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS auth_keys (
        type TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        rotated_at BIGINT
      );
    `);
  }

  if (hasAppKeys && hasAuthKeys) {
    await adapter.exec(`
      INSERT OR IGNORE INTO auth_keys (type, key, created_at, rotated_at)
      SELECT type, key, created_at, rotated_at FROM app_keys
    `);
    await adapter.exec(`DROP TABLE IF EXISTS app_keys`);
  }
}

export async function migrateSchema(adapter: DatabaseAdapter): Promise<void> {
  await ensureStorageTables(adapter);
}

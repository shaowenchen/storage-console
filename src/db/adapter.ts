import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';

export interface DatabaseAdapter {
  type: 'sqlite';
  exec(sql: string): Promise<void>;
  get(sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  columns(table: string): Promise<Set<string>>;
  indexes(table: string): Promise<Set<string>>;
  transaction(fn: () => Promise<void>): Promise<void>;
}

function defaultDbPath(): string {
  return `${homedir()}/.storage-console/storage-console.sqlite`;
}

function parseDSN(): { path: string } {
  const dsn = process.env.SQL_DSN;
  if (!dsn) return { path: defaultDbPath() };

  if (dsn.startsWith('sqlite://')) {
    let path = dsn.slice('sqlite://'.length);
    if (!path.startsWith('/')) path = '/' + path;
    return { path };
  }

  return { path: dsn };
}

async function createSqliteAdapter(dbPath: string): Promise<DatabaseAdapter> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  const adapter: DatabaseAdapter = {
    type: 'sqlite',
    async exec(sql) {
      db.exec(sql);
    },
    async get(sql, params) {
      return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    },
    async all(sql, params) {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    async run(sql, params) {
      db.prepare(sql).run(...params);
    },
    async columns(table) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    },
    async indexes(table) {
      const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter;
}

let adapter: DatabaseAdapter | undefined;
let adapterInit: Promise<DatabaseAdapter> | undefined;

export async function getAdapter(
  onReady?: (adapter: DatabaseAdapter) => Promise<void>,
): Promise<DatabaseAdapter> {
  if (!adapterInit) {
    adapterInit = (async () => {
      const { path } = parseDSN();
      adapter = await createSqliteAdapter(path);
      if (onReady) {
        await onReady(adapter);
      }
      return adapter;
    })();
  }
  return adapterInit;
}

export function resetAdapterForTests(): void {
  adapter = undefined;
  adapterInit = undefined;
}

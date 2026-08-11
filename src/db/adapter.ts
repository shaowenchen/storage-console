import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';

export interface DatabaseAdapter {
  type: 'sqlite' | 'mysql';
  exec(sql: string): Promise<void>;
  get(sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  columns(table: string): Promise<Set<string>>;
  indexes(table: string): Promise<Set<string>>;
  transaction(fn: () => Promise<void>): Promise<void>;
}

export type ParsedSqlDsn = { type: 'sqlite'; path: string } | { type: 'mysql'; dsn: string };

function defaultDbPath(): string {
  return `${homedir()}/.storage-console/storage-console.sqlite`;
}

/** Exported for unit tests. */
export function parseSqlDsn(dsn: string | undefined): ParsedSqlDsn {
  if (!dsn) return { type: 'sqlite', path: defaultDbPath() };

  if (dsn.startsWith('mysql://')) return { type: 'mysql', dsn };

  if (dsn.startsWith('sqlite://')) {
    let path = dsn.slice('sqlite://'.length);
    if (!path.startsWith('/')) path = '/' + path;
    return { type: 'sqlite', path };
  }

  return { type: 'sqlite', path: dsn };
}

/** Exported for unit tests. Matches Studio: only `tls=skip-verify` is special-cased. */
export function mysqlSslFromDsn(dsn: string): { rejectUnauthorized: boolean } {
  const url = new URL(dsn);
  return url.searchParams.get('tls') === 'skip-verify'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };
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

async function createMysqlAdapter(dsn: string): Promise<DatabaseAdapter> {
  const url = new URL(dsn);
  const pool = mysql.createPool({
    host: url.hostname,
    port: parseInt(url.port, 10) || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    waitForConnections: true,
    connectionLimit: 10,
    ssl: mysqlSslFromDsn(dsn),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyRow = any;

  let mysqlTxConnection: mysql.PoolConnection | null = null;

  async function mysqlExecute(sql: string, params: unknown[]) {
    if (mysqlTxConnection) {
      return mysqlTxConnection.execute(sql, params as AnyRow[]);
    }
    return pool.execute(sql, params as AnyRow[]);
  }

  const adapter: DatabaseAdapter = {
    type: 'mysql',
    async exec(sql) {
      await mysqlExecute(sql, []);
    },
    async get(sql, params) {
      const [rows] = (await mysqlExecute(sql, params)) as AnyRow[];
      return rows[0] as Record<string, unknown> | undefined;
    },
    async all(sql, params) {
      const [rows] = (await mysqlExecute(sql, params)) as AnyRow[];
      return rows as Record<string, unknown>[];
    },
    async run(sql, params) {
      await mysqlExecute(sql, params);
    },
    async columns(table) {
      const [rows] = (await mysqlExecute(`SHOW COLUMNS FROM \`${table}\``, [])) as AnyRow[];
      return new Set((rows as Array<{ Field: string }>).map((r) => r.Field));
    },
    async indexes(table) {
      const [rows] = (await mysqlExecute(`SHOW INDEX FROM \`${table}\``, [])) as AnyRow[];
      return new Set((rows as Array<{ Key_name: string }>).map((r) => r.Key_name));
    },
    async transaction(fn) {
      const connection = await pool.getConnection();
      mysqlTxConnection = connection;
      try {
        await connection.beginTransaction();
        await fn();
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        mysqlTxConnection = null;
        connection.release();
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
      const config = parseSqlDsn(process.env.SQL_DSN);
      if (config.type === 'mysql') {
        adapter = await createMysqlAdapter(config.dsn);
      } else {
        adapter = await createSqliteAdapter(config.path);
      }
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

# MySQL Support Design

## Goal

Add MySQL 8+ (including TiDB Cloud / MySQL-protocol compatible clouds) alongside the existing SQLite backend, matching Studio’s `SQL_DSN` + `DatabaseAdapter` pattern.

## Decisions

| Topic                         | Choice                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Engines                       | MySQL 8+ / TiDB Cloud; keep SQLite as default                                                           |
| Driver                        | `mysql2` (promise API), same as Studio                                                                  |
| Data migration SQLite → MySQL | None (greenfield on MySQL)                                                                              |
| TLS                           | DSN query `tls=skip-verify` → `ssl.rejectUnauthorized = false`; otherwise `true`                        |
| Table prefix                  | None — use a **dedicated** database (do not share Studio’s DB; this app uses `buckets` / `auth_keys`) |
| ORM                           | None — extend existing adapter                                                                          |

## Architecture

```
SQL_DSN → parseDSN() → createSqliteAdapter | createMysqlAdapter
getDb() → getAdapter(migrateSchema) → repos / authKeyStore
```

- `DatabaseAdapter.type`: `'sqlite' | 'mysql'`
- Repos stay driver-agnostic; continue using `?` placeholders
- MySQL pool: `connectionLimit: 10`, `waitForConnections: true`
- MySQL transactions: sticky `PoolConnection` during `transaction()` (Studio pattern)

## DSN

| Value                                            | Behavior                                                   |
| ------------------------------------------------ | ---------------------------------------------------------- |
| unset / empty                                    | SQLite at `~/.storage-console/storage-console.sqlite`      |
| `sqlite://…`                                     | Custom SQLite path                                         |
| `mysql://user:pass@host:port/db?tls=skip-verify` | MySQL / TiDB                                               |
| other                                            | Treated as bare SQLite filesystem path (Studio-compatible) |

Document in `.env.example`. Recommend a dedicated DB name such as `storage_console`.

## Schema / migrations

Keep programmatic `migrate.ts` (no SQL files).

Dialect-aware helpers:

1. **`tableExists`** — SQLite: `sqlite_master`; MySQL: `information_schema.tables` (or equivalent).
2. **`ensureIndex`** — SQLite: `CREATE INDEX IF NOT EXISTS`; MySQL: check `indexes()` then `CREATE INDEX` (no `IF NOT EXISTS`). For TEXT path indexes on MySQL, use prefix lengths (e.g. `path(512)`) like Studio.
3. **`INSERT OR IGNORE`** (legacy `app_keys` → `auth_keys`) — MySQL: `INSERT IGNORE`.
4. **`auth_keys.key`** — MySQL reserved word: quote as `` `key` `` in DDL and DML (SQLite accepts backticks too). Prefer `VARCHAR` PK for `type` on MySQL-friendly DDL (`VARCHAR(32)`).

No SQLite→MySQL data import tool.

## Out of scope

- MariaDB-specific dialects
- Automatic cross-engine data migration
- Table prefixes / sharing Studio’s database
- CI MySQL service matrix (unit tests remain on temp SQLite; optional follow-up)

## Testing

- Existing SQLite temp-DSN tests keep passing
- Add unit coverage for `parseDSN` / TLS mapping (no live TiDB required)
- Manual smoke: point `SQL_DSN` at MySQL/TiDB, start app, add a storage

## Docs

- Update `.env.example` with MySQL DSN example + `tls=skip-verify` note
- Clarify dedicated database vs Studio

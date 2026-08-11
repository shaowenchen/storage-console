# MySQL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MySQL 8+ / TiDB Cloud support via `SQL_DSN=mysql://…`, mirroring Studio’s adapter pattern while keeping SQLite as the default.

**Architecture:** Extend `DatabaseAdapter` with a `mysql2` pool implementation; dialect-aware migrations for indexes, `tableExists`, and reserved `` `key` ``; repos keep `?` SQL.

**Tech Stack:** `mysql2`, `better-sqlite3`, existing Express app, vitest

## Global Constraints

- Mirror Studio’s DSN/TLS behavior (`tls=skip-verify` only)
- No SQLite→MySQL data migration tool
- No table prefixes; dedicated database recommended
- Do not share Studio’s MySQL database (colliding `buckets` / `storage_files`)
- Tests stay on temp SQLite unless otherwise noted
- Commit + push after each completed task when that workflow is active

---

### Task 1: MySQL adapter + DSN parsing

**Files:**

- Modify: `src/db/adapter.ts`
- Modify: `package.json` (add `mysql2`)
- Create: `src/db/adapter.test.ts` (parseDSN / type selection via env — export test helpers or test through getAdapter with mocks carefully; prefer exporting `parseDSNForTests` or testing SSL option via a small pure parse helper)
- Modify: `.env.example`

**Interfaces:**

- Produces: `DatabaseAdapter.type: 'sqlite' | 'mysql'`; `parseDSN` returns mysql | sqlite configs; `createMysqlAdapter(dsn)`

- [ ] **Step 1:** Add `mysql2` dependency
- [ ] **Step 2:** Port Studio’s `parseDSN` + `createMysqlAdapter` (no users table bootstrap)
- [ ] **Step 3:** Unit-test DSN classification + `tls=skip-verify` mapping
- [ ] **Step 4:** Update `.env.example`; commit

### Task 2: Dialect-aware migrations + auth_keys quoting

**Files:**

- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/authKeys.ts`

**Interfaces:**

- Consumes: `adapter.type`
- Produces: MySQL-safe `ensureIndex`, `tableExists`, `` `key` `` quoted SQL

- [ ] **Step 1:** Quote `` `key` `` in authKeys repo SQL + auth_keys DDL
- [ ] **Step 2:** Branch `tableExists`, `ensureIndex`, `INSERT IGNORE`
- [ ] **Step 3:** MySQL index prefix for `path` where needed
- [ ] **Step 4:** Run existing vitest; commit

### Task 3: Verification

**Files:** none required

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint`
- [ ] **Step 2:** Fix any failures; final commit + push

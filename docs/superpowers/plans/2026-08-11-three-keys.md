# Three-Key Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split auth into login (env), upload/download (auto-generated in SQLite), and remove `SESSION_SECRET`/`UPLOAD_KEY` env vars by persisting an internal session key.

**Architecture:** New `auth_keys` table + in-memory cache bootstrapped before `listen`. Middleware distinguishes session / upload / download. Profile APIs expose and rotate upload/download. UI shows both keys in the sidebar.

**Tech Stack:** Express, better-sqlite3, vitest, React (existing web app)

## Global Constraints

- Login key (`ADMIN_USER_KEY`) is env-only and cannot authenticate business APIs via `X-API-Key`.
- Upload/download/session keys: generate with `randomBytes(32).toString('base64url')`, persist in SQLite, survive restarts.
- Session key is internal: not returned by HTTP, no rotate API.
- `CREDENTIALS_SECRET` remains optional; else use persisted session key.
- Remove `SESSION_SECRET` and `UPLOAD_KEY` from env example and production checks.
- Bootstrap DB + keys before HTTP server listens.
- Prefer existing patterns; no new markdown docs beyond this plan/spec.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/db/migrate.ts` | Create `auth_keys` table |
| `src/db/repos/authKeys.ts` | Ensure/get/rotate key rows |
| `src/services/authKeyStore.ts` | Bootstrap + in-memory cache; sync getters used by session/crypto |
| `src/config/env.ts` | Drop session/upload env; login-only production check |
| `src/middleware/session.ts` | Sign cookies with cached session key |
| `src/middleware/adminAuth.ts` | Session-only `requireAuth`; upload/download API keys; new download middleware |
| `src/routes/auth.ts` | Profile keys list/get/rotate |
| `src/routes/storage.ts` | Download routes use download auth |
| `src/index.ts` | Await bootstrap before listen |
| `web/src/shared/upload/api.ts` | Fetch download key helpers |
| `web/src/features/auth/ApiKeysPanel.tsx` | Copy + rotate UI |
| `web/src/app/shell/Sidebar.tsx` | Mount API keys panel |
| `.env.example` / `.env` | Remove obsolete vars |
| `src/db/repos/authKeys.test.ts` | Unit tests for ensure/rotate |
| `src/middleware/adminAuth.test.ts` | Auth matrix tests |

---

### Task 1: `auth_keys` persistence

**Files:**
- Modify: `src/db/migrate.ts`
- Create: `src/db/repos/authKeys.ts`
- Create: `src/db/repos/authKeys.test.ts`

**Interfaces:**
- Produces:
  - `export type AuthKeyType = 'upload' | 'download' | 'session'`
  - `export async function ensureAuthKeys(adapter: DatabaseAdapter): Promise<void>`
  - `export async function getAuthKey(adapter: DatabaseAdapter, type: AuthKeyType): Promise<string>`
  - `export async function rotateAuthKey(adapter: DatabaseAdapter, type: 'upload' | 'download'): Promise<string>`

- [ ] **Step 1: Add table to migrate + call ensure**

In `ensureStorageTablesOnce`, after existing tables, add:

```sql
CREATE TABLE IF NOT EXISTS auth_keys (
  type TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  rotated_at BIGINT
);
```

At end of `ensureStorageTablesOnce`, `await ensureAuthKeys(adapter)`.

- [ ] **Step 2: Implement repo**

```ts
import { randomBytes } from 'crypto';
import type { DatabaseAdapter } from '../adapter.js';

export type AuthKeyType = 'upload' | 'download' | 'session';

function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

export async function ensureAuthKeys(adapter: DatabaseAdapter): Promise<void> {
  const now = Date.now();
  for (const type of ['upload', 'download', 'session'] as const) {
    const row = await adapter.get(`SELECT type FROM auth_keys WHERE type = ?`, [type]);
    if (!row) {
      await adapter.run(
        `INSERT INTO auth_keys (type, key, created_at, rotated_at) VALUES (?, ?, ?, NULL)`,
        [type, generateKey(), now],
      );
    }
  }
}

export async function getAuthKey(adapter: DatabaseAdapter, type: AuthKeyType): Promise<string> {
  const row = await adapter.get(`SELECT key FROM auth_keys WHERE type = ?`, [type]);
  if (!row?.key || typeof row.key !== 'string') {
    throw new Error(`Missing app key: ${type}`);
  }
  return row.key;
}

export async function rotateAuthKey(
  adapter: DatabaseAdapter,
  type: 'upload' | 'download',
): Promise<string> {
  const next = generateKey();
  const now = Date.now();
  await adapter.run(`UPDATE auth_keys SET key = ?, rotated_at = ? WHERE type = ?`, [
    next,
    now,
    type,
  ]);
  return next;
}
```

- [ ] **Step 3: Unit test with temp SQLite**

Use `SQL_DSN` pointing at a temp file + `resetAdapterForTests` + `getDb`. Cover: ensure creates three keys; second ensure keeps same values; rotate upload changes only upload.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/db/repos/authKeys.test.ts`
Expected: PASS

---

### Task 2: In-memory key store + env cleanup

**Files:**
- Create: `src/services/authKeyStore.ts`
- Modify: `src/config/env.ts`
- Modify: `src/middleware/session.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`, `.env`

**Interfaces:**
- Consumes: `ensureAuthKeys` / `getAuthKey` / `rotateAuthKey` from Task 1; `getDb` from connection
- Produces:
  - `export async function bootstrapAuthKeys(): Promise<void>`
  - `export function getCachedAuthKey(type: AuthKeyType): string`
  - `export async function rotateCachedAuthKey(type: 'upload' | 'download'): Promise<string>`
  - `getSessionSecret()` / `getCredentialsSecret()` / `getUploadKey()` / `getDownloadKey()` read cache

- [ ] **Step 1: Implement `authKeyStore`**

Cache object filled by `bootstrapAuthKeys` (getDb already migrates). Sync getters throw if not bootstrapped. `rotateCachedAuthKey` updates DB then cache.

- [ ] **Step 2: Wire env helpers**

- Remove `DEFAULT_SESSION_SECRET` and env `SESSION_SECRET` / `UPLOAD_KEY`.
- `getSessionSecret()` → `getCachedAuthKey('session')`.
- `getCredentialsSecret()` → env `CREDENTIALS_SECRET` or session cache.
- `getUploadKey()` / `getDownloadKey()` → cache.
- Production validation: only `ADMIN_USER_KEY` (drop session secret check).

- [ ] **Step 3: Bootstrap before listen**

```ts
async function start() {
  validateProductionConfig();
  await bootstrapAuthKeys();
  const app = createApp();
  // listen...
}
void start();
```

- [ ] **Step 4: Update `.env.example` and `.env`**

Remove `SESSION_SECRET` and `UPLOAD_KEY` lines/comments. Keep `ADMIN_USER_KEY` and optional `CREDENTIALS_SECRET`.

---

### Task 3: Auth middleware + routes

**Files:**
- Modify: `src/middleware/adminAuth.ts`
- Create: `src/middleware/adminAuth.test.ts`
- Modify: `src/routes/auth.ts`
- Modify: `src/routes/storage.ts` (download routes only)

**Interfaces:**
- Produces: `keyType: 'login' | 'upload' | 'download'`; `requireDownloadAuth`; `requireAdminDownloadAuth`
- `authenticateUserKey` matches upload/download from cache only

- [ ] **Step 1: Middleware matrix**

- `requireAuth`: session only.
- `requireUploadAuth`: session or upload key.
- `requireDownloadAuth`: session or download key.
- `requireAdmin*`: same as today but wrapping the above.
- Login key never succeeds in `authenticateUserKey`.

- [ ] **Step 2: Auth routes**

```
GET  /profile/keys           -> { upload, download }
GET  /profile/keys/upload    -> { type, key }
GET  /profile/keys/download  -> { type, key }
POST /profile/keys/:type/rotate  type in upload|download
```

All require session (`requireAuth`).

- [ ] **Step 3: Storage download routes**

Change `download-object` and `download-object-link` from `requireAdmin` to `requireAdminDownloadAuth`.

- [ ] **Step 4: Tests for auth matrix**

Vitest covering: login key rejected for upload/download authenticate; upload accepted only as upload; download only as download.

- [ ] **Step 5: `npx vitest run` + `npm run typecheck`**

---

### Task 4: Frontend API keys UI

**Files:**
- Modify: `web/src/shared/upload/api.ts`
- Create: `web/src/features/auth/ApiKeysPanel.tsx`
- Modify: `web/src/app/shell/Sidebar.tsx`
- Existing CSS classes / minimal new styles in existing stylesheet if needed

- [ ] **Step 1: API helpers**

`getApiKeys()`, `getDownloadKey()`, `rotateApiKey(type)`.

- [ ] **Step 2: `ApiKeysPanel`**

Show upload + download with copy; rotate button with confirm; load on mount when logged in.

- [ ] **Step 3: Mount in Sidebar footer** above Sign out.

- [ ] **Step 4: `npm run typecheck`**

---

### Task 5: Verification

- [ ] **Step 1: Run `npx vitest run`, `npm run lint`, `npm run typecheck`**
- [ ] **Step 2: Manual smoke** — login with `ADMIN_USER_KEY`; view keys; upload modal still loads upload key; rotate upload; old upload key 401 on upload-script path.

---

## Spec coverage check

| Spec item | Task |
|-----------|------|
| auth_keys table + ensure on migrate | 1 |
| Auto-gen upload/download/session | 1–2 |
| Remove SESSION_SECRET / UPLOAD_KEY | 2 |
| Login key login-only | 3 |
| Session full console | 3 (unchanged requireAdmin via session) |
| Upload/download API isolation | 3 |
| Profile get/rotate APIs | 3 |
| Download routes download auth | 3 |
| UI copy/rotate | 4 |
| Bootstrap before listen | 2 |
| CREDENTIALS_SECRET optional fallback | 2 |

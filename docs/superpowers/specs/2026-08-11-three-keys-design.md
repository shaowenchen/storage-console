# Three-Key Auth Design

Date: 2026-08-11

## Goal

Split credentials into three business keys, minimize required environment variables, and keep browser sessions working without a manually configured `SESSION_SECRET`.

## Decisions

| Key                | Source                                              | Purpose                                                                                         | Visible in UI                   |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| Login              | Env `ADMIN_USER_KEY`                                | Sign-in only (`POST /auth/login`)                                                               | Configured by operator          |
| Upload             | Auto-generated, SQLite `auth_keys`                  | `X-API-Key` for upload APIs; copy into Pull & Run scripts                                       | Yes (view / copy / rotate)      |
| Download           | Auto-generated, SQLite `auth_keys`                  | `X-API-Key` for download APIs; copy for read-only scripts                                       | Yes (view / copy / rotate)      |
| Session (internal) | Auto-generated, SQLite `auth_keys` (`type=session`) | HMAC for session cookies; fallback for S3 credential encryption when `CREDENTIALS_SECRET` unset | No (not exposed, no rotate API) |

### Privilege rules

- Login key **must not** authenticate business APIs via `X-API-Key`.
- After login, the **session cookie** retains full console access (upload + download UI and admin routes).
- Upload key: upload routes only; cannot download.
- Download key: download routes only; cannot upload.
- Scripts/automation must use the matching upload or download key.

### Environment variables

**Keep**

- `ADMIN_USER_KEY` — required in production (strong unique value).
- `CREDENTIALS_SECRET` — optional override for encrypting S3 credentials at rest.

**Remove**

- `SESSION_SECRET`
- `UPLOAD_KEY`

Production validation checks only `ADMIN_USER_KEY` (plus existing non-auth config as today). No production requirement for session/upload/download secrets in env.

## Data model

```sql
CREATE TABLE IF NOT EXISTS auth_keys (
  type TEXT PRIMARY KEY,          -- 'upload' | 'download' | 'session'
  key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  rotated_at BIGINT
);
```

### Lifecycle

1. On migrate / DB ready: ensure rows for `upload`, `download`, and `session`.
2. If a type is missing: generate `crypto.randomBytes(32).toString('base64url')`, insert with `created_at`.
3. Keys persist across restarts.
4. Rotate (upload/download only): overwrite `key`, set `rotated_at`; old value invalid immediately.
5. Keys stored in plaintext in SQLite (same trust model as local admin console DB file permissions).

## Auth middleware

| Middleware                         | Accepts                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Login handler                      | `ADMIN_USER_KEY` body only                                                             |
| `requireAuth` / admin console APIs | **Session cookie only** — `X-API-Key` with login/upload/download keys is rejected here |
| `requireUploadAuth`                | Session **or** upload key                                                              |
| `requireDownloadAuth` (new)        | Session **or** download key                                                            |

`authenticateUserKey` resolves only upload/download keys from `auth_keys` (never `ADMIN_USER_KEY`). Session auth remains via signed cookie using the persisted session key.

### Route mapping

- Existing upload script / upload-links / upload-complete paths: keep upload auth.
- `download-object` and `download-object-link`: switch to `requireDownloadAuth` (session or download key).
- Other management routes: session/admin as today.

## HTTP API

All profile key endpoints require an authenticated **session** (login).

| Method | Path                                  | Behavior                                                   |
| ------ | ------------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/auth/profile/keys`              | `{ upload, download }`                                     |
| `GET`  | `/api/auth/profile/keys/upload`       | `{ type: 'upload', key }` (keep for existing Upload Modal) |
| `GET`  | `/api/auth/profile/keys/download`     | `{ type: 'download', key }`                                |
| `POST` | `/api/auth/profile/keys/:type/rotate` | `type` ∈ `upload` \| `download`; returns new key           |

Do not expose or rotate `session` via HTTP.

## UI

- Upload Modal: continue loading upload key for curl / Pull & Run command.
- Simple API Keys surface after login: show upload + download, copy buttons, rotate actions.
- Keep UI minimal (no full settings product); place near existing user/header or upload entry points.
- Download key usable for scripting and for copying into read-only automation contexts.

## Internal wiring

- Replace `getSessionSecret()` env read with async/sync accessor backed by `auth_keys.type = 'session'` (loaded once after DB init, cached in memory).
- `getCredentialsSecret()`: env `CREDENTIALS_SECRET` if set, else persisted session key.
- Remove `getUploadKey()` env fallback; load upload/download from `auth_keys`.
- Ensure DB migrate + `auth_keys` bootstrap complete **before** the HTTP server listens, so cookie signing and API-key auth never race on a missing session/upload/download key.

## Out of scope

- Multi-user or per-user keys
- Public share pages that skip session using only download key
- Env overrides for upload/download/session keys
- Encrypting `auth_keys` rows at rest beyond DB file permissions

## Migration / compatibility notes

- Existing deployments with `UPLOAD_KEY` / `SESSION_SECRET` in `.env`: values are ignored after this change; new keys are generated in SQLite on first boot with the new schema.
- Operators must re-copy upload (and new download) keys from the console after upgrade.
- Existing session cookies signed with old `SESSION_SECRET` become invalid; users re-login with `ADMIN_USER_KEY`.
- If S3 credentials were encrypted with old `SESSION_SECRET` / `CREDENTIALS_SECRET`, keep `CREDENTIALS_SECRET` set to the previous effective secret when upgrading, or re-enter bucket credentials after upgrade if the encryption key changes.

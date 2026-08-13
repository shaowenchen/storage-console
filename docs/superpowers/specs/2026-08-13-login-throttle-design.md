# Login brute-force throttle (in-memory)

## Goal

Protect `POST /api/auth/login` from credential stuffing / brute force with exponential lockout keyed by client IP.

## Decisions

| Topic | Choice |
|-------|--------|
| Scope | Web login only (not upload/download API keys) |
| Threshold | Lock starting at **3** consecutive failures |
| Duration | First lock **30s**, then **×2** per further failure, cap **1 hour** |
| Success | Clears attempt state for that IP |
| Storage | **In-memory** for now; DB persistence is a later swap behind the same store API |
| Idle reset | Unlocked + no failure for **1 hour** → failure counter resets |
| Response | **429** `login_locked` + `Retry-After` while locked; **401** on bad key |

## Flow

1. Resolve client IP (`X-Forwarded-For` first hop, else socket address).
2. If locked → 429 with remaining seconds (do not verify key / do not increment).
3. Empty key → 400 (does not count as a failure).
4. Wrong key → record failure; may become locked; return 401.
5. Correct key → clear IP state; set session cookie.

## Admin UI

Profile → Account shows **Login lock** status (`Unlocked` / `Locked (N IPs)`), lists tracked IPs with failure/lock remaining, and **Unlock** / **Unlock all** via:

- `GET /api/auth/profile/login-lock`
- `POST /api/auth/profile/login-lock/unlock` body `{ ip? }`

## Follow-up

- Persist attempts in SQLite/MySQL for multi-instance / restart durability.
- Optional: extend similar throttle to `X-API-Key` auth failures.

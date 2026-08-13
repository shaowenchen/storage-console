# Object Text Preview/Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ⋮ menu Preview/Edit for text objects (incl. `.json`) via same-origin server proxy, ≤1MB, overwrite-with-confirm.

**Architecture:** Admin-only `GET/PUT /api/storages/:id/object-content` proxy Head/Get/PutObject. UI opens `ObjectTextModal` from menu when extension looks like text; server re-checks MIME + size.

**Tech Stack:** Express + AWS SDK S3, React modal matching existing `modal-overlay` styles, vitest for text helpers.

---

### Task 1: Text helpers + tests

- [x] `src/services/objectText.ts` — extension whitelist, MIME allowlist, 1MB limit, content-type guess
- [x] `src/services/objectText.test.ts`

### Task 2: API routes

- [x] `GET /:id/object-content?key=` — Head gate → GetObject UTF-8 body + headers
- [x] `PUT /:id/object-content` — JSON body overwrite PutObject
- [x] Raise `express.json` limit to 2mb

### Task 3: Frontend

- [x] Menu Preview/Edit when extension matches
- [x] `ObjectTextModal` + API client
- [x] Wire `StoragesPage` state

### Task 4: Verify

- [x] `npm test` + `npm run typecheck`
- [ ] Commit + push

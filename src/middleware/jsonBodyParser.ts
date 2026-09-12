import type { NextFunction, Request, Response } from 'express';
import express from 'express';

/**
 * The browser's same-origin upload proxy: `PUT /api/storages/:id/upload-object`
 * (see the route of the same name). That request's body is the file itself.
 *
 * Anchored on the `:id` segment rather than a bare suffix so that a storage
 * whose id happens to be `upload-object` does not disable JSON parsing for the
 * metadata routes mounted at its path.
 */
const RAW_OBJECT_UPLOAD_PATH = /\/storages\/[^/]+\/upload-object$/i;

/**
 * True when the request carries a raw object body that must reach the route
 * handler unread.
 *
 * A file named `report.json` is uploaded with `Content-Type: application/json`,
 * which the global `express.json()` matches on content type alone. It would then
 * buffer the whole file and fail on it either way — `entity.parse.failed` when
 * the bytes are not valid JSON, `entity.too.large` past the 2mb limit — before
 * the upload route ever runs. Worse, the failed parser leaves the body consumed,
 * so the route could not stream it to the object store as a fallback either.
 */
export function isRawObjectUploadRequest(req: Request): boolean {
  if (req.method !== 'PUT') return false;
  // Express matches routes case-insensitively, so this check has to as well.
  return RAW_OBJECT_UPLOAD_PATH.test(req.path.replace(/\/+$/, ''));
}

/** `express.json()` that stands aside for raw object uploads. */
export function jsonBodyParser() {
  const parser = express.json({ limit: '2mb' });
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isRawObjectUploadRequest(req)) {
      next();
      return;
    }
    parser(req, res, next);
  };
}

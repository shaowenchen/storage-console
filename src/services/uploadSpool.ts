import { createWriteStream } from 'fs';
import { mkdir, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { UPLOAD_SPOOL_TTL_MS } from '../config/upload.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('upload-spool');

/**
 * A request body spooled to disk, and the promise that it gets removed.
 *
 * Holding a part in memory or in a pipe means it can only be sent to the
 * storage once — a consumed stream cannot be replayed, so the first storage-side
 * hiccup fails the part and the browser has to send it again. A file can be read
 * as many times as needed, which is what lets the server retry the upload on its
 * own instead of asking the client to resend bytes it already delivered.
 */
export interface SpooledBody {
  path: string;
  bytes: number;
}

const SPOOL_PREFIX = 'upload-part-';

/**
 * Root under which this process's spool directory lives.
 *
 * Resolved per call rather than frozen at import. The rest of the upload
 * configuration is read once at module load, which is fine for a value an
 * operator sets at deploy time — but this one decides where bytes are written,
 * and reading it lazily is what lets a test point it at a throwaway directory
 * and actually verify the files land there (and are cleaned up), instead of
 * silently writing to the real temporary directory.
 */
function spoolRoot(): string {
  const configured = (process.env.UPLOAD_SPOOL_DIR || '').trim();
  return configured || tmpdir();
}

/**
 * Directory holding in-flight part files.
 *
 * Named per process: several instances may share a machine's temporary
 * directory, and a sweep must only ever touch files this process could have
 * written. Without that, one instance starting up would delete another's
 * in-flight parts.
 */
function spoolDir(): string {
  return join(spoolRoot(), `${SPOOL_PREFIX}${process.pid}`);
}

/**
 * Stream `source` to a file, refusing to write more than `maxBytes`.
 *
 * The cap is enforced as the bytes arrive rather than after the fact, so a
 * request larger than a part cannot fill the disk before being rejected. The
 * caller supplies the exact expected length, which it can derive from the signed
 * session, so this is a hard boundary rather than a best-effort guess.
 *
 * The caller must call {@link removeSpooled} on every path, including failures —
 * `withSpooled` exists to make that automatic.
 */
export async function spoolToDisk(source: Readable, maxBytes: number): Promise<SpooledBody> {
  const dir = spoolDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomBytes(16).toString('hex')}.part`);

  return new Promise<SpooledBody>((resolve, reject) => {
    const out = createWriteStream(path, { mode: 0o600 });
    let bytes = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      // Abandoning the file is not enough — a partial part left behind is
      // exactly the leak this module exists to prevent.
      void removeSpooled({ path }).finally(() => reject(err));
    };

    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        source.destroy();
        out.destroy();
        fail(new Error(`Body exceeds the ${maxBytes} byte part limit`));
        return;
      }
      // Backpressure: pause the source while the disk catches up, so a large
      // part cannot balloon into an in-memory buffer behind the write stream.
      if (!out.write(chunk)) {
        source.pause();
        out.once('drain', () => source.resume());
      }
    });

    source.on('error', (err: Error) => {
      out.destroy();
      fail(err);
    });

    out.on('error', (err: Error) => {
      source.destroy();
      fail(err);
    });

    source.on('end', () => {
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve({ path, bytes });
      });
    });
  });
}

/** Delete a spooled file, tolerating the case where it is already gone. */
export async function removeSpooled(body: Pick<SpooledBody, 'path'>): Promise<void> {
  await rm(body.path, { force: true }).catch((err: unknown) => {
    // A file that cannot be removed is worth a log line rather than a thrown
    // error: this runs on failure paths, where masking the real cause with a
    // cleanup error is the worst possible outcome.
    log.warn('Failed to remove spooled upload part', {
      path: body.path,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Run `fn` with a spooled body, removing the file whatever happens.
 *
 * Every caller wants the same guarantee, so it lives here rather than being
 * repeated as a `finally` at each call site — where one omission leaks a file
 * until the next sweep.
 */
export async function withSpooled<T>(
  source: Readable,
  maxBytes: number,
  fn: (body: SpooledBody) => Promise<T>,
): Promise<T> {
  const body = await spoolToDisk(source, maxBytes);
  try {
    return await fn(body);
  } finally {
    await removeSpooled(body);
  }
}

/**
 * Remove spooled files left behind by earlier processes.
 *
 * A process that is killed mid-upload cannot clean up after itself, and on a
 * platform where instances are replaced routinely that is a normal event rather
 * than an exceptional one. Sweeping at startup bounds the leak to the lifetime
 * of one process.
 *
 * Only files older than the TTL are removed, so a concurrently starting instance
 * cannot lose a part that is still being written.
 */
export async function sweepAbandonedSpools(now = Date.now()): Promise<number> {
  const base = spoolRoot();
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    // No directory yet means nothing has ever spooled.
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(SPOOL_PREFIX)) continue;
    const dir = join(base, entry);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      // A directory belonging to a live process is left alone.
      // A directory belonging to any live process is left alone — including
      // this one, whose in-flight parts are not abandoned merely because they
      // are old. Pid reuse can mean an unrelated process inherits the number;
      // leaving its directory a while longer is the harmless side of that
      // trade, where deleting a live instance's parts is not.
      const pid = Number(entry.slice(SPOOL_PREFIX.length));
      if (Number.isInteger(pid) && isProcessAlive(pid)) continue;
      if (now - info.mtimeMs < UPLOAD_SPOOL_TTL_MS) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Racing another instance's sweep is expected; nothing to report.
    }
  }

  if (removed) log.info('Swept abandoned upload spool directories', { removed });
  return removed;
}

/** Whether a process id is currently running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means it exists but belongs to another user.
    return (err as { code?: string })?.code === 'EPERM';
  }
}

/** The spool directory this process writes to; for tests and diagnostics. */
export function currentSpoolDir(): string {
  return spoolDir();
}

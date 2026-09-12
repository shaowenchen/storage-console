import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeSpooled, spoolToDisk, sweepAbandonedSpools, withSpooled } from './uploadSpool.js';

/**
 * Spooling exists so a part can be sent to the storage more than once, and the
 * files it creates are the price. These tests are mostly about the price: a
 * spooled file must never outlive the request that produced it, on any path,
 * including the ones that fail.
 */

let root: string;
let previousSpoolDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spool-test-'));
  previousSpoolDir = process.env.UPLOAD_SPOOL_DIR;
  // Read at import time by the config module, so these tests exercise the
  // helpers against a throwaway directory rather than the real temp root.
  process.env.UPLOAD_SPOOL_DIR = root;
});

afterEach(() => {
  if (previousSpoolDir === undefined) delete process.env.UPLOAD_SPOOL_DIR;
  else process.env.UPLOAD_SPOOL_DIR = previousSpoolDir;
  rmSync(root, { recursive: true, force: true });
});

function body(bytes: number): Readable {
  return Readable.from([Buffer.alloc(bytes, 0x61)]);
}

/** Files currently spooled by this process. */
function spooledFiles(): string[] {
  try {
    return readdirSync(join(root, `upload-part-${process.pid}`));
  } catch {
    return [];
  }
}

describe('spoolToDisk', () => {
  it('writes the body and reports its exact length', async () => {
    const spooled = await spoolToDisk(body(1024), 1024);
    try {
      expect(spooled.bytes).toBe(1024);
      const onDisk = await createReadStream(spooled.path).toArray();
      expect(Buffer.concat(onDisk).length).toBe(1024);
    } finally {
      await removeSpooled(spooled);
    }
  });

  it('refuses a body larger than the cap instead of writing it', async () => {
    // The cap is the part size derived from the signed session, so a client
    // cannot make the server write more than a part to disk.
    await expect(spoolToDisk(body(2048), 1024)).rejects.toThrow(/exceeds/);
  });

  it('leaves nothing behind when the cap is exceeded', async () => {
    await expect(spoolToDisk(body(4096), 1024)).rejects.toThrow(/exceeds/);
    // The partial write must be cleaned up, not merely abandoned.
    expect(spooledFiles()).toHaveLength(0);
  });

  it('leaves nothing behind when the source stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(16, 0x61));
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(spoolToDisk(failing, 1024)).rejects.toThrow('connection reset');
    expect(spooledFiles()).toHaveLength(0);
  });

  it('accepts a body of exactly the cap, which is the normal case', async () => {
    const spooled = await spoolToDisk(body(512), 512);
    try {
      expect(spooled.bytes).toBe(512);
    } finally {
      await removeSpooled(spooled);
    }
  });
});

describe('withSpooled', () => {
  it('removes the file after the work succeeds', async () => {
    const seen = await withSpooled(body(256), 256, async (spooled) => {
      expect(spooled.bytes).toBe(256);
      expect(spooledFiles()).toHaveLength(1);
      return 'done';
    });
    expect(seen).toBe('done');
    expect(spooledFiles()).toHaveLength(0);
  });

  it('removes the file when the work throws', async () => {
    // This is the case that matters: the storage call failed, and the part must
    // not be left on disk while the error propagates to the client.
    await expect(
      withSpooled(body(256), 256, async () => {
        throw new Error('storage exploded');
      }),
    ).rejects.toThrow('storage exploded');
    expect(spooledFiles()).toHaveLength(0);
  });

  it('never spools a body over the cap, so nothing is left to clean up', async () => {
    await expect(withSpooled(body(4096), 256, async () => 'unreachable')).rejects.toThrow(/exceeds/);
    expect(spooledFiles()).toHaveLength(0);
  });
});

describe('removeSpooled', () => {
  it('is safe to call twice, since cleanup paths can overlap', async () => {
    const spooled = await spoolToDisk(body(64), 64);
    await removeSpooled(spooled);
    await expect(removeSpooled(spooled)).resolves.toBeUndefined();
  });
});

describe('sweepAbandonedSpools', () => {
  /** A spool directory as a dead process would have left it. */
  function abandonedDir(pid: number, ageMs: number): string {
    const dir = join(root, `upload-part-${pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leftover.part'), Buffer.alloc(32, 0x61));
    const when = new Date(Date.now() - ageMs);
    utimesSync(dir, when, when);
    return dir;
  }

  it('removes spools left by a process that is long gone', async () => {
    // A pid that cannot be running; the sweep must not keep its files forever.
    abandonedDir(999999, 2 * 60 * 60 * 1000);
    const removed = await sweepAbandonedSpools();
    expect(removed).toBe(1);
    expect(readdirSync(root).filter((n) => n.startsWith('upload-part-'))).toHaveLength(0);
  });

  it('leaves a recent spool alone even if its process is gone', async () => {
    // Another instance may still be writing it; deleting it would fail a part.
    abandonedDir(999998, 1000);
    const removed = await sweepAbandonedSpools();
    expect(removed).toBe(0);
    expect(readdirSync(root).filter((n) => n.startsWith('upload-part-'))).toHaveLength(1);
  });

  it('never removes the directory belonging to a running process', async () => {
    // This process is alive, so its own spools are not abandoned regardless of
    // how old they look.
    const dir = join(root, `upload-part-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
    utimesSync(dir, old, old);
    const removed = await sweepAbandonedSpools();
    expect(removed).toBe(0);
  });

  it('is a no-op when nothing has ever spooled', async () => {
    rmSync(root, { recursive: true, force: true });
    await expect(sweepAbandonedSpools()).resolves.toBe(0);
  });
});

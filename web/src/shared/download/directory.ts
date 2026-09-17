/**
 * Write a folder's objects into a directory the user picks.
 *
 * This is the path that keeps the tree: the browser can create real
 * subdirectories, so `logs/a/x.txt` and `logs/b/x.txt` stay distinct instead of
 * colliding in the download folder. It needs the bytes in JavaScript, so it
 * fetches each object from a signed bucket URL — which means the bucket has to
 * allow GET from this origin. There is deliberately no fallback to proxying the
 * bytes through the console: that would put every object of a large folder on
 * the server's back, so a bucket that cannot be read directly is reported
 * instead.
 */

/** The subset of FileSystemDirectoryHandle this module needs. */
export type DirectoryHandleLike = {
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<DirectoryHandleLike>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandleLike>;
};

export type WritableFileHandleLike = {
  createWritable: () => Promise<WritableSinkLike>;
};

export type WritableSinkLike = {
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

export type DirectoryDownloadEntry = {
  /** Path under the picked directory, ending in a file name. */
  segments: string[];
  url: string;
};

export type DirectoryDownloadOptions = {
  /** Concurrent files. Kept small: these are disk writes, not just requests. */
  concurrency?: number;
  /** Injected in tests. */
  fetchImpl?: (url: string) => Promise<ResponseLike>;
  onProgress?: (written: number, total: number) => void;
  signal?: AbortSignal;
};

export type ResponseLike = {
  ok: boolean;
  status: number;
  /** Absent on a bodyless response, which is treated as an empty file. */
  body?: ReadableStream<Uint8Array> | null;
  /** Used only to report a useful failure. */
  text?: () => Promise<string>;
};

export type DirectoryDownloadResult = {
  written: number;
  failed: Array<{ segments: string[]; reason: string }>;
};

export const DEFAULT_DIRECTORY_CONCURRENCY = 4;

/**
 * Characters no common filesystem accepts: the C0 control range and the
 * Windows-reserved set. Written with escapes so the source stays plain ASCII.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_SEGMENT_CHARS = /[\u0000-\u001f<>:"/\\|?*]/g;
/** Windows refuses these names whatever the extension case. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Make one path segment safe to use as a file or directory name.
 *
 * Object keys are arbitrary strings, so a key can contain a `/`-free segment
 * that is still unusable — `..`, a Windows-reserved name like `con`, or a name
 * with a `?` in it. Anything rejected is folded to `_` rather than dropped, so
 * two distinct keys do not silently collapse into one name.
 */
export function sanitizeSegment(segment: string): string {
  let name = String(segment ?? '')
    .replace(UNSAFE_SEGMENT_CHARS, '_')
    .trim();

  // Trailing dots and spaces are stripped by Windows, which would make the
  // written name differ from the key.
  name = name.replace(/[. ]+$/, '');

  // `..` and `.` would escape or alias the target directory.
  if (!name || name === '.' || name === '..') return '';
  if (RESERVED_NAMES.test(name)) return `_${name}`;
  // Keep room for the extension when the filesystem's limit is 255 bytes.
  if (name.length > 200) name = `${name.slice(0, 200)}_`;
  return name;
}

/**
 * The path segments an object key should be written under, relative to the
 * folder being downloaded.
 *
 * `logs/deep/b.txt` under `logs/` becomes `['deep', 'b.txt']`. A key that does
 * not share the prefix keeps its own path minus any leading slash, so a
 * mismatch degrades to writing the object rather than dropping it.
 */
export function relativeDownloadSegments(objectKey: string, basePrefix: string): string[] {
  const base = String(basePrefix ?? '').replace(/^\/+|\/+$/g, '');
  let relative = String(objectKey ?? '');

  if (base && (relative === base || relative.startsWith(`${base}/`))) {
    relative = relative === base ? '' : relative.slice(base.length + 1);
  } else {
    relative = relative.replace(/^\/+/, '');
  }

  return relative.split('/').filter(Boolean).map(sanitizeSegment).filter(Boolean);
}

/** Walk (creating as needed) to the directory a file will be written into. */
async function resolveDirectory(
  root: DirectoryHandleLike,
  segments: string[],
): Promise<DirectoryHandleLike> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function writeEntry(
  root: DirectoryHandleLike,
  entry: DirectoryDownloadEntry,
  fetchImpl: (url: string) => Promise<ResponseLike>,
): Promise<void> {
  const segments = entry.segments;
  if (!segments.length) throw new Error('Object key has no usable file name');

  const fileName = segments[segments.length - 1]!;
  const parent = await resolveDirectory(root, segments.slice(0, -1));

  const response = await fetchImpl(entry.url);
  if (!response.ok) {
    throw new Error(`Storage returned ${response.status}`);
  }

  const fileHandle = await parent.getFileHandle(fileName, { create: true });
  const sink = await fileHandle.createWritable();

  try {
    if (response.body) {
      // Streamed, so a large object is never held in memory in one piece.
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await sink.write(value);
      }
    }
    await sink.close();
  } catch (err) {
    // Leave no half-written file behind.
    await sink.abort?.().catch(() => {});
    throw err;
  }
}

/**
 * Point one file at a time at `run`, up to `concurrency` at once.
 *
 * Local to this module because the server's equivalent is not shipped to the
 * browser, and this is the only client-side caller.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Fetch every entry and write it under `root`, preserving the folder structure.
 *
 * One failure does not stop the rest: the caller gets back what was written and
 * what was not, so a single unreadable object cannot fail the whole folder.
 */
export async function downloadIntoDirectory(
  root: DirectoryHandleLike,
  entries: DirectoryDownloadEntry[],
  options: DirectoryDownloadOptions = {},
): Promise<DirectoryDownloadResult> {
  const {
    concurrency = DEFAULT_DIRECTORY_CONCURRENCY,
    fetchImpl = (url: string) => fetch(url),
    onProgress,
    signal,
  } = options;

  const failed: DirectoryDownloadResult['failed'] = [];
  let written = 0;

  await runPool(entries, Math.max(1, concurrency), async (entry) => {
    if (signal?.aborted) return;
    try {
      await writeEntry(root, entry, fetchImpl);
      written += 1;
    } catch (err) {
      failed.push({
        segments: entry.segments,
        reason: readableFetchError(err),
      });
    }
    onProgress?.(written, entries.length);
  });

  return { written, failed };
}

/**
 * A `fetch` failure surfaces as an opaque "Failed to fetch", which for a signed
 * bucket URL nearly always means the bucket refused the cross-origin read. Say
 * so, since the fix is on the bucket rather than in this app.
 */
export function readableFetchError(err: unknown): string {
  if (err instanceof TypeError) {
    return 'Could not read from the bucket — its CORS policy may not allow GET from this site';
  }
  return err instanceof Error ? err.message : String(err);
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
};

/** Whether this browser offers the directory picker (Chromium only). */
export function supportsDirectoryPicker(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

/**
 * Ask the user for a directory to write into.
 *
 * Must be called directly from a user gesture: the picker requires transient
 * activation, and awaiting anything first can spend it.
 *
 * Returns null when the user dismisses the picker.
 */
export async function pickDirectory(): Promise<DirectoryHandleLike | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot write to a chosen directory');
  try {
    return await picker({ mode: 'readwrite' });
  } catch (err) {
    // Dismissing the picker is a decision, not an error.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

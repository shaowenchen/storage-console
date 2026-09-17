import { describe, expect, it } from 'vitest';
import {
  downloadIntoDirectory,
  readableFetchError,
  relativeDownloadSegments,
  sanitizeSegment,
  type DirectoryHandleLike,
  type ResponseLike,
  type WritableSinkLike,
} from './directory.js';

/** An in-memory stand-in for the picked directory, recording what is written. */
function fakeDirectory() {
  const files = new Map<string, string>();
  const removed: string[] = [];

  function handle(path: string): DirectoryHandleLike {
    return {
      getDirectoryHandle: async (name) => handle(path ? `${path}/${name}` : name),
      getFileHandle: async (name) => {
        const full = path ? `${path}/${name}` : name;
        return {
          createWritable: async (): Promise<WritableSinkLike> => {
            let buffer = '';
            let closed = false;
            return {
              write: async (data) => {
                buffer += Buffer.from(data).toString('utf8');
              },
              close: async () => {
                closed = true;
                files.set(full, buffer);
              },
              abort: async () => {
                if (!closed) removed.push(full);
              },
            };
          },
        };
      },
    };
  }

  return { root: handle(''), files, removed };
}

function bodyResponse(text: string): ResponseLike {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe('sanitizeSegment', () => {
  it('leaves ordinary names untouched', () => {
    // The regression this guards: a character *range* written by mistake
    // swallowed letters, digits, `-` and `_`.
    expect(sanitizeSegment('file-01_test.txt')).toBe('file-01_test.txt');
    expect(sanitizeSegment('my report (final).tar.gz')).toBe('my report (final).tar.gz');
    expect(sanitizeSegment('说明.txt')).toBe('说明.txt');
  });

  it('replaces characters a filesystem rejects', () => {
    expect(sanitizeSegment('a<b>c.txt')).toBe('a_b_c.txt');
    expect(sanitizeSegment('a:b.txt')).toBe('a_b.txt');
    expect(sanitizeSegment('a|b.txt')).toBe('a_b.txt');
    expect(sanitizeSegment('a?b.txt')).toBe('a_b.txt');
    expect(sanitizeSegment('a\\b.txt')).toBe('a_b.txt');
    expect(sanitizeSegment('a*b.txt')).toBe('a_b.txt');
  });

  it('strips control characters, including a newline', () => {
    expect(sanitizeSegment('a\nb.txt')).toBe('a_b.txt');
    expect(sanitizeSegment('a\u0000b.txt')).toBe('a_b.txt');
    expect(sanitizeSegment('a\tb.txt')).toBe('a_b.txt');
  });

  it('rejects names that would escape or alias the directory', () => {
    expect(sanitizeSegment('..')).toBe('');
    expect(sanitizeSegment('.')).toBe('');
    expect(sanitizeSegment('')).toBe('');
    expect(sanitizeSegment('   ')).toBe('');
  });

  it('defuses Windows-reserved names', () => {
    expect(sanitizeSegment('con')).toBe('_con');
    expect(sanitizeSegment('NUL.txt')).toBe('_NUL.txt');
    expect(sanitizeSegment('com1')).toBe('_com1');
    // Not reserved: only com1-9 are.
    expect(sanitizeSegment('com10')).toBe('com10');
    expect(sanitizeSegment('console.txt')).toBe('console.txt');
  });

  it('strips trailing dots and spaces, which Windows would drop anyway', () => {
    expect(sanitizeSegment('name.txt.')).toBe('name.txt');
    expect(sanitizeSegment('name ')).toBe('name');
  });

  it('caps very long names but keeps them recognisable', () => {
    const long = `${'a'.repeat(500)}.txt`;
    const result = sanitizeSegment(long);
    expect(result.length).toBeLessThanOrEqual(201);
    expect(result.endsWith('_')).toBe(true);
  });
});

describe('relativeDownloadSegments', () => {
  it('keeps the tree below the downloaded folder', () => {
    expect(relativeDownloadSegments('logs/deep/b.txt', 'logs/')).toEqual(['deep', 'b.txt']);
    expect(relativeDownloadSegments('logs/a.txt', 'logs')).toEqual(['a.txt']);
    expect(relativeDownloadSegments('logs/a.txt', 'logs/')).toEqual(['a.txt']);
  });

  it('handles keys at the bucket root', () => {
    expect(relativeDownloadSegments('a/b/c.txt', '')).toEqual(['a', 'b', 'c.txt']);
  });

  it('skips unusable segments rather than collapsing paths', () => {
    expect(relativeDownloadSegments('logs/../etc/passwd', 'logs')).toEqual(['etc', 'passwd']);
  });

  it('falls back to the full key when the prefix does not match', () => {
    // Better to write the object under its own path than to drop it.
    expect(relativeDownloadSegments('other/x.txt', 'logs')).toEqual(['other', 'x.txt']);
  });

  it('returns nothing for a prefix-only key that names no file', () => {
    expect(relativeDownloadSegments('logs/', 'logs')).toEqual([]);
  });
});

describe('downloadIntoDirectory', () => {
  it('writes each object under its own folder, keeping the tree', async () => {
    const dir = fakeDirectory();
    const result = await downloadIntoDirectory(
      dir.root,
      [
        { segments: ['a.txt'], url: 'u1' },
        { segments: ['deep', 'b.txt'], url: 'u2' },
        { segments: ['deep', 'deeper', 'c.txt'], url: 'u3' },
      ],
      { fetchImpl: async () => bodyResponse('hello') },
    );

    expect(result.written).toBe(3);
    expect(result.failed).toEqual([]);
    expect([...dir.files.keys()].sort()).toEqual(['a.txt', 'deep/b.txt', 'deep/deeper/c.txt']);
    expect(dir.files.get('deep/deeper/c.txt')).toBe('hello');
  });

  it('keeps same-named files in different folders distinct', async () => {
    const dir = fakeDirectory();
    await downloadIntoDirectory(
      dir.root,
      [
        { segments: ['x', 'same.txt'], url: 'u1' },
        { segments: ['y', 'same.txt'], url: 'u2' },
      ],
      { fetchImpl: async () => bodyResponse('data') },
    );

    expect([...dir.files.keys()].sort()).toEqual(['x/same.txt', 'y/same.txt']);
  });

  it('reports a file that could not be fetched and writes the rest', async () => {
    const dir = fakeDirectory();
    const result = await downloadIntoDirectory(
      dir.root,
      [
        { segments: ['ok.txt'], url: 'u1' },
        { segments: ['bad.txt'], url: 'u2' },
        { segments: ['also-ok.txt'], url: 'u3' },
      ],
      {
        fetchImpl: async (url) => {
          if (url === 'u2') return { ok: false, status: 403, body: null };
          return bodyResponse('x');
        },
      },
    );

    expect(result.written).toBe(2);
    expect(result.failed).toEqual([{ segments: ['bad.txt'], reason: 'Storage returned 403' }]);
    expect(dir.files.has('bad.txt')).toBe(false);
    expect(dir.files.has('also-ok.txt')).toBe(true);
  });

  it('aborts the partial file when a write fails midway', async () => {
    const dir = fakeDirectory();
    const root: DirectoryHandleLike = {
      getDirectoryHandle: dir.root.getDirectoryHandle,
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => {
            throw new Error('disk full');
          },
          close: async () => {},
          abort: async () => {},
        }),
      }),
    };

    const result = await downloadIntoDirectory(root, [{ segments: ['a.txt'], url: 'u' }], {
      fetchImpl: async () => bodyResponse('x'),
    });

    expect(result.written).toBe(0);
    expect(result.failed[0]?.reason).toBe('disk full');
  });

  it('treats a missing body as an empty file rather than failing', async () => {
    const dir = fakeDirectory();
    const result = await downloadIntoDirectory(dir.root, [{ segments: ['empty.txt'], url: 'u' }], {
      fetchImpl: async () => ({ ok: true, status: 200, body: null }),
    });

    expect(result.written).toBe(1);
    expect(dir.files.get('empty.txt')).toBe('');
  });

  it('reports progress as files complete', async () => {
    const dir = fakeDirectory();
    const seen: Array<[number, number]> = [];
    await downloadIntoDirectory(
      dir.root,
      [
        { segments: ['a.txt'], url: 'u1' },
        { segments: ['b.txt'], url: 'u2' },
      ],
      {
        concurrency: 1,
        fetchImpl: async () => bodyResponse('x'),
        onProgress: (written, total) => seen.push([written, total]),
      },
    );

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('writes nothing once aborted', async () => {
    const dir = fakeDirectory();
    const controller = new AbortController();
    controller.abort();

    const result = await downloadIntoDirectory(dir.root, [{ segments: ['a.txt'], url: 'u' }], {
      fetchImpl: async () => bodyResponse('x'),
      signal: controller.signal,
    });

    expect(result.written).toBe(0);
    expect(dir.files.size).toBe(0);
  });
});

describe('readableFetchError', () => {
  it('explains an opaque fetch failure as a likely CORS problem', () => {
    // `fetch` rejects with a bare TypeError for a blocked cross-origin read,
    // which says nothing about the bucket actually being the problem.
    expect(readableFetchError(new TypeError('Failed to fetch'))).toMatch(/CORS/);
  });

  it('passes other errors through', () => {
    expect(readableFetchError(new Error('disk full'))).toBe('disk full');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { downloadSequentially, type DownloadFrame } from './sequential.js';

/** Records the order files were started, so overlap is detectable. */
function harness() {
  const started: string[] = [];
  const removed: string[] = [];
  const pending: Array<{ url: string; resolve: () => void }> = [];

  const createFrame = (url: string): DownloadFrame => {
    started.push(url);
    let resolveLoaded = () => {};
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    pending.push({ url, resolve: resolveLoaded });
    return {
      loaded,
      remove: () => removed.push(url),
    };
  };

  return { createFrame, started, removed, pending };
}

describe('downloadSequentially', () => {
  it('downloads strictly one at a time', async () => {
    const h = harness();
    const promise = downloadSequentially(['a', 'b', 'c'], {
      createFrame: h.createFrame,
      gapMs: 0,
    });

    // Only the first file may be in flight until its frame settles.
    await Promise.resolve();
    expect(h.started).toEqual(['a']);

    h.pending[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.started).toEqual(['a', 'b']);

    h.pending[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.started).toEqual(['a', 'b', 'c']);

    h.pending[2].resolve();
    const result = await promise;
    expect(result.completed).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it('removes each frame after the file', async () => {
    const h = harness();
    const promise = downloadSequentially(['a', 'b'], {
      createFrame: h.createFrame,
      gapMs: 0,
    });

    await Promise.resolve();
    expect(h.removed).toEqual([]);
    h.pending[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.removed).toEqual(['a']);

    h.pending[1].resolve();
    await promise;
    expect(h.removed).toEqual(['a', 'b']);
  });

  it('pauses between files, but not after the last one', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = downloadSequentially(['a', 'b'], { createFrame: h.createFrame });

      h.pending[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      // 'b' waits for the gap before it starts.
      expect(h.started).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(400);
      expect(h.started).toEqual(['a', 'b']);

      // Resolve the last file while the clock is stopped: if a trailing gap
      // existed, the promise could not settle without advancing time.
      h.pending[1].resolve();
      const result = await promise;
      expect(result.completed).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves on when a frame never loads, instead of stalling the queue', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = downloadSequentially(['a', 'b'], {
        createFrame: h.createFrame,
        loadTimeoutMs: 1000,
        gapMs: 0,
      });

      // 'a' never fires load, so only the timeout can advance the queue.
      await vi.advanceTimersByTimeAsync(1200);
      expect(h.started).toEqual(['a', 'b']);

      h.pending[1].resolve();
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result.completed).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed frame and still downloads the rest', async () => {
    const started: string[] = [];
    const createFrame = (url: string): DownloadFrame => {
      started.push(url);
      return {
        loaded: url === 'b' ? Promise.reject(new Error('blocked')) : Promise.resolve(),
        remove: () => {},
      };
    };

    const result = await downloadSequentially(['a', 'b', 'c'], {
      createFrame,
      gapMs: 0,
    });

    // 'b' failed but 'c' was still attempted.
    expect(started).toEqual(['a', 'b', 'c']);
    expect(result.completed).toBe(2);
    expect(result.failed).toEqual([{ url: 'b', reason: 'blocked' }]);
  });

  it('reports progress after each file', async () => {
    const seen: Array<[number, number]> = [];
    const result = await downloadSequentially(['a', 'b'], {
      createFrame: () => ({ loaded: Promise.resolve(), remove: () => {} }),
      gapMs: 0,
      onProgress: (completed, total) => seen.push([completed, total]),
    });

    expect(result.completed).toBe(2);
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('does nothing for an empty list', async () => {
    const h = harness();
    const result = await downloadSequentially([], { createFrame: h.createFrame });
    expect(result).toEqual({ completed: 0, failed: [] });
    expect(h.started).toEqual([]);
  });
});

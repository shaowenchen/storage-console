import { describe, expect, it, vi } from 'vitest';
import { downloadAll, type DownloadFrame } from './batch.js';

function harness() {
  const started: string[] = [];
  const removed: string[] = [];
  const createFrame = (url: string): DownloadFrame => {
    started.push(url);
    return { remove: () => removed.push(url) };
  };
  return { createFrame, started, removed };
}

describe('downloadAll', () => {
  it('hands every URL to the browser', async () => {
    const h = harness();
    const result = await downloadAll(['a', 'b', 'c'], {
      createFrame: h.createFrame,
      gapMs: 0,
    });

    expect(h.started).toEqual(['a', 'b', 'c']);
    expect(result.started).toBe(3);
  });

  it('does not wait for one file before starting the next', async () => {
    // The regression this guards: waiting on a frame's `load` event stalls the
    // batch, because an attachment download never fires it. Every URL must be
    // handed over without any per-file completion wait.
    const h = harness();
    const result = await downloadAll(['a', 'b', 'c', 'd'], {
      createFrame: h.createFrame,
      gapMs: 0,
    });

    expect(result.started).toBe(4);
    expect(h.started).toHaveLength(4);
  });

  it('paces the hand-offs without adding a trailing wait', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = downloadAll(['a', 'b', 'c'], { createFrame: h.createFrame });

      // The first goes out immediately; the rest are paced.
      expect(h.started).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.started).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.started).toEqual(['a', 'b', 'c']);

      // Settles without advancing the clock: no wait after the final URL.
      await expect(promise).resolves.toMatchObject({ started: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every frame alive so in-flight downloads are not cancelled', async () => {
    const h = harness();
    const result = await downloadAll(['a', 'b'], {
      createFrame: h.createFrame,
      gapMs: 0,
    });

    // Removing a frame mid-download can abort it, so the frames stay mounted.
    expect(h.removed).toEqual([]);
    expect(result.frames).toHaveLength(2);
  });

  it('reports progress as each URL goes out', async () => {
    const seen: Array<[number, number]> = [];
    await downloadAll(['a', 'b', 'c'], {
      createFrame: () => ({ remove: () => {} }),
      gapMs: 0,
      onProgress: (started, total) => seen.push([started, total]),
    });

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('skips a URL whose frame could not be created, and continues', async () => {
    const started: string[] = [];
    const createFrame = (url: string): DownloadFrame => {
      if (url === 'b') throw new Error('frame blocked');
      started.push(url);
      return { remove: () => {} };
    };

    const result = await downloadAll(['a', 'b', 'c'], { createFrame, gapMs: 0 });

    expect(started).toEqual(['a', 'c']);
    expect(result.started).toBe(2);
  });

  it('does nothing for an empty list', async () => {
    const h = harness();
    const result = await downloadAll([], { createFrame: h.createFrame });
    expect(result).toEqual({ started: 0, frames: [] });
    expect(h.started).toEqual([]);
  });
});

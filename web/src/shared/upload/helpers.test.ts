import { describe, expect, it } from 'vitest';
import { validateUploadSelection } from './helpers';
import type { UploadLimits } from './types';

const limits: UploadLimits = { maxFiles: 20, maxBytes: 1024 * 1024 * 1024 };

/** Minimal File stand-in — only `name` and `size` are read. */
function file(name: string, size: number): File {
  return { name, size } as File;
}

function files(count: number, size = 10): File[] {
  return Array.from({ length: count }, (_, i) => file(`f${i + 1}.txt`, size));
}

describe('validateUploadSelection', () => {
  it('accepts a selection within both limits', () => {
    expect(validateUploadSelection(files(3), limits)).toBeNull();
  });

  it('accepts a selection exactly at both limits', () => {
    expect(validateUploadSelection(files(20), limits)).toBeNull();
    expect(validateUploadSelection([file('big.bin', limits.maxBytes)], limits)).toBeNull();
  });

  it('rejects an empty selection', () => {
    expect(validateUploadSelection([], limits)).toBe('Choose at least one file');
  });

  it('rejects more files than the server will finalize', () => {
    // Regression: the count is only enforced at finalize, so a 21-file batch
    // used to upload every file and then fail as a whole.
    expect(validateUploadSelection(files(21), limits)).toMatch(/at most 20/);
  });

  it('rejects an oversized file and names it', () => {
    const message = validateUploadSelection(
      [file('ok.txt', 10), file('huge.bin', limits.maxBytes * 2)],
      limits,
    );
    expect(message).toMatch(/huge\.bin/);
    expect(message).toMatch(/2\.00 GB/);
    expect(message).toMatch(/over the 1\.00 GB per-file limit/);
  });

  it('falls back to byte counts when the rounded sizes collide', () => {
    // 1 GB + 1 byte and a 1 GB limit both render as "1.00 GB", which would
    // read as "1.00 GB, over the 1.00 GB limit".
    const message = validateUploadSelection([file('huge.bin', limits.maxBytes + 1)], limits);
    expect(message).toMatch(/1073741825 bytes, over the 1073741824 byte per-file limit/);
  });

  it('counts the remaining oversized files without listing them all', () => {
    const message = validateUploadSelection(
      [file('a.bin', limits.maxBytes + 1), file('b.bin', limits.maxBytes + 1)],
      limits,
    );
    expect(message).toMatch(/a\.bin/);
    expect(message).toMatch(/and 1 more/);
  });

  it('reports the count before the size when both are violated', () => {
    // Fixing one file at a time is the least useful instruction, so the batch
    // shape wins.
    const message = validateUploadSelection(files(21, limits.maxBytes + 1), limits);
    expect(message).toMatch(/at most 20/);
  });

  it('skips server-dependent checks until the limits are known', () => {
    // A failed limits fetch must not block uploading.
    expect(validateUploadSelection(files(100), null)).toBeNull();
    expect(validateUploadSelection([], null)).toBe('Choose at least one file');
  });
});

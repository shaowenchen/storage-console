import { describe, expect, it } from 'vitest';
import {
  ASSUMED_PROXY_BODY_WINDOW_SECONDS,
  MAX_CONCURRENT_UPLOADS,
  MAX_CONCURRENT_UPLOAD_PARTS,
  MAX_QUEUED_UPLOAD_PARTS,
  S3_MIN_PART_BYTES,
  UPLOAD_MAX_PARTS,
  UPLOAD_PART_SIZE_BYTES,
  maxQueuedUploadsFromEnv,
} from './upload.js';

describe('maxQueuedUploadsFromEnv', () => {
  it('treats an explicit 0 as "never wait", not as unset', () => {
    // This is the setting that makes the server refuse rather than queue. Losing
    // it to a falsy-check falls back to the default and silently restores the
    // waiting room, which is the bug this parser exists to avoid.
    expect(maxQueuedUploadsFromEnv('0')).toBe(0);
  });

  it('reads a positive count', () => {
    expect(maxQueuedUploadsFromEnv('8')).toBe(8);
    expect(maxQueuedUploadsFromEnv(' 12 ')).toBe(12);
  });

  it('addresses fractions rather than accepting them', () => {
    expect(maxQueuedUploadsFromEnv('3.7')).toBe(3);
  });

  it('falls back when the value is absent or unusable', () => {
    for (const raw of [undefined, '', '   ', 'many', '-1', '-0.5']) {
      expect(maxQueuedUploadsFromEnv(raw)).toBe(16);
    }
  });

  it('accepts an explicit 0 with different spacing', () => {
    expect(maxQueuedUploadsFromEnv(' 0 ')).toBe(0);
  });
});

/**
 * The part size and the concurrency bounds are what stand between a large upload
 * and the failure this whole path replaced, so the relationships between them are
 * pinned rather than left to whichever value someone edits next.
 */
describe('chunked upload bounds', () => {
  it('keeps a part above the storage minimum, so only the last part may be short', () => {
    expect(UPLOAD_PART_SIZE_BYTES).toBeGreaterThanOrEqual(S3_MIN_PART_BYTES);
  });

  it('sizes a 1GB file well inside the storage part limit', () => {
    const oneGb = 1024 * 1024 * 1024;
    expect(Math.ceil(oneGb / UPLOAD_PART_SIZE_BYTES)).toBeLessThan(UPLOAD_MAX_PARTS);
  });

  it('allows far more concurrent parts than whole files', () => {
    // One browser opens several parts per file by design. If parts shared the
    // whole-file allowance, a single upload would occupy it and starve everyone
    // else — the bound meant to be fair would enforce unfairness.
    expect(MAX_CONCURRENT_UPLOAD_PARTS).toBeGreaterThan(MAX_CONCURRENT_UPLOADS * 2);
    expect(MAX_QUEUED_UPLOAD_PARTS).toBeGreaterThan(0);
  });

  it('keeps a part small enough to clear a typical request-body window', () => {
    // A reverse proxy ends a request body that has not finished within its
    // window — five minutes is the common figure. A part must be comfortably
    // transferable within that on a slow link; at 8 MB it needs ~0.22 Mbps.
    const slowLinkBytesPerSecond = 1024 * 1024; // ~8 Mbps, a poor but real link
    expect(UPLOAD_PART_SIZE_BYTES / slowLinkBytesPerSecond).toBeLessThan(
      ASSUMED_PROXY_BODY_WINDOW_SECONDS,
    );
  });
});

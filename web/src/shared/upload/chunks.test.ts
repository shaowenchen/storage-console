import { describe, expect, it } from 'vitest';
import { planChunks } from './chunks';

/**
 * The invariant this whole upload path rests on: every request the browser
 * sends is bounded, regardless of how large the file is.
 *
 * That is a property of the plan, not of the transfer, so it is pinned here —
 * directly and without a network — rather than only being observable by
 * watching a real upload's requests.
 */
describe('planChunks', () => {
  const MB = 1024 * 1024;
  const partSize = 8 * MB;

  it('never plans a chunk larger than the part size', () => {
    for (const size of [1, partSize - 1, partSize, partSize + 1, 100 * MB, 1024 * MB]) {
      const chunks = planChunks(size, partSize);
      for (const chunk of chunks) {
        expect(chunk.size).toBeLessThanOrEqual(partSize);
      }
    }
  });

  it('covers the file exactly, with no gaps or overlap', () => {
    for (const size of [1, partSize - 1, partSize, partSize + 1, 100 * MB, 1024 * MB]) {
      const chunks = planChunks(size, partSize);
      expect(chunks.reduce((sum, chunk) => sum + chunk.size, 0)).toBe(size);
      // Contiguity: each part starts where the previous one ended.
      let expectedStart = 0;
      for (const chunk of chunks) {
        expect(chunk.start).toBe(expectedStart);
        expect(chunk.end).toBe(chunk.start + chunk.size);
        expectedStart = chunk.end;
      }
    }
  });

  it('numbers parts from 1, in order, with only the last one flagged', () => {
    const chunks = planChunks(20 * MB, partSize);
    expect(chunks.map((chunk) => chunk.partNumber)).toEqual([1, 2, 3]);
    expect(chunks.filter((chunk) => chunk.isLast)).toHaveLength(1);
    expect(chunks[chunks.length - 1]!.isLast).toBe(true);
  });

  it('turns a 1GB file into 128 parts, well inside S3 limits', () => {
    const chunks = planChunks(1024 * MB, partSize);
    expect(chunks).toHaveLength(128);
    expect(chunks[0]!.size).toBe(partSize);
    expect(chunks[127]!.size).toBe(partSize);
  });

  it('gives a short final part the remainder, not a full part', () => {
    // Two full parts plus a remainder, so the last part is the short one.
    const chunks = planChunks(2 * partSize + 1234, partSize);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]!.size).toBe(1234);
    expect(chunks[2]!.isLast).toBe(true);
  });

  it('keeps a file smaller than one part to a single short part', () => {
    const chunks = planChunks(1000, partSize);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ partNumber: 1, start: 0, end: 1000, size: 1000, isLast: true });
  });

  it('treats an exact multiple as full parts with no empty trailing part', () => {
    // Off-by-one here would send an empty request the storage rejects.
    const chunks = planChunks(2 * partSize, partSize);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.size === partSize)).toBe(true);
  });

  it('plans nothing for an empty or non-positive size', () => {
    expect(planChunks(0, partSize)).toEqual([]);
    expect(planChunks(-5, partSize)).toEqual([]);
    expect(planChunks(Number.NaN, partSize)).toEqual([]);
  });

  it('refuses a part size that cannot bound anything', () => {
    expect(() => planChunks(100, 0)).toThrow(/positive/);
    expect(() => planChunks(100, -1)).toThrow(/positive/);
  });
});

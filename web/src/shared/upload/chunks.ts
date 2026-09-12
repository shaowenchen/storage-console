/**
 * How a file is divided for a chunked upload.
 *
 * Kept pure and separate from the transfer so the arithmetic that decides how
 * many requests a file becomes — and how large each one is — can be tested
 * directly. That size is the property the whole upload path exists to control:
 * a single request large enough to outlast a proxy's request-body timeout is
 * exactly the failure being designed out, so it should not be something only an
 * integration test can observe.
 */

export type Chunk = {
  /** 1-based, as S3 numbers parts. */
  partNumber: number;
  start: number;
  end: number;
  size: number;
  isLast: boolean;
};

/**
 * Divide `size` bytes into parts of at most `partSize`, in order.
 *
 * The final part carries the remainder and may be smaller than the rest; every
 * other part is exactly `partSize`.
 */
export function planChunks(size: number, partSize: number): Chunk[] {
  if (!Number.isFinite(size) || size <= 0) return [];
  if (!Number.isFinite(partSize) || partSize <= 0) {
    throw new Error('partSize must be a positive number');
  }

  const count = Math.ceil(size / partSize);
  const chunks: Chunk[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * partSize;
    const end = Math.min(start + partSize, size);
    chunks.push({
      partNumber: index + 1,
      start,
      end,
      size: end - start,
      isLast: index === count - 1,
    });
  }
  return chunks;
}

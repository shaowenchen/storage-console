/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * The results array preserves the input order regardless of completion order,
 * so a caller can still line up its output with its input when the work
 * completes out of order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface Gate {
  /**
   * Take a slot, waiting for one if the gate is at capacity.
   *
   * Resolves to a release function, or to null when the waiting queue is full.
   * The null case is deliberately distinct from a wait: it is the caller's cue
   * to refuse the work (a retryable response) rather than hold it, so a client
   * cannot make the process's memory a function of how many requests it opens.
   */
  acquire(): Promise<(() => void) | null>;
}

/**
 * Limit how many operations run at once, with a bounded waiting queue.
 *
 * The queue exists so a client that briefly overshoots the concurrency waits
 * for a slot instead of being turned away — for an upload, refusing costs a
 * round trip and a backoff sleep, which is slower than having queued. The queue
 * being bounded is what keeps that from becoming an unbounded backlog.
 */
export function createGate(concurrency: number, maxQueue: number): Gate {
  const limit = Math.max(1, Math.floor(concurrency));
  const queueLimit = Math.max(0, Math.floor(maxQueue));
  let active = 0;
  const waiting: Array<() => void> = [];

  // Idempotent: a slot is released either by the work finishing or by the
  // client going away, whichever happens first, and both paths may fire.
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    };
  };

  return {
    async acquire(): Promise<(() => void) | null> {
      if (active < limit) {
        active += 1;
        return makeRelease();
      }
      if (waiting.length >= queueLimit) return null;
      await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      return makeRelease();
    },
  };
}

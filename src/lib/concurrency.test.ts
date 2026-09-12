import { describe, expect, it } from 'vitest';
import { createGate, mapWithConcurrency } from './concurrency.js';

/** Resolve after `ms`, for tests that need a slot to be held a known time. */
function after(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('createGate', () => {
  it('admits up to the concurrency immediately, then queues', async () => {
    const gate = createGate(2, 4);
    const first = await gate.acquire();
    const second = await gate.acquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // Capacity is full, so this one waits rather than resolving.
    let third: (() => void) | null | undefined;
    const pending = gate.acquire().then((release) => {
      third = release;
    });
    await after(10);
    expect(third).toBeUndefined();

    // Releasing a slot lets the waiter through.
    first!();
    await pending;
    expect(third).not.toBeNull();
  });

  it('refuses with null once the waiting queue is full', async () => {
    const gate = createGate(1, 1);
    const active = await gate.acquire();
    expect(active).not.toBeNull();

    // Fills the single queue slot.
    const queued = gate.acquire();
    await after(10);
    // Queue is now full, so this is refused rather than held.
    await expect(gate.acquire()).resolves.toBeNull();

    active!();
    await expect(queued).resolves.not.toBeNull();
  });

  it('treats a zero queue as "never wait"', async () => {
    const gate = createGate(1, 0);
    const active = await gate.acquire();
    await expect(gate.acquire()).resolves.toBeNull();
    active!();
    await expect(gate.acquire()).resolves.not.toBeNull();
  });

  it('is idempotent about releasing, so a double release cannot free two slots', async () => {
    const gate = createGate(1, 8);
    const first = await gate.acquire();
    first!();
    first!();

    // A second release must not have granted a phantom slot: one acquire is
    // admitted, the next has to queue.
    const admitted = await gate.acquire();
    expect(admitted).not.toBeNull();
    let queued = false;
    void gate.acquire().then(() => {
      queued = true;
    });
    await after(10);
    expect(queued).toBe(false);
  });

  it('caps in-flight work at the concurrency', async () => {
    const gate = createGate(3, 100);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, async () => {
        const release = await gate.acquire();
        if (!release) throw new Error('unexpected refusal');
        active += 1;
        peak = Math.max(peak, active);
        await after(5);
        active -= 1;
        release();
      }),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 5, 20, 1], 2, async (ms, index) => {
      await after(ms);
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await after(2);
      active -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

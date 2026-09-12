import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpload } from './runUpload';

/**
 * Drive the retry loop with a scripted XMLHttpRequest and a stubbed finalize.
 *
 * These are the two decisions worth pinning down: a transient failure is
 * re-sent, and a permanent one is not. Getting the second wrong is the
 * expensive mistake — it re-uploads a whole file to meet the same rejection.
 */

/** One planned attempt: the response, or the way it fails. */
type Plan =
  | { status: number; body?: unknown; retryAfter?: string }
  | 'network-error'
  | 'timeout';

const plans: Plan[] = [];
const attempts: Array<{ url: string; headers: Record<string, string> }> = [];
let finalizeCalls = 0;
let finalizeShouldFail = false;

class FakeXHR {
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
    { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};
  private retryAfter: string | null = null;

  open(_method: string, url: string): void {
    attempts.push({ url, headers: {} });
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
    const last = attempts[attempts.length - 1];
    if (last) last.headers[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'retry-after' ? this.retryAfter : null;
  }

  send(): void {
    const plan = plans.shift();
    if (!plan) throw new Error('test ran out of scripted attempts');
    if (plan === 'network-error') {
      this.onerror?.();
      return;
    }
    if (plan === 'timeout') {
      // The runner's own timeout timer calls abort(); mimic that callback.
      this.onabort?.();
      return;
    }
    this.status = plan.status;
    this.retryAfter = plan.retryAfter ?? null;
    this.responseText = plan.body === undefined ? '' : JSON.stringify(plan.body);
    // Report progress so the runner's bookkeeping is exercised too.
    this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
    this.onload?.();
  }

  abort(): void {
    // Only reached via the runner's timeout; the timeout plan calls onabort
    // directly, so nothing to do here.
  }
}

const file = { name: 'report.pdf', size: 4, type: 'application/pdf' } as unknown as File;

function progressMessages(onProgress: (p: { percent: number; message: string }) => void) {
  const messages: string[] = [];
  return {
    messages,
    onProgress: (p: { percent: number; message: string }) => {
      messages.push(p.message);
      onProgress(p);
    },
  };
}

beforeEach(() => {
  plans.length = 0;
  attempts.length = 0;
  finalizeCalls = 0;
  finalizeShouldFail = false;
  vi.stubGlobal('window', { __STORAGE_CONSOLE_CONFIG__: undefined });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('fetch', async () => {
    finalizeCalls += 1;
    if (finalizeShouldFail) {
      return { ok: false, status: 500, text: async () => '{"error":{"message":"nope"}}' };
    }
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const okBody = { ok: true, key: 'report.pdf', name: 'report.pdf', size: 4, contentType: 'application/pdf' };

async function run(options: { signal?: AbortSignal } = {}) {
  const collected = progressMessages(() => {});
  const promise = runUpload({
    files: [file],
    context: { mode: 'storage', bucketId: 'bucket-1', relativePath: '' },
    onProgress: collected.onProgress,
    signal: options.signal,
  });
  return { promise, messages: collected.messages };
}

/**
 * Attach a rejection handler now and resolve to the failure later.
 *
 * The handler has to be attached before any timers are advanced, or the
 * rejection is briefly unhandled; awaiting the returned promise afterwards keeps
 * the assertion an ordinary one rather than a floating async expect.
 */
function captureFailure(promise: Promise<void>): Promise<Error | null> {
  return promise.then(
    () => null,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );
}

describe('runUpload retry behaviour', () => {
  it('succeeds on the first attempt without retrying', async () => {
    plans.push({ status: 201, body: okBody });
    const { promise } = await run();
    await promise;
    expect(attempts).toHaveLength(1);
    expect(finalizeCalls).toBe(1);
  });

  it('re-sends a retryable 503 and succeeds', async () => {
    vi.useFakeTimers();
    plans.push(
      {
        status: 503,
        body: { error: { code: 'server_busy', message: 'busy', retryable: true } },
        retryAfter: '1',
      },
      { status: 201, body: okBody },
    );
    const { promise, messages } = await run();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();

    expect(attempts).toHaveLength(2);
    // The wait said how long and why, so a pause is not mistaken for a hang.
    expect(messages.some((m) => m.includes('retry 1/') && m.includes('busy'))).toBe(true);
  });

  it('stops on a non-retryable 400 instead of re-uploading the file', async () => {
    plans.push({
      status: 400,
      body: { error: { code: 'too_large', message: 'File is too large', retryable: false } },
    });
    const { promise } = await run();
    await expect(promise).rejects.toThrow('File is too large');
    // The whole point: exactly one attempt.
    expect(attempts).toHaveLength(1);
    expect(finalizeCalls).toBe(0);
  });

  it('retries a network error, which carries no response at all', async () => {
    vi.useFakeTimers();
    plans.push('network-error', { status: 201, body: okBody });
    const { promise } = await run();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();
    expect(attempts).toHaveLength(2);
  });

  it('retries a bare 5xx even when the server sends no flag', async () => {
    vi.useFakeTimers();
    plans.push({ status: 502 }, { status: 201, body: okBody });
    const { promise } = await run();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();
    expect(attempts).toHaveLength(2);
  });

  it('honours a server flag that retracts a 5xx', async () => {
    plans.push({ status: 503, body: { error: { message: 'permanently unavailable', retryable: false } } });
    const { promise } = await run();
    await expect(promise).rejects.toThrow('permanently unavailable');
    expect(attempts).toHaveLength(1);
  });

  it('gives up after the retry budget rather than looping forever', async () => {
    vi.useFakeTimers();
    // 1 initial attempt + UPLOAD_MAX_RETRIES retries, all transient.
    for (let i = 0; i < 12; i++) {
      plans.push({ status: 503, body: { error: { message: `busy ${i}`, retryable: true } }, retryAfter: '1' });
    }
    const { promise } = await run();
    const failure = captureFailure(promise);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await failure)?.message).toBe('busy 4');

    expect(attempts).toHaveLength(5);
  });

  it('reports the final failure, not an intermediate one', async () => {
    vi.useFakeTimers();
    plans.push(
      { status: 503, body: { error: { message: 'first', retryable: true } }, retryAfter: '1' },
      { status: 400, body: { error: { message: 'second', retryable: false } } },
    );
    const { promise } = await run();
    // Attached before advancing, so the rejection is never unhandled.
    const failure = captureFailure(promise);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await failure)?.message).toBe('second');
    expect(attempts).toHaveLength(2);
  });

  it('stops retrying when the upload is cancelled mid-backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    plans.push({ status: 503, body: { error: { message: 'busy', retryable: true } }, retryAfter: '30' });
    const { promise } = await run({ signal: controller.signal });
    // Abort while it is waiting out the 30s backoff.
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await expect(promise).rejects.toThrow('Upload cancelled');
    expect(attempts).toHaveLength(1);
  });

  it('refuses to retry a success whose body is unreadable', async () => {
    plans.push({ status: 201, body: undefined });
    // 201 with an empty body: the object may well have landed, so re-sending it
    // is not obviously safe and the failure is reported instead.
    const { promise } = await run();
    await expect(promise).rejects.toThrow('invalid JSON');
    expect(attempts).toHaveLength(1);
  });

  it('sends the file name and content type the server expects', async () => {
    plans.push({ status: 201, body: okBody });
    const { promise } = await run();
    await promise;
    expect(attempts[0]!.url).toContain('/api/storages/bucket-1/upload-object');
    expect(attempts[0]!.url).toContain('name=report.pdf');
    expect(attempts[0]!.headers['Content-Type']).toBe('application/pdf');
  });

  it('surfaces a finalize failure separately from the transfer', async () => {
    plans.push({ status: 201, body: okBody });
    finalizeShouldFail = true;
    const { promise } = await run();
    // The bytes landed, so the message must say the PUT succeeded.
    await expect(promise).rejects.toThrow(/finalize failed/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpload } from './runUpload';
import { UPLOAD_PART_CONCURRENCY, partTimeoutMs } from './retry';

/**
 * Drive the chunked upload with a scripted XMLHttpRequest.
 *
 * The decisions worth pinning down are the ones the old whole-file PUT got
 * wrong: every request is bounded, a failure re-sends only its own part, and a
 * permanent failure stops rather than re-uploading. The first of those is the
 * reason the chunked path exists at all, so it is asserted on the bytes
 * actually handed to each request rather than inferred from the plan.
 */

/** One planned response: the outcome, or the way the request fails. */
type Plan =
  | { status: number; body?: unknown; retryAfter?: string; etag?: string }
  | 'network-error'
  | 'timeout';

const plans: Plan[] = [];
/** Every request the client made, in order, with the body it carried. */
const attempts: Array<{
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Byte length of the body, or null when the body is not a sized blob. */
  bodySize: number | null;
}> = [];
let finalizeCalls = 0;
let finalizeShouldFail = false;

const PART_SIZE = 1024;

class FakeXHR {
  status = 0;
  responseText = '';
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};
  private retryAfter: string | null = null;
  private etag: string | null = null;

  open(method: string, url: string): void {
    attempts.push({ method, url, headers: {}, bodySize: null });
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
    const last = attempts[attempts.length - 1];
    if (last) last.headers[name] = value;
  }

  getResponseHeader(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower === 'retry-after') return this.retryAfter;
    // A PUT straight to a bucket answers with the ETag as a header, which is how
    // the direct path reads it.
    if (lower === 'etag') return this.etag;
    return null;
  }

  send(body?: unknown): void {
    const last = attempts[attempts.length - 1];
    if (last) last.bodySize = typeof (body as { size?: unknown })?.size === 'number' ? (body as { size: number }).size : null;

    // A direct attempt fails without consuming a scripted plan, so a test can
    // make the direct route unusable without having to predict exactly how many
    // concurrent parts will race into it.
    if (directShouldFail && last?.url.includes('/bucket-upload')) {
      this.onerror?.();
      return;
    }

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
    this.etag = plan.etag ?? null;
    this.responseText = plan.body === undefined ? '' : JSON.stringify(plan.body);
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
    this.onload?.();
  }

  abort(): void {
    // Only reached via the runner's timeout; the timeout plan calls onabort
    // directly, so nothing to do here.
  }
}

/** A file whose bytes are never materialised, only counted. */
function fakeFile(size: number, name = 'report.pdf', type = 'application/pdf'): File {
  return {
    name,
    size,
    type,
    slice: (start: number, end: number) => ({ size: end - start }),
  } as unknown as File;
}

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

/** The response that starts an upload, with a part size the client must obey. */
function startBody(size: number, partSize = PART_SIZE, partCount = Math.ceil(size / partSize), directUpload = false) {
  return {
    uploadToken: 'token-1',
    key: 'prefix/report.pdf',
    name: 'report.pdf',
    size,
    contentType: 'application/pdf',
    relativePath: '',
    partSize,
    partCount,
    partBudgetMs: 120_000,
    directUpload,
  };
}

function partBody(partNumber: number) {
  return { ok: true, partNumber, etag: `"etag-${partNumber}"`, size: PART_SIZE };
}

/** Queue the start response plus one successful response per part. */
function planSuccessfulUpload(size: number, partSize = PART_SIZE) {
  const partCount = Math.ceil(size / partSize);
  plans.push({ status: 201, body: startBody(size, partSize, partCount) });
  for (let i = 1; i <= partCount; i++) plans.push({ status: 200, body: partBody(i) });
}

/**
 * Queue a start response plus one successful *direct* part response per part.
 *
 * A direct PUT to a bucket answers 200 with the ETag in a header and an empty
 * body, which is what distinguishes it from the proxy's JSON body.
 */
function planDirectUpload(size: number, partSize = PART_SIZE, directUpload = true) {
  const partCount = Math.ceil(size / partSize);
  plans.push({ status: 201, body: startBody(size, partSize, partCount, directUpload) });
  for (let i = 1; i <= partCount; i++) {
    plans.push({ status: 200, etag: `"direct-etag-${i}"`, body: undefined });
  }
}

/** Requests that carried file bytes, whether direct or through the console. */
function partAttempts() {
  return attempts.filter((attempt) => attempt.url.includes('/upload-part'));
}

function directPartAttempts() {
  return attempts.filter((attempt) => attempt.url.includes('/bucket-upload'));
}

function startAttempts() {
  return attempts.filter((attempt) => attempt.url.includes('/upload-multipart?'));
}

/** Count of calls to the part-URL endpoint, which are fetch rather than XHR. */
let partUrlCalls = 0;
/** Make the part-URL endpoint fail, to exercise the fallback path. */
let partUrlShouldFail = false;
/** Make every direct part PUT fail at the network level. */
let directShouldFail = false;

beforeEach(() => {
  plans.length = 0;
  attempts.length = 0;
  finalizeCalls = 0;
  finalizeShouldFail = false;
  partUrlCalls = 0;
  partUrlShouldFail = false;
  directShouldFail = false;
  vi.stubGlobal('window', { __STORAGE_CONSOLE_CONFIG__: undefined });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
    const href = String(url);
    if (href.includes('/upload-part-url')) {
      partUrlCalls += 1;
      if (partUrlShouldFail) {
        return {
          ok: false,
          status: 502,
          text: async () => '{"error":{"message":"cannot sign","retryable":true}}',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `{"url":"https://bucket-upload.example/key?part=${href.match(/partNumber=(\d+)/)?.[1]}","size":${PART_SIZE}}`,
      };
    }
    if (href.includes('/upload-multipart/abort') || href.includes('/upload-multipart/complete')) {
      return { ok: true, status: 201, text: async () => '{"ok":true}' };
    }
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

async function run(file: File, options: { signal?: AbortSignal } = {}) {
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

describe('runUpload direct-to-bucket', () => {
  it('sends parts straight to the bucket when the server says it may', async () => {
    // The point of direct upload: the bytes never touch this service, so neither
    // it nor anything in front of it is in the data path for a large file.
    const file = fakeFile(PART_SIZE * 3);
    planDirectUpload(file.size);
    const { promise } = await run(file);
    await promise;

    expect(directPartAttempts()).toHaveLength(3);
    // Nothing went through the console's own byte-carrying route.
    expect(partAttempts()).toHaveLength(0);
    // One URL per part, fetched as the part is about to be sent.
    expect(partUrlCalls).toBe(3);
  });

  it('carries the ETag from the response header into completion', async () => {
    // A bucket answers with the ETag as a header, and a cross-origin response's
    // headers are invisible unless CORS exposes them — the single detail that
    // makes direct uploads fail at completion after every part "succeeded".
    const file = fakeFile(PART_SIZE);
    planDirectUpload(file.size);
    const completionBody: { parts: Array<{ etag: string }> } = { parts: [] };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/upload-multipart/complete')) {
        const parsed = JSON.parse(String(init?.body || '{}')) as {
          parts: Array<{ etag: string }>;
        };
        completionBody.parts = parsed.parts;
      }
      return originalFetch(url as never, init as never);
    });
    const { promise } = await run(file);
    await promise;

    expect(completionBody.parts[0]?.etag).toBe('"direct-etag-1"');
  });

  it('falls back to the console when a direct part fails', async () => {
    // A bucket that will not accept the browser's origin still has to work.
    const file = fakeFile(PART_SIZE * 2);
    plans.push({ status: 201, body: startBody(file.size, PART_SIZE, 2, true) });
    // Every direct attempt fails; the proxy then carries both parts.
    plans.push({ status: 200, body: partBody(1) });
    plans.push({ status: 200, body: partBody(2) });
    directShouldFail = true;
    const { promise, messages } = await run(file);
    await promise;

    expect(partAttempts()).toHaveLength(2);
    // The fallback is said out loud, so a bucket that refuses looks different
    // from one that is merely slow.
    expect(messages.some((m) => m.includes('through the console instead'))).toBe(true);
  });

  it('stops trying the direct route once it has fallen back', async () => {
    // A bucket that refused once will refuse again. Parts sent in parallel race
    // into the first failure, so the cost is bounded by the concurrency rather
    // than by how many parts the file has.
    const file = fakeFile(PART_SIZE * 6);
    plans.push({ status: 201, body: startBody(file.size, PART_SIZE, 6, true) });
    for (let i = 1; i <= 6; i++) plans.push({ status: 200, body: partBody(i) });
    directShouldFail = true;
    const { promise } = await run(file);
    await promise;

    // Bounded, not proportional: a file of any size pays this many failed direct
    // attempts at most, not one per part.
    expect(directPartAttempts().length).toBeLessThanOrEqual(UPLOAD_PART_CONCURRENCY);
    expect(directPartAttempts().length).toBeLessThan(6);
    expect(partUrlCalls).toBeLessThanOrEqual(UPLOAD_PART_CONCURRENCY);
    // Every part still landed.
    expect(partAttempts()).toHaveLength(6);
  });

  it('goes straight to the proxy when the server says direct is unavailable', async () => {
    const file = fakeFile(PART_SIZE);
    planSuccessfulUpload(file.size);
    const { promise } = await run(file);
    await promise;

    expect(directPartAttempts()).toHaveLength(0);
    // Not even asked for a URL.
    expect(partUrlCalls).toBe(0);
  });

  it('falls back when the part URL itself cannot be obtained', async () => {
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size, PART_SIZE, 1, true) });
    plans.push({ status: 200, body: partBody(1) });
    partUrlShouldFail = true;
    const { promise, messages } = await run(file);
    await promise;

    expect(partAttempts()).toHaveLength(1);
    expect(messages.some((m) => m.includes('through the console instead'))).toBe(true);
  });

  it('waits longer than the server budget, so a slow part is not cut off mid-retry', async () => {
    // The defect that made this necessary: a 60s client timeout against a
    // server that retries for ~480s abandoned requests while the server was
    // still working on them, so the server's retries were never seen.
    const serverBudgetMs = 480_000;
    expect(partTimeoutMs(serverBudgetMs)).toBeGreaterThan(serverBudgetMs);
    // And a fallback for an older server that reports no budget.
    expect(partTimeoutMs(undefined)).toBeGreaterThanOrEqual(300_000);
  });
});

describe('runUpload chunking', () => {
  it('sends one request per part, each bounded by the server part size', async () => {
    // 3.5 parts, so the final one is short.
    const file = fakeFile(PART_SIZE * 3 + 500);
    planSuccessfulUpload(file.size);
    const { promise } = await run(file);
    await promise;

    const parts = partAttempts();
    expect(parts).toHaveLength(4);
    // The invariant: no request ever carries more than one part's worth.
    for (const attempt of parts) {
      expect(attempt.bodySize).toBeLessThanOrEqual(PART_SIZE);
    }
    expect(parts.map((attempt) => attempt.bodySize)).toEqual([
      PART_SIZE,
      PART_SIZE,
      PART_SIZE,
      500,
    ]);
  });

  it('never sends a request large enough to outlast a proxy body timeout', async () => {
    // A 1GB file at the real 8MB part size, stated as the property that matters:
    // the largest request is a tiny fraction of the file.
    const partSize = 8 * 1024 * 1024;
    const file = fakeFile(1024 * 1024 * 1024);
    planSuccessfulUpload(file.size, partSize);
    const { promise } = await run(file);
    await promise;

    const parts = partAttempts();
    expect(parts).toHaveLength(128);
    const largest = Math.max(...parts.map((attempt) => attempt.bodySize ?? 0));
    expect(largest).toBe(partSize);
    expect(largest).toBeLessThan(file.size / 100);
  });

  it('uses the part size the server reports rather than assuming one', async () => {
    // The server seals its expectation into the session; a client that hard-coded
    // a different size would have every part rejected.
    const file = fakeFile(250);
    plans.push({ status: 201, body: startBody(file.size, 100, 3) });
    plans.push({ status: 200, body: partBody(1) });
    plans.push({ status: 200, body: partBody(2) });
    plans.push({ status: 200, body: partBody(3) });
    const { promise } = await run(file);
    await promise;

    expect(partAttempts().map((attempt) => attempt.bodySize)).toEqual([100, 100, 50]);
  });

  it('starts the upload with a single request, then completes it once', async () => {
    const file = fakeFile(PART_SIZE * 2);
    planSuccessfulUpload(file.size);
    const { promise } = await run(file);
    await promise;

    expect(startAttempts()).toHaveLength(1);
    expect(startAttempts()[0]!.url).toContain('name=report.pdf');
    expect(finalizeCalls).toBe(1);
  });

  it('numbers parts from one, and does not declare which is last', async () => {
    // Which part is last is derived by the server from the signed session, so
    // the client must not claim it — a client-declared "last part" would be a
    // way around the storage's minimum part size.
    const file = fakeFile(PART_SIZE * 2 + 10);
    planSuccessfulUpload(file.size);
    const { promise } = await run(file);
    await promise;

    const urls = partAttempts().map((attempt) => attempt.url);
    expect(urls[0]).toContain('partNumber=1');
    expect(urls[2]).toContain('partNumber=3');
    for (const url of urls) {
      expect(url).not.toContain('isLast');
    }
  });
});

describe('runUpload retry behaviour', () => {
  it('re-sends only the failed part, not the parts already accepted', async () => {
    // This is the cost the old design paid: a stumble mid-file re-sent the whole
    // upload. Only the part that failed may be re-sent.
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE * 3);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push({ status: 200, body: partBody(1) });
    plans.push({
      status: 503,
      body: { error: { code: 'server_busy', message: 'busy', retryable: true } },
      retryAfter: '1',
    });
    plans.push({ status: 200, body: partBody(2) });
    plans.push({ status: 200, body: partBody(3) });
    const { promise, messages } = await run(file);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();

    const parts = partAttempts();
    // Parts 1 and 3 were sent once; part 2 was re-sent after its 503.
    expect(parts.filter((attempt) => attempt.url.includes('partNumber=2'))).toHaveLength(2);
    expect(parts.filter((attempt) => attempt.url.includes('partNumber=1'))).toHaveLength(1);
    expect(parts.filter((attempt) => attempt.url.includes('partNumber=3'))).toHaveLength(1);
    // The pause says which part and how long, so it is not mistaken for a hang.
    expect(messages.some((m) => m.includes('part 2 retry 1/') && m.includes('busy'))).toBe(true);
  });

  it('keeps every request bounded while retrying a part', async () => {
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE * 2);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push({ status: 503, body: { error: { message: 'busy', retryable: true } }, retryAfter: '1' });
    plans.push({ status: 200, body: partBody(1) });
    plans.push({ status: 200, body: partBody(2) });
    const { promise } = await run(file);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();

    for (const attempt of partAttempts()) {
      expect(attempt.bodySize).toBeLessThanOrEqual(PART_SIZE);
    }
  });

  it('stops on a non-retryable part failure instead of re-uploading', async () => {
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push({
      status: 400,
      body: { error: { code: 'invalid_part', message: 'Part is too large', retryable: false } },
    });
    const { promise } = await run(file);
    await expect(promise).rejects.toThrow('Part is too large');
    // One attempt for the part, and nothing finalized.
    expect(partAttempts()).toHaveLength(1);
    expect(finalizeCalls).toBe(0);
  });

  it('abandons the upload at the storage when a part fails permanently', async () => {
    // Parts already accepted sit in the bucket invisibly until the upload is
    // completed or aborted, so walking away silently costs storage.
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push({
      status: 400,
      body: { error: { code: 'invalid_part', message: 'Part is too large', retryable: false } },
    });
    const aborts: string[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      if (String(url).includes('/upload-multipart/abort')) aborts.push(String(url));
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    });
    const { promise } = await run(file);
    await expect(promise).rejects.toThrow('Part is too large');
    expect(aborts).toHaveLength(1);
  });

  it('retries a network error, which carries no response at all', async () => {
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push('network-error', { status: 200, body: partBody(1) });
    const { promise } = await run(file);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBeUndefined();
    expect(partAttempts()).toHaveLength(2);
  });

  it('times out a stalled part rather than waiting forever', async () => {
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push('timeout', { status: 200, body: partBody(1) });
    const { promise } = await run(file);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(promise).resolves.toBeUndefined();
    expect(partAttempts()).toHaveLength(2);
  });

  it('gives up after the retry budget rather than looping forever', async () => {
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size) });
    for (let i = 0; i < 12; i++) {
      plans.push({
        status: 503,
        body: { error: { message: `busy ${i}`, retryable: true } },
        retryAfter: '1',
      });
    }
    const { promise } = await run(file);
    const failure = captureFailure(promise);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await failure)?.message).toBe('busy 4');
    expect(partAttempts()).toHaveLength(5);
  });

  it('reports the final failure, not an intermediate one', async () => {
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE);
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push(
      { status: 503, body: { error: { message: 'first', retryable: true } }, retryAfter: '1' },
      { status: 400, body: { error: { message: 'second', retryable: false } } },
    );
    const { promise } = await run(file);
    const failure = captureFailure(promise);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await failure)?.message).toBe('second');
    expect(partAttempts()).toHaveLength(2);
  });

  it('stops retrying when the upload is cancelled mid-backoff', async () => {
    vi.useFakeTimers();
    const file = fakeFile(PART_SIZE);
    const controller = new AbortController();
    plans.push({ status: 201, body: startBody(file.size) });
    plans.push({
      status: 503,
      body: { error: { message: 'busy', retryable: true } },
      retryAfter: '30',
    });
    const { promise } = await run(file, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await expect(promise).rejects.toThrow('Upload cancelled');
    expect(partAttempts()).toHaveLength(1);
  });

  it('fails the file when the start request itself is rejected', async () => {
    const file = fakeFile(PART_SIZE);
    plans.push({
      status: 400,
      body: { error: { message: 'File is too large', retryable: false } },
    });
    const { promise } = await run(file);
    await expect(promise).rejects.toThrow('File is too large');
    expect(partAttempts()).toHaveLength(0);
  });

  it('surfaces a finalize failure separately from the transfer', async () => {
    const file = fakeFile(PART_SIZE);
    planSuccessfulUpload(file.size);
    finalizeShouldFail = true;
    const { promise } = await run(file);
    // The bytes landed, so the message must not suggest the upload failed.
    await expect(promise).rejects.toThrow(/finalize failed/);
  });
});

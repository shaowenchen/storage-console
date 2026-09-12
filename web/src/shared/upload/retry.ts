/**
 * Retry policy for the browser upload proxy.
 *
 * Kept pure and separate from the XHR plumbing so the schedule and the
 * retryability rule can be tested directly rather than by observing a transfer.
 */

/**
 * Attempts per file: the first try plus this many retries.
 *
 * A single-file PUT has no partial-progress to preserve — a failed attempt
 * re-sends the whole file — so the retry count is a time/bandwidth trade, not a
 * correctness one. Four retries with the backoff below spans roughly a minute of
 * transient failure while leaving a stuck upload failing in bounded time.
 */
export const UPLOAD_MAX_RETRIES = 4;

/**
 * How long the client waits on one part before giving up on it.
 *
 * Derived from the server's own per-part budget rather than being a number of
 * its own, and deliberately more patient than it. Getting this relationship
 * wrong is subtle and expensive: a client timeout shorter than the server's
 * retry budget abandons requests while the server is still retrying them, so the
 * server's retries are never seen, the part is re-sent from scratch, and the
 * client's budget is spent on a part that was about to succeed.
 *
 * That is precisely what a 60 s client timeout did against this server — five
 * attempts over ~300 s, every one cut short, the upload abandoned at five
 * minutes with the storage never having been reached. The allowance below is
 * the server's budget plus a margin for the last response to travel back.
 */
export function partTimeoutMs(serverBudgetMs?: number): number {
  if (typeof serverBudgetMs === 'number' && Number.isFinite(serverBudgetMs) && serverBudgetMs > 0) {
    return serverBudgetMs + PART_TIMEOUT_MARGIN_MS;
  }
  return DEFAULT_PART_TIMEOUT_MS;
}

/** Margin on top of the server's budget, covering the response's return trip. */
const PART_TIMEOUT_MARGIN_MS = 30 * 1000;

/**
 * Fallback when the server does not report a budget (an older server).
 *
 * Chosen to exceed a plausible server budget rather than sit inside it, since
 * being too patient only delays a failure while being too impatient causes one.
 */
const DEFAULT_PART_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Parts sent at once, per file.
 *
 * Parts are independent, so a few in flight keeps a fast link busy where one at
 * a time would leave it idle between round trips. Kept small because the server
 * admits a limited number of parts across all clients: a single upload taking
 * every slot would starve everyone else, and the point of a modest per-file
 * limit is that the server's queue absorbs a brief overshoot rather than being
 * filled by one client.
 */
export const UPLOAD_PART_CONCURRENCY = 3;

/** Longest the client will wait before re-sending, whatever the server says. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Whether re-sending this attempt could reasonably succeed.
 *
 * The server states this itself and is trusted over the status class, because
 * it knows which of its failures are transient on its side — an upstream
 * storage 502, say — while a 400 for an oversized file uses the same route and
 * will fail identically forever. The status class is only the fallback for a
 * response that did not carry the flag (an older server, or a proxy error page).
 */
export function isRetryableStatus(status: number, retryableFlag?: unknown): boolean {
  if (typeof retryableFlag === 'boolean') return retryableFlag;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Milliseconds to wait before retrying.
 *
 * `Retry-After` wins when present: it is the server stating exactly how long its
 * shedder needs, and coming back sooner just earns another 503.
 *
 * Otherwise exponential, capped, and jittered. The jitter matters more than it
 * looks: when the server sheds load every in-flight upload fails at once, and
 * without it they would all retry in the same instant and reproduce the overload
 * they are backing off from.
 */
export function backoffMs(attempt: number, retryAfterHeader?: string | null): number {
  const hinted = Number(retryAfterHeader);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, MAX_BACKOFF_MS);

  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** Wait, but wake early if the upload is cancelled mid-backoff. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Upload cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Upload cancelled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

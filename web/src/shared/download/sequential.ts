/**
 * Fetch several files as separate browser downloads, one at a time.
 *
 * The browser gives no "download finished" signal, and firing many navigations
 * at once makes Chrome drop all but the first, so each file gets its own hidden
 * iframe and the queue advances only after that frame loads or times out.
 *
 * A file that fails does not stop the ones behind it: the caller gets the
 * failures back and decides what to tell the user.
 */

export type DownloadFrame = {
  /** Wait for the frame to report load. Must not reject. */
  loaded: Promise<void>;
  /** Detach the frame from the document. Safe to call more than once. */
  remove: () => void;
};

export type SequentialDownloadOptions = {
  /** Quiet period between two files, so the browser keeps accepting them. */
  gapMs?: number;
  /** Stop waiting on a slow frame after this long and move on. */
  loadTimeoutMs?: number;
  /** Injected in tests. */
  createFrame?: (url: string) => DownloadFrame;
  /** Called before each file, for progress reporting. */
  onProgress?: (completed: number, total: number) => void;
};

export type SequentialDownloadResult = {
  completed: number;
  /** Files whose frame did not load, with what went wrong. */
  failed: Array<{ url: string; reason: string }>;
};

export const DEFAULT_DOWNLOAD_GAP_MS = 350;
export const DEFAULT_DOWNLOAD_LOAD_TIMEOUT_MS = 60000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A hidden iframe pointed at `url`. Following the response's redirect to the
 * signed bucket URL with `Content-Disposition: attachment` makes the browser
 * save the file with the server-chosen name instead of navigating.
 */
function createHiddenFrame(url: string): DownloadFrame {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');

  const loaded = new Promise<void>((resolve) => {
    // Both events settle the wait: `error` means we should move on rather than
    // hang, and the caller is told through the timeout path either way.
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.addEventListener('error', () => resolve(), { once: true });
  });

  frame.src = url;
  document.body.appendChild(frame);

  return {
    loaded,
    remove: () => {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    },
  };
}

export async function downloadSequentially(
  urls: string[],
  options: SequentialDownloadOptions = {},
): Promise<SequentialDownloadResult> {
  const {
    gapMs = DEFAULT_DOWNLOAD_GAP_MS,
    loadTimeoutMs = DEFAULT_DOWNLOAD_LOAD_TIMEOUT_MS,
    createFrame = createHiddenFrame,
    onProgress,
  } = options;

  const failed: SequentialDownloadResult['failed'] = [];
  let completed = 0;

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    const frame = createFrame(url);
    try {
      // Whichever lands first wins. A frame that never fires `load` (the
      // browser may not report one for an attachment download) would otherwise
      // stall the whole queue.
      await Promise.race([frame.loaded, wait(loadTimeoutMs)]);
      completed += 1;
    } catch (err) {
      failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      frame.remove();
    }
    onProgress?.(completed, urls.length);
    // No trailing wait: it would only delay the result.
    if (gapMs > 0 && index < urls.length - 1) await wait(gapMs);
  }

  return { completed, failed };
}

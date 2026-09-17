/**
 * Hand a batch of URLs to the browser as separate downloads.
 *
 * One navigation per file is the only way to get N files as N downloads without
 * an archive. Nothing here waits for a file to finish: an attachment download
 * gives no completion signal — the frame these URLs load into does not fire
 * `load` for one — so waiting would only stall the batch behind a timeout. Each
 * URL is handed over in turn, paced slightly so the browser is not asked to open
 * hundreds of connections in one burst, and the browser does the rest.
 */

export type DownloadFrame = {
  /** Detach the frame from the document. Safe to call more than once. */
  remove: () => void;
};

export type BatchDownloadOptions = {
  /** Pacing between hand-offs, so a large batch does not open all at once. */
  gapMs?: number;
  /** Injected in tests. */
  createFrame?: (url: string) => DownloadFrame;
  /** Called after each URL is handed over, for progress reporting. */
  onProgress?: (started: number, total: number) => void;
};

export type BatchDownloadResult = {
  /** How many URLs were handed to the browser. */
  started: number;
  /**
   * The frames the downloads are running in, kept so the caller can decide when
   * to clean up. Removing a frame while its download is in flight risks
   * cancelling it, so nothing here reclaims them on its own.
   */
  frames: DownloadFrame[];
};

export const DEFAULT_DOWNLOAD_GAP_MS = 150;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A hidden iframe pointed at `url`. Following the response's redirect to the
 * signed bucket URL with `Content-Disposition: attachment` makes the browser
 * save the file with the server-chosen name instead of navigating to it.
 */
function createHiddenFrame(url: string): DownloadFrame {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = url;
  document.body.appendChild(frame);

  return {
    remove: () => {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    },
  };
}

export async function downloadAll(
  urls: string[],
  options: BatchDownloadOptions = {},
): Promise<BatchDownloadResult> {
  const { gapMs = DEFAULT_DOWNLOAD_GAP_MS, createFrame = createHiddenFrame, onProgress } = options;

  const frames: DownloadFrame[] = [];

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    try {
      frames.push(createFrame(url));
    } catch {
      // A frame that could not be created is one file not delivered; the rest
      // of the batch should still go out.
      continue;
    }
    onProgress?.(frames.length, urls.length);
    // No trailing wait: it would only delay the last hand-off.
    if (gapMs > 0 && index < urls.length - 1) await wait(gapMs);
  }

  return { started: frames.length, frames };
}

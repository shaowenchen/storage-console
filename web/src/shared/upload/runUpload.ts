import { formatApiError } from '../apiError';
import type { UploadProgress, UploadedPart } from './types';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  completeStorageUpload,
  uploadMultipartUrl,
  uploadPartUrl,
} from './api';
import { planChunks, type Chunk } from './chunks';
import { normalizeRelativePath } from './helpers';
import {
  UPLOAD_MAX_RETRIES,
  UPLOAD_PART_CONCURRENCY,
  UPLOAD_PART_TIMEOUT_MS,
  backoffMs,
  isRetryableStatus,
  sleep,
} from './retry';

type UploadContext = {
  mode: 'storage';
  bucketId: string;
  relativePath: string;
};

export type RunUploadOptions = {
  files: File[];
  context: UploadContext;
  onProgress: (progress: UploadProgress) => void;
  signal?: AbortSignal;
};

type StartedUpload = {
  uploadToken: string;
  key: string;
  name: string;
  size: number;
  contentType: string;
  relativePath: string;
  partSize: number;
  partCount: number;
};

/** A failed attempt, with whether re-sending it is worth trying. */
class UploadAttemptError extends Error {
  retryable: boolean;
  retryAfter: string | null;

  constructor(message: string, retryable: boolean, retryAfter: string | null) {
    super(message);
    this.name = 'UploadAttemptError';
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

/** Status and response body of a finished attempt, for the error formatter. */
type AttemptResponse = { status: number; raw: string };

function parseErrorBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatAttemptError(response: AttemptResponse, label: string): string {
  const data = parseErrorBody(response.raw);
  if (data) return formatApiError(data, label);
  if (response.status > 0) {
    const preview = response.raw.replace(/\s+/g, ' ').trim().slice(0, 240);
    return preview
      ? `${label} failed with HTTP ${response.status}: ${preview}`
      : `${label} failed with HTTP ${response.status}`;
  }
  return `${label} failed (network error)`;
}

/**
 * Send one request whose body is raw bytes, reporting progress as it goes.
 *
 * XHR rather than `fetch` because progress on a request body is only observable
 * through `xhr.upload`. The timeout is what makes a wedged connection fail
 * instead of hanging: without it the request stays open indefinitely and the
 * upload neither completes nor reports an error.
 */
function putBytes(
  method: 'PUT' | 'POST',
  url: string,
  body: Blob,
  contentType: string,
  label: string,
  onChunk: (loaded: number) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', contentType);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      xhr.abort();
    }, timeoutMs);

    let onAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Upload cancelled'));
        return;
      }
      onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function finish(action: () => void) {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      action();
    }

    // A retry restarts this part from zero, so progress is reported back to the
    // caller and reconciled there rather than being tracked per attempt.
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onChunk(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(() => resolve(xhr.responseText));
        return;
      }
      const response: AttemptResponse = {
        status: xhr.status,
        raw: typeof xhr.responseText === 'string' ? xhr.responseText : '',
      };
      const data = parseErrorBody(response.raw) as { error?: { retryable?: unknown } } | null;
      finish(() =>
        reject(
          new UploadAttemptError(
            formatAttemptError(response, label),
            isRetryableStatus(xhr.status, data?.error?.retryable),
            xhr.getResponseHeader('Retry-After'),
          ),
        ),
      );
    };
    xhr.onerror = () => {
      finish(() =>
        reject(
          // No response at all — nothing about the request was rejected as
          // wrong, so this is always worth another attempt.
          new UploadAttemptError(formatAttemptError({ status: 0, raw: '' }, label), true, null),
        ),
      );
    };
    xhr.onabort = () => {
      finish(() => {
        if (timedOut) {
          reject(
            new UploadAttemptError(
              `${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
              true,
              null,
            ),
          );
          return;
        }
        reject(new Error('Upload cancelled'));
      });
    };
    xhr.send(body);
  });
}

/**
 * Run `fn` over `items` with at most `limit` in flight, stopping at the first
 * rejection.
 *
 * Used to keep a few parts in flight without the bookkeeping of a worker pool:
 * parts are independent, so what matters is the bound, not the order. The first
 * failure stops new work from starting and is re-thrown once the in-flight
 * parts settle.
 */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failure: unknown;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === undefined && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await fn(items[index]!);
      } catch (err) {
        failure = err;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

/**
 * Send every part, retrying each independently.
 *
 * This is where the old design's cost is repaid: a failure used to mean
 * re-sending the whole file, so a 1 GB upload that stumbled near the end threw
 * away everything before it. Now only the failed part is re-sent — the parts
 * already accepted stay accepted.
 */
async function uploadParts(
  bucketId: string,
  file: File,
  started: StartedUpload,
  chunks: Chunk[],
  reportProgress: (partNumber: number, loadedInPart: number) => void,
  onRetry: (partNumber: number, attempt: number, waitMs: number, reason: string) => void,
  signal?: AbortSignal,
): Promise<UploadedPart[]> {
  const contentType = file.type || 'application/octet-stream';

  return mapLimited(chunks, UPLOAD_PART_CONCURRENCY, async (chunk) => {
    const slice = file.slice(chunk.start, chunk.end);
    const label = `Uploading ${file.name} (part ${chunk.partNumber}/${chunks.length})`;
    const url = uploadPartUrl(bucketId, started.uploadToken, chunk.partNumber);

    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await putBytes(
          'PUT',
          url,
          slice,
          contentType,
          label,
          (loaded) => reportProgress(chunk.partNumber, loaded),
          UPLOAD_PART_TIMEOUT_MS,
          signal,
        );
        const parsed = raw ? (JSON.parse(raw) as { etag?: string }) : {};
        return {
          partNumber: chunk.partNumber,
          etag: String(parsed.etag || ''),
          size: chunk.size,
        };
      } catch (err) {
        if (signal?.aborted) throw new Error('Upload cancelled');

        const failure =
          err instanceof UploadAttemptError
            ? err
            : new UploadAttemptError(err instanceof Error ? err.message : String(err), true, null);

        if (!failure.retryable || attempt >= UPLOAD_MAX_RETRIES) throw new Error(failure.message);

        const wait = backoffMs(attempt, failure.retryAfter);
        onRetry(chunk.partNumber, attempt + 1, wait, failure.message);
        await sleep(wait, signal);
      }
    }
  });
}

/** Start a chunked upload and return the session the server created. */
async function startUpload(
  bucketId: string,
  relativePath: string,
  file: File,
  label: string,
  signal?: AbortSignal,
): Promise<StartedUpload> {
  const url = uploadMultipartUrl(bucketId, relativePath, file);
  const raw = await putBytes(
    'POST',
    url,
    // The create call carries no file bytes; an empty body keeps it identical to
    // the part path, including its error and retry behaviour.
    new Blob([]),
    'application/json',
    label,
    () => {},
    UPLOAD_PART_TIMEOUT_MS,
    signal,
  );
  const data = raw ? (JSON.parse(raw) as Partial<StartedUpload>) : {};
  if (!data.uploadToken || !data.key) {
    throw new Error(`Could not start upload of "${file.name}"`);
  }
  return data as StartedUpload;
}

export async function runUpload({
  files,
  context,
  onProgress,
  signal,
}: RunUploadOptions): Promise<void> {
  if (!files.length) return;

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;
  let uploadedBeforeCurrent = 0;
  const relativePath = normalizeRelativePath(context.relativePath);

  const completed: Array<{
    key: string;
    name: string;
    size: number;
    contentType: string;
    relativePath: string;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new Error('Upload cancelled');
    const file = files[i]!;
    const label = `Uploading ${i + 1}/${files.length}: ${file.name}`;
    onProgress({
      percent: 5 + (uploadedBeforeCurrent / totalBytes) * 85,
      message: label,
    });

    const started = await startUpload(
      context.bucketId,
      relativePath,
      file,
      `Starting upload of "${file.name}"`,
      signal,
    );
    const chunks = planChunks(file.size, started.partSize);

    // Progress for this file never goes backwards, even though a retry restarts
    // a part: the bar tracks how much has been sent successfully, and showing it
    // fall would read as the upload undoing itself. Parts finish out of order,
    // so what is reported is the furthest byte offset reached so far.
    const doneByPart = new Map<number, number>();
    let furthest = 0;
    const report = () => {
      let sent = 0;
      for (const size of doneByPart.values()) sent += size;
      furthest = Math.max(furthest, sent);
      onProgress({
        percent: 5 + ((uploadedBeforeCurrent + furthest) / totalBytes) * 85,
        message: label,
      });
    };

    let parts: UploadedPart[];
    try {
      parts = await uploadParts(
        context.bucketId,
        file,
        started,
        chunks,
        (partNumber, loaded) => {
          const chunk = chunks[partNumber - 1];
          // Count the part as done once its own bytes are all in flight, which
          // is the closest XHR offers to "accepted".
          if (chunk && loaded >= chunk.size) doneByPart.set(partNumber, chunk.size);
          report();
        },
        (partNumber, attempt, waitMs, reason) => {
          onProgress({
            percent: 5 + ((uploadedBeforeCurrent + furthest) / totalBytes) * 85,
            message: `${label} — part ${partNumber} retry ${attempt}/${UPLOAD_MAX_RETRIES} in ${Math.ceil(
              waitMs / 1000,
            )}s (${reason})`,
          });
        },
        signal,
      );
    } catch (err) {
      // The upload exists at the storage and holds whatever parts landed, so it
      // is abandoned explicitly rather than left to age into an orphan.
      await abortMultipartUpload(context.bucketId, started.uploadToken);
      throw err;
    }

    if (signal?.aborted) {
      await abortMultipartUpload(context.bucketId, started.uploadToken);
      throw new Error('Upload cancelled');
    }

    try {
      await completeMultipartUpload(context.bucketId, started.uploadToken, parts);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Upload failed while completing "${file.name}": ${detail}`);
    }

    uploadedBeforeCurrent += file.size;
    completed.push({
      key: started.key,
      name: started.name,
      size: started.size,
      contentType: started.contentType,
      relativePath: started.relativePath,
    });
  }

  if (signal?.aborted) throw new Error('Upload cancelled');

  onProgress({ percent: 92, message: 'Finalizing upload records…' });

  try {
    await completeStorageUpload(context.bucketId, completed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Upload PUT succeeded but finalize failed: ${detail}`);
  }

  onProgress({ percent: 100, message: 'Upload complete' });
}

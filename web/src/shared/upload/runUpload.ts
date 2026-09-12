import { apiUrl } from '../api';
import { formatApiError } from '../apiError';
import type { UploadProgress } from './types';
import { completeStorageUpload } from './api';
import { normalizeRelativePath } from './helpers';
import {
  UPLOAD_ATTEMPT_TIMEOUT_MS,
  UPLOAD_MAX_RETRIES,
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

type ProxyUploadResult = {
  key: string;
  name: string;
  size: number;
  contentType: string;
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

function formatAttemptError(response: AttemptResponse, file: File): string {
  const data = parseErrorBody(response.raw);
  if (data) return formatApiError(data, `Upload of "${file.name}" failed`);
  if (response.status > 0) {
    const preview = response.raw.replace(/\s+/g, ' ').trim().slice(0, 240);
    return preview
      ? `Upload of "${file.name}" failed with HTTP ${response.status}: ${preview}`
      : `Upload of "${file.name}" failed with HTTP ${response.status}`;
  }
  return `Upload of "${file.name}" failed (network error)`;
}

/**
 * One PUT attempt: same-origin proxy → server PutObject (avoids bucket CORS).
 *
 * Rejects with an {@link UploadAttemptError} carrying the server's own
 * retryability verdict, so the caller retries on what the server says is
 * transient instead of guessing from the status class.
 */
function uploadFileViaProxy(
  bucketId: string,
  relativePath: string,
  file: File,
  onChunk: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ProxyUploadResult> {
  return new Promise((resolve, reject) => {
    const contentType = file.type || 'application/octet-stream';
    const params = new URLSearchParams({
      relativePath,
      name: file.name,
      contentType,
    });
    const url = apiUrl(`/storages/${encodeURIComponent(bucketId)}/upload-object?${params}`);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);

    // A stalled connection looks exactly like a dropped one, and XHR has no
    // timeout of its own: without this the request stays open forever and the
    // upload neither fails nor finishes.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      xhr.abort();
    }, UPLOAD_ATTEMPT_TIMEOUT_MS);

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

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onChunk(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as Partial<ProxyUploadResult>;
          finish(() =>
            resolve({
              key: String(data.key || ''),
              name: String(data.name || file.name),
              size: Number(data.size) || file.size,
              contentType: String(data.contentType || contentType),
            }),
          );
        } catch {
          finish(() =>
            reject(
              new UploadAttemptError(
                `Upload of "${file.name}" succeeded but returned invalid JSON`,
                // The object landed; re-sending is pointless and the finalize
                // step is what the caller should look at.
                false,
                null,
              ),
            ),
          );
        }
        return;
      }

      const response: AttemptResponse = {
        status: xhr.status,
        raw: typeof xhr.responseText === 'string' ? xhr.responseText : '',
      };
      const data = parseErrorBody(response.raw) as
        | { error?: { retryable?: unknown } }
        | null;
      finish(() =>
        reject(
          new UploadAttemptError(
            formatAttemptError(response, file),
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
          new UploadAttemptError(formatAttemptError({ status: 0, raw: '' }, file), true, null),
        ),
      );
    };
    xhr.onabort = () => {
      finish(() => {
        if (timedOut) {
          reject(
            new UploadAttemptError(
              `Upload of "${file.name}" timed out after ${Math.round(
                UPLOAD_ATTEMPT_TIMEOUT_MS / 1000,
              )}s`,
              true,
              null,
            ),
          );
          return;
        }
        reject(new Error('Upload cancelled'));
      });
    };
    xhr.send(file);
  });
}

/**
 * PUT one file, retrying transient failures with backoff.
 *
 * A retry re-sends the whole file, which is why the server is asked whether the
 * failure was transient rather than the client assuming it: re-uploading a
 * gigabyte to hit the same permanent error is the outcome worth avoiding.
 */
async function uploadFileWithRetry(
  bucketId: string,
  relativePath: string,
  file: File,
  onChunk: (loaded: number, total: number) => void,
  onRetry: (attempt: number, waitMs: number, reason: string) => void,
  signal?: AbortSignal,
): Promise<ProxyUploadResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await uploadFileViaProxy(bucketId, relativePath, file, onChunk, signal);
    } catch (err) {
      if (signal?.aborted) throw new Error('Upload cancelled');

      const failure =
        err instanceof UploadAttemptError
          ? err
          : // Anything else thrown here has no response behind it.
            new UploadAttemptError(err instanceof Error ? err.message : String(err), true, null);

      if (!failure.retryable || attempt >= UPLOAD_MAX_RETRIES) throw new Error(failure.message);

      const wait = backoffMs(attempt, failure.retryAfter);
      onRetry(attempt + 1, wait, failure.message);
      await sleep(wait, signal);
    }
  }
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

    // Progress for this file never goes backwards, even though a retry restarts
    // the transfer: the bar tracks how much has been sent successfully, and
    // showing it fall would read as the upload undoing itself.
    let furthest = 0;
    const reportChunk = (loaded: number) => {
      furthest = Math.max(furthest, loaded);
      const percent = 5 + ((uploadedBeforeCurrent + furthest) / totalBytes) * 85;
      onProgress({ percent, message: label });
    };

    const uploaded = await uploadFileWithRetry(
      context.bucketId,
      relativePath,
      file,
      reportChunk,
      (attempt, waitMs, reason) => {
        // Say why and how long: a silent pause between attempts is
        // indistinguishable from a hang.
        onProgress({
          percent: 5 + ((uploadedBeforeCurrent + furthest) / totalBytes) * 85,
          message: `${label} — retry ${attempt}/${UPLOAD_MAX_RETRIES} in ${Math.ceil(
            waitMs / 1000,
          )}s (${reason})`,
        });
      },
      signal,
    );

    if (!uploaded.key) {
      throw new Error(`Upload of "${file.name}" did not return an object key`);
    }

    uploadedBeforeCurrent += file.size;
    completed.push({
      key: uploaded.key,
      name: uploaded.name,
      size: uploaded.size,
      contentType: uploaded.contentType,
      relativePath,
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

import { describe, expect, it } from 'vitest';
import { isRetryableS3Error, s3ErrorHttpStatus } from './s3.js';

/** Shape the SDK uses: the HTTP status lives under $metadata. */
function s3Error(status?: number, extra: Record<string, unknown> = {}) {
  return status === undefined
    ? { name: 'Error', message: 'connection failed', ...extra }
    : { name: 'Error', message: 'failed', $metadata: { httpStatusCode: status }, ...extra };
}

describe('isRetryableS3Error', () => {
  it('retries a status-less transport failure', () => {
    // This is the case that maps to 502: DNS, TLS, refused, reset. The
    // environment was momentarily unreachable, not the request wrong.
    expect(isRetryableS3Error(s3Error())).toBe(true);
    expect(isRetryableS3Error(new Error('socket hang up'))).toBe(true);
  });

  it('retries 5xx from the storage', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableS3Error(s3Error(status))).toBe(true);
    }
  });

  it('retries throttling and request timeouts', () => {
    expect(isRetryableS3Error(s3Error(429))).toBe(true);
    expect(isRetryableS3Error(s3Error(408))).toBe(true);
  });

  it('does not retry client errors that will fail identically', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableS3Error(s3Error(status))).toBe(false);
    }
  });

  it('agrees with the status mapping it accompanies', () => {
    // The retry verdict and the reported status are derived from the same
    // metadata; a status-less error must read as both 502 and retryable, or the
    // client is told to retry something reported as a client error.
    const transportFailure = s3Error();
    expect(s3ErrorHttpStatus(transportFailure)).toBe(502);
    expect(isRetryableS3Error(transportFailure)).toBe(true);

    const denied = s3Error(403);
    expect(s3ErrorHttpStatus(denied)).toBe(403);
    expect(isRetryableS3Error(denied)).toBe(false);
  });
});

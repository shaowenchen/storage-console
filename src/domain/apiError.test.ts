import { describe, expect, it } from 'vitest';
import { apiErrorBody, sendApiError } from './apiError.js';
import type { Response } from 'express';

/** Capture what sendApiError would write, without a live response. */
function capture(): { res: Response; status: () => number; body: () => unknown } {
  let status = 0;
  let body: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => status, body: () => body };
}

describe('apiErrorBody', () => {
  it('omits retryable when it was not stated, so absent means unknown', () => {
    expect(apiErrorBody('boom', 'code')).toEqual({ error: { code: 'code', message: 'boom' } });
    expect('retryable' in apiErrorBody('boom', 'code').error).toBe(false);
  });

  it('keeps details when present', () => {
    expect(apiErrorBody('boom', 'code', ['a', 'b'])).toEqual({
      error: { code: 'code', message: 'boom', details: ['a', 'b'] },
    });
  });
});

describe('sendApiError', () => {
  it('writes the status and body', () => {
    const { res, status, body } = capture();
    sendApiError(res, 404, 'Storage not found');
    expect(status()).toBe(404);
    expect(body()).toEqual({ error: { code: 'storage_not_found', message: 'Storage not found' } });
  });

  it('passes the retryable verdict through', () => {
    const { res, body } = capture();
    sendApiError(res, 503, 'Server is busy uploading; retry this file shortly', 'server_busy', undefined, true);
    expect(body()).toEqual({
      error: {
        code: 'server_busy',
        message: 'Server is busy uploading; retry this file shortly',
        retryable: true,
      },
    });
  });

  it('can state that a failure is permanent', () => {
    const { res, body } = capture();
    sendApiError(res, 400, 'too big', undefined, undefined, false);
    expect((body() as { error: { retryable?: boolean } }).error.retryable).toBe(false);
  });
});

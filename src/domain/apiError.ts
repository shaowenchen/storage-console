import type { Response } from 'express';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: string[];
    /**
     * Whether re-sending the same request could reasonably succeed.
     *
     * Stated explicitly rather than left for the client to infer from the status
     * class, because the status alone is ambiguous here: this service reports an
     * upstream storage failure as 502, which is retryable, while a 400 for an
     * oversized file uses the same route and is not.
     */
    retryable?: boolean;
  };
}

export const INTERNAL_ERROR_CODE = 'internal_error';
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export function slugifyErrorCode(message: string): string {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
  return slug || 'error';
}

export function apiErrorBody(message: string, code?: string, details?: string[]): ApiErrorBody {
  const body: ApiErrorBody = {
    error: {
      code: code ?? slugifyErrorCode(message),
      message,
    },
  };
  if (details?.length) body.error.details = details;
  return body;
}

export function sendApiError(
  res: Response,
  status: number,
  message: string,
  code?: string,
  details?: string[],
  retryable?: boolean,
): void {
  const body = apiErrorBody(message, code, details);
  if (retryable !== undefined) body.error.retryable = retryable;
  res.status(status).json(body);
}

import type { Response } from 'express';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: string[];
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
): void {
  res.status(status).json(apiErrorBody(message, code, details));
}

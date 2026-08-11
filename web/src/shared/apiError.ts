export function parseApiError(data: unknown, fallback = 'Request failed'): string {
  if (!data || typeof data !== 'object') return fallback;
  const error = (data as { error?: { message?: string } }).error;
  if (error && typeof error.message === 'string') return error.message;
  return fallback;
}

export function parseApiErrorDetails(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const error = (data as { error?: { details?: string[] } }).error;
  if (error && Array.isArray(error.details)) return error.details;
  return [];
}

export function formatApiError(data: unknown, fallback = 'Request failed'): string {
  const message = parseApiError(data, fallback);
  const details = parseApiErrorDetails(data);
  if (!details.length) return message;
  return `${message}\n${details.join('\n')}`;
}

import { getRoutePrefix } from './config';
import { formatApiError } from './apiError';

export function apiUrl(path: string): string {
  const prefix = getRoutePrefix();
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${prefix}/api${normalized}`;
}

/** Optional API key for scripts/automation. Browser UI uses session cookies. */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  options?: { apiKey?: string },
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.apiKey) {
    headers.set('X-API-Key', options.apiKey);
  }
  return fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'same-origin',
  });
}

export async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      throw new Error(
        res.ok
          ? 'Server returned an invalid response'
          : `Request failed (${res.status}): server returned non-JSON response${preview ? `: ${preview}` : ''}`,
      );
    }
  }
  if (!res.ok) {
    throw new Error(formatApiError(data, res.statusText || 'Request failed'));
  }
  return data as T;
}

export { getRoutePrefix };

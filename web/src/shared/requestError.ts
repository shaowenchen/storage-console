export function requestErrorMessage(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}

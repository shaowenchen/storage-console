export function getRoutePrefix(): string {
  const fromWindow = window.__STORAGE_CONSOLE_CONFIG__?.routePrefix;
  if (typeof fromWindow === 'string') {
    return fromWindow.replace(/\/+$/, '') || '';
  }
  return '';
}

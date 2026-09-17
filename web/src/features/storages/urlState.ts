/**
 * The browser's view, encoded in the URL.
 *
 * Which storage is open and which folder is being browsed both live in the
 * query string, so a refresh — or a copied link — lands back on the same
 * listing instead of the first bucket's root.
 */
export type StorageLocation = {
  storageId: string | null;
  prefix: string;
};

const STORAGE_PARAM = 'storage';
const PREFIX_PARAM = 'prefix';

/** Strip slashes so a hand-edited or copied URL still lands somewhere valid. */
function normalizePrefix(value: string | null): string {
  return String(value ?? '').replace(/^\/+|\/+$/g, '');
}

export function parseStorageLocation(params: URLSearchParams): StorageLocation {
  return {
    storageId: params.get(STORAGE_PARAM)?.trim() || null,
    prefix: normalizePrefix(params.get(PREFIX_PARAM)),
  };
}

/**
 * Returns a copy with only these two params rewritten, so anything else
 * carried in the URL survives.
 */
export function applyStorageLocation(
  params: URLSearchParams,
  location: StorageLocation,
): URLSearchParams {
  const next = new URLSearchParams(params);

  if (location.storageId) {
    next.set(STORAGE_PARAM, location.storageId);
  } else {
    // A prefix without a storage has no listing to point at.
    next.delete(STORAGE_PARAM);
    next.delete(PREFIX_PARAM);
    return next;
  }

  const prefix = normalizePrefix(location.prefix);
  if (prefix) next.set(PREFIX_PARAM, prefix);
  else next.delete(PREFIX_PARAM);
  return next;
}

export function storageLocationKey(location: StorageLocation): string {
  return `${location.storageId ?? ''}\0${location.prefix}`;
}

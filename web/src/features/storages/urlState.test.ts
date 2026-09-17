import { describe, expect, it } from 'vitest';
import { applyStorageLocation, parseStorageLocation, storageLocationKey } from './urlState.js';

describe('parseStorageLocation', () => {
  it('reads the storage and prefix', () => {
    const parsed = parseStorageLocation(new URLSearchParams('storage=abc&prefix=logs%2F2026'));
    expect(parsed).toEqual({ storageId: 'abc', prefix: 'logs/2026' });
  });

  it('treats a missing prefix as the root', () => {
    expect(parseStorageLocation(new URLSearchParams('storage=abc'))).toEqual({
      storageId: 'abc',
      prefix: '',
    });
  });

  it('treats an empty URL as nothing selected', () => {
    expect(parseStorageLocation(new URLSearchParams(''))).toEqual({
      storageId: null,
      prefix: '',
    });
  });

  it('normalises stray slashes', () => {
    // A copied or hand-edited URL should still land somewhere valid.
    expect(parseStorageLocation(new URLSearchParams('storage=abc&prefix=%2Flogs%2F'))).toEqual({
      storageId: 'abc',
      prefix: 'logs',
    });
  });

  it('ignores a blank storage id', () => {
    expect(parseStorageLocation(new URLSearchParams('storage=%20&prefix=logs')).storageId).toBe(
      null,
    );
  });
});

describe('applyStorageLocation', () => {
  it('writes the location and preserves unrelated params', () => {
    const params = applyStorageLocation(new URLSearchParams('foo=bar'), {
      storageId: 'abc',
      prefix: 'logs/2026',
    });
    expect(params.get('storage')).toBe('abc');
    expect(params.get('prefix')).toBe('logs/2026');
    expect(params.get('foo')).toBe('bar');
  });

  it('drops the prefix at the root, so the URL stays clean', () => {
    const params = applyStorageLocation(new URLSearchParams('storage=abc&prefix=logs'), {
      storageId: 'abc',
      prefix: '',
    });
    expect(params.get('storage')).toBe('abc');
    expect(params.has('prefix')).toBe(false);
  });

  it('drops both params when nothing is selected', () => {
    const params = applyStorageLocation(new URLSearchParams('storage=abc&prefix=logs'), {
      storageId: null,
      prefix: 'logs',
    });
    expect(params.has('storage')).toBe(false);
    expect(params.has('prefix')).toBe(false);
  });

  it('does not mutate the input', () => {
    const original = new URLSearchParams('storage=abc&prefix=logs');
    applyStorageLocation(original, { storageId: null, prefix: '' });
    expect(original.get('storage')).toBe('abc');
  });

  it('round-trips a prefix containing slashes and spaces', () => {
    const location = { storageId: 'abc', prefix: 'my folder/sub dir' };
    const params = applyStorageLocation(new URLSearchParams(''), location);
    expect(parseStorageLocation(params)).toEqual(location);
  });
});

describe('storageLocationKey', () => {
  it('distinguishes the same prefix in different storages', () => {
    expect(storageLocationKey({ storageId: 'a', prefix: 'logs' })).not.toBe(
      storageLocationKey({ storageId: 'b', prefix: 'logs' }),
    );
  });

  it('distinguishes root from a nested prefix', () => {
    expect(storageLocationKey({ storageId: 'a', prefix: '' })).not.toBe(
      storageLocationKey({ storageId: 'a', prefix: 'logs' }),
    );
  });
});

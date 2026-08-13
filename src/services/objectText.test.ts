import { describe, expect, it } from 'vitest';
import {
  gateObjectTextAccess,
  guessTextContentType,
  isTextContentType,
  looksLikeTextObjectKey,
  MAX_OBJECT_TEXT_BYTES,
} from './objectText.js';

describe('objectText', () => {
  it('detects common text extensions including json', () => {
    expect(looksLikeTextObjectKey('config/app.json')).toBe(true);
    expect(looksLikeTextObjectKey('README.md')).toBe(true);
    expect(looksLikeTextObjectKey('.env')).toBe(true);
    expect(looksLikeTextObjectKey('archive.tar.gz')).toBe(false);
    expect(looksLikeTextObjectKey('photo.png')).toBe(false);
  });

  it('accepts text MIME types', () => {
    expect(isTextContentType('application/json; charset=utf-8')).toBe(true);
    expect(isTextContentType('text/plain')).toBe(true);
    expect(isTextContentType('application/octet-stream')).toBe(false);
  });

  it('gates oversized objects', () => {
    const result = gateObjectTextAccess({
      key: 'big.json',
      contentLength: MAX_OBJECT_TEXT_BYTES + 1,
      contentType: 'application/json',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_large');
  });

  it('gates non-text objects', () => {
    const result = gateObjectTextAccess({
      key: 'blob.bin',
      contentLength: 12,
      contentType: 'application/octet-stream',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_text');
  });

  it('guesses content type from extension', () => {
    expect(guessTextContentType('a/b.json')).toBe('application/json');
    expect(guessTextContentType('notes.txt')).toBe('text/plain');
  });
});

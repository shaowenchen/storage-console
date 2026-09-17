import { describe, expect, it } from 'vitest';
import {
  gateObjectTextAccess,
  guessTextContentType,
  inlineContentTypeHint,
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

describe('inlineContentTypeHint', () => {
  it('recovers a text type when the stored type is generic', () => {
    // The uploader stores octet-stream for these, which would force a download.
    expect(inlineContentTypeHint('logs/run.sh', 'application/octet-stream')).toBe(
      'text/x-shellscript',
    );
    expect(inlineContentTypeHint('config/app.yaml', 'application/octet-stream')).toBe(
      'application/yaml',
    );
    expect(inlineContentTypeHint('readme.md', undefined)).toBe('text/markdown');
    expect(inlineContentTypeHint('run.sh', null)).toBe('text/x-shellscript');
    expect(inlineContentTypeHint('data.csv', 'application/octet-stream; charset=binary')).toBe(
      'text/csv',
    );
  });

  it('never overrides a real stored type', () => {
    expect(inlineContentTypeHint('readme.md', 'text/markdown')).toBeUndefined();
    expect(inlineContentTypeHint('photo.png', 'image/png')).toBeUndefined();
  });

  it('leaves binaries alone even when the stored type is generic', () => {
    // guessTextContentType falls back to text/plain, which would corrupt these.
    expect(inlineContentTypeHint('photo.png', 'application/octet-stream')).toBeUndefined();
    expect(inlineContentTypeHint('archive.tar.gz', undefined)).toBeUndefined();
    expect(inlineContentTypeHint('model.bin', 'application/octet-stream')).toBeUndefined();
  });

  it('does not treat an unknown extension as text', () => {
    expect(inlineContentTypeHint('data.unknownext', 'application/octet-stream')).toBeUndefined();
  });
});

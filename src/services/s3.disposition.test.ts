import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from './s3.js';

describe('attachmentContentDisposition', () => {
  it('uses an unquoted token for plain ASCII names', () => {
    expect(attachmentContentDisposition('col_gpu_log.sh')).toBe(
      'attachment; filename=col_gpu_log.sh',
    );
    expect(attachmentContentDisposition('nvidia-fabricmanager-570_570.158.01-1_amd64.deb')).toBe(
      'attachment; filename=nvidia-fabricmanager-570_570.158.01-1_amd64.deb',
    );
  });

  it('never quotes the filename token', () => {
    // A quoted filename reaches S3-compatible stores as `filename=%22x%22` and
    // saves as `%22x%22`; the token form survives intact.
    const value = attachmentContentDisposition('readme.txt');
    expect(value).toBe('attachment; filename=readme.txt');
    expect(value).not.toContain('"');
    expect(value).not.toContain('%22');
  });

  it('does not emit filename* alongside filename', () => {
    expect(attachmentContentDisposition('readme.txt')).not.toMatch(/filename\*/);
  });

  it('uses filename* only for non-ASCII names', () => {
    expect(attachmentContentDisposition('说明.txt')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('说明.txt')}`,
    );
  });

  it('routes names that are not valid tokens to filename*', () => {
    // SPACE, ';' and "'" are outside the RFC 6266 token charset.
    expect(attachmentContentDisposition('my report.txt')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('my report.txt')}`,
    );
    expect(attachmentContentDisposition('a;b.txt')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('a;b.txt')}`,
    );
    expect(attachmentContentDisposition("it's.txt")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("it's.txt")}`,
    );
  });

  it('strips quotes and control characters', () => {
    expect(attachmentContentDisposition('a"b\nc.txt')).toBe('attachment; filename=a_b_c.txt');
  });

  it('falls back to a token when the name is blank', () => {
    expect(attachmentContentDisposition('   ')).toBe('attachment; filename=download');
  });
});

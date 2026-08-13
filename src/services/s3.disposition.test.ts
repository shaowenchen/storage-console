import { describe, expect, it } from 'vitest';
import { attachmentContentDisposition } from './s3.js';

describe('attachmentContentDisposition', () => {
  it('uses a single quoted filename for ASCII names', () => {
    expect(attachmentContentDisposition('col_gpu_log.sh')).toBe(
      'attachment; filename="col_gpu_log.sh"',
    );
    expect(attachmentContentDisposition('nvidia-fabricmanager-570_570.158.01-1_amd64.deb')).toBe(
      'attachment; filename="nvidia-fabricmanager-570_570.158.01-1_amd64.deb"',
    );
  });

  it('does not emit filename* alongside filename for ASCII', () => {
    const value = attachmentContentDisposition('readme.txt');
    expect(value).toBe('attachment; filename="readme.txt"');
    expect(value).not.toMatch(/filename\*/);
  });

  it('uses filename* only for non-ASCII names', () => {
    expect(attachmentContentDisposition('说明.txt')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('说明.txt')}`,
    );
  });

  it('strips quotes and control characters', () => {
    expect(attachmentContentDisposition('a"b\nc.txt')).toBe('attachment; filename="a_b_c.txt"');
  });
});

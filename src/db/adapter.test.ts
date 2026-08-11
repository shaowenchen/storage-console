import { describe, expect, it } from 'vitest';
import { mysqlSslFromDsn, parseSqlDsn } from './adapter.js';

describe('parseSqlDsn', () => {
  it('defaults to sqlite under home when unset', () => {
    const parsed = parseSqlDsn(undefined);
    expect(parsed.type).toBe('sqlite');
    if (parsed.type === 'sqlite') {
      expect(parsed.path).toMatch(/storage-console\.sqlite$/);
    }
  });

  it('parses mysql:// DSNs', () => {
    const dsn = 'mysql://u:p@host:4000/storage_console?tls=skip-verify';
    expect(parseSqlDsn(dsn)).toEqual({ type: 'mysql', dsn });
  });

  it('parses sqlite:// paths', () => {
    expect(parseSqlDsn('sqlite:///tmp/test.sqlite')).toEqual({
      type: 'sqlite',
      path: '/tmp/test.sqlite',
    });
  });

  it('treats bare paths as sqlite', () => {
    expect(parseSqlDsn('/var/db/app.sqlite')).toEqual({
      type: 'sqlite',
      path: '/var/db/app.sqlite',
    });
  });
});

describe('mysqlSslFromDsn', () => {
  it('disables cert verification for tls=skip-verify', () => {
    expect(mysqlSslFromDsn('mysql://u:p@h:4000/db?tls=skip-verify')).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('requires cert verification by default', () => {
    expect(mysqlSslFromDsn('mysql://u:p@h:3306/db')).toEqual({
      rejectUnauthorized: true,
    });
  });
});

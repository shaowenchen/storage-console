import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client, type CORSRule } from '@aws-sdk/client-s3';
import {
  ensureBucketCors,
  isAcceptableOrigin,
  originFromRequest,
  resetCorsCacheForTests,
} from './s3Cors.js';
import type { Bucket } from '../db/store.js';

/**
 * The origin written into the bucket's CORS policy comes from a request header,
 * so what it may contain is the security-sensitive part of this module: a policy
 * that admits any origin means any site on the internet can use a signed URL to
 * write to the bucket.
 *
 * The other half is not clobbering what is already there — buckets are often
 * shared with other applications, and their rules are not ours to remove.
 */

function bucketFor(endpoint: string): Bucket {
  return {
    id: 'bucket-1',
    name: 'test',
    storageType: 'ObjectStorage',
    endpoint,
    region: 'us-east-1',
    accessKey: 'a',
    secretKey: 'b',
    bucketName: 'b',
    bucketPath: '',
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  } as unknown as Bucket;
}

/** A storage that records CORS reads and writes and replays a scripted policy. */
async function startFakeBucket(options: { existingRules?: CORSRule[]; putShouldFail?: boolean } = {}) {
  const puts: CORSRule[][] = [];
  let hasPolicy = options.existingRules !== undefined;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      if (!hasPolicy) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>NoSuchCORSConfiguration</Code></Error>');
        return;
      }
      const rules = (options.existingRules ?? [])
        .map(
          (rule) =>
            `<CORSRule><AllowedOrigin>${(rule.AllowedOrigins ?? []).join('</AllowedOrigin><AllowedOrigin>')}</AllowedOrigin><AllowedMethod>${(rule.AllowedMethods ?? []).join('</AllowedMethod><AllowedMethod>')}</AllowedMethod><ExposeHeader>${(rule.ExposeHeaders ?? []).join('</ExposeHeader><ExposeHeader>')}</ExposeHeader></CORSRule>`,
        )
        .join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><CORSConfiguration>${rules}</CORSConfiguration>`);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const xml = Buffer.concat(chunks).toString('utf8');
      const origins = [...xml.matchAll(/<AllowedOrigin>(.*?)<\/AllowedOrigin>/g)].map((m) => m[1]!);
      const methods = [...xml.matchAll(/<AllowedMethod>(.*?)<\/AllowedMethod>/g)].map((m) => m[1]!);
      const exposed = [...xml.matchAll(/<ExposeHeader>(.*?)<\/ExposeHeader>/g)].map((m) => m[1]!);
      // Reconstruct the rules as the store would interpret them.
      const rules: CORSRule[] = [];
      for (let i = 0; i < origins.length; i++) {
        rules.push({
          AllowedOrigins: [origins[i]!],
          AllowedMethods: methods,
          ExposeHeaders: exposed,
        });
      }
      puts.push(rules);
      if (options.putShouldFail) {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>');
        return;
      }
      hasPolicy = true;
      res.writeHead(200);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    puts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('isAcceptableOrigin', () => {
  it('accepts a real origin', () => {
    expect(isAcceptableOrigin('https://console.example.com')).toBe(true);
    expect(isAcceptableOrigin('http://localhost:5173')).toBe(true);
    expect(isAcceptableOrigin('http://127.0.0.1:3001')).toBe(true);
  });

  it('refuses a wildcard, which would admit every site on the internet', () => {
    // The dangerous case: a policy allowing `*` means any page a signed URL
    // leaks to can write to the bucket.
    expect(isAcceptableOrigin('*')).toBe(false);
  });

  it('refuses anything that is not a bare origin', () => {
    for (const value of [
      '',
      '   ',
      'not a url',
      '//example.com',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'https://example.com/some/path',
      'https://example.com?x=1',
      'https://example.com#frag',
    ]) {
      expect(isAcceptableOrigin(value)).toBe(false);
    }
  });
});

describe('originFromRequest', () => {
  it('reads a usable Origin header', () => {
    expect(originFromRequest({ origin: 'https://console.example.com' })).toBe(
      'https://console.example.com',
    );
  });

  it('normalises a trailing slash', () => {
    expect(originFromRequest({ origin: 'https://console.example.com/' })).toBe(
      'https://console.example.com',
    );
  });

  it('ignores an unusable or absent Origin', () => {
    expect(originFromRequest({})).toBeNull();
    expect(originFromRequest({ origin: '*' })).toBeNull();
    expect(originFromRequest({ origin: 'null' })).toBeNull();
  });
});

describe('ensureBucketCors', () => {
  let bucket: Awaited<ReturnType<typeof startFakeBucket>>;
  let client: S3Client;

  beforeEach(() => {
    resetCorsCacheForTests();
  });

  afterEach(async () => {
    await bucket?.close();
  });

  async function setup(options?: Parameters<typeof startFakeBucket>[0]) {
    bucket = await startFakeBucket(options);
    client = new S3Client({
      endpoint: bucket.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    return bucketFor(bucket.endpoint);
  }

  it('writes a rule when the bucket has no policy at all', async () => {
    const b = await setup();
    const result = await ensureBucketCors(client, b, 'https://console.example.com');
    expect(result.ok).toBe(true);
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]![0]!.AllowedOrigins).toEqual(['https://console.example.com']);
    expect(bucket.puts[0]![0]!.AllowedMethods).toContain('PUT');
  });

  it('exposes ETag, without which completion cannot read the part etags', async () => {
    // Part uploads would all succeed and the upload still fail, because a
    // cross-origin response's headers are invisible to JavaScript unless they
    // are named in the policy.
    const b = await setup();
    await ensureBucketCors(client, b, 'https://console.example.com');
    expect(bucket.puts[0]![0]!.ExposeHeaders).toContain('ETag');
  });

  it('keeps rules belonging to other applications', async () => {
    // A shared bucket's other rules are not ours to remove.
    const b = await setup({
      existingRules: [
        {
          AllowedOrigins: ['https://other.example.com'],
          AllowedMethods: ['GET'],
          ExposeHeaders: [],
        },
      ],
    });
    await ensureBucketCors(client, b, 'https://console.example.com');
    const origins = bucket.puts[0]!.flatMap((rule) => rule.AllowedOrigins ?? []);
    expect(origins).toContain('https://other.example.com');
    expect(origins).toContain('https://console.example.com');
  });

  it('replaces a rule that covers the origin but hides the ETag', async () => {
    // Adding alongside would leave the browser matching the older rule first,
    // and every part would upload only for completion to fail.
    const b = await setup({
      existingRules: [
        {
          AllowedOrigins: ['https://console.example.com'],
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          ExposeHeaders: [],
        },
      ],
    });
    await ensureBucketCors(client, b, 'https://console.example.com');
    const rules = bucket.puts[0]!.filter((rule) =>
      (rule.AllowedOrigins ?? []).includes('https://console.example.com'),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.ExposeHeaders).toContain('ETag');
  });

  it('leaves a bucket alone once it permits the origin', async () => {
    const b = await setup({
      existingRules: [
        {
          AllowedOrigins: ['https://console.example.com'],
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          ExposeHeaders: ['ETag'],
        },
      ],
    });
    const result = await ensureBucketCors(client, b, 'https://console.example.com');
    expect(result.ok).toBe(true);
    // Nothing was rewritten.
    expect(bucket.puts).toHaveLength(0);
  });

  it('reports failure instead of throwing when the policy cannot be written', async () => {
    // Direct upload is an optimisation; a bucket that refuses must not be able
    // to fail the upload, only to make it take the slower path.
    const b = await setup({ putShouldFail: true });
    const result = await ensureBucketCors(client, b, 'https://console.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/CORS/i);
  });

  it('refuses to rewrite a policy it could not read', async () => {
    // Writing blind would delete rules we cannot see.
    const b = await setup();
    await bucket.close();
    // Nothing is listening now, so the read fails for a reason other than
    // "no policy".
    const result = await ensureBucketCors(client, b, 'https://console.example.com');
    expect(result.ok).toBe(false);
  });

  it('refuses an unusable origin rather than writing it to the bucket', async () => {
    const b = await setup();
    const result = await ensureBucketCors(client, b, '*');
    expect(result.ok).toBe(false);
    expect(bucket.puts).toHaveLength(0);
  });

  it('remembers what it configured, so later uploads do not re-read the policy', async () => {
    const b = await setup();
    await ensureBucketCors(client, b, 'https://console.example.com');
    await ensureBucketCors(client, b, 'https://console.example.com');
    expect(bucket.puts).toHaveLength(1);
  });

  it('does not treat a second origin as already covered', async () => {
    // A console reachable at two hostnames is two origins. Remembering only the
    // bucket would tell the second one it is fine, and its browser would then
    // fail every part against a bucket that has never heard of it.
    const b = await setup({
      existingRules: [
        {
          AllowedOrigins: ['https://first.example.com'],
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          ExposeHeaders: ['ETag'],
        },
      ],
    });
    await ensureBucketCors(client, b, 'https://first.example.com');
    expect(bucket.puts).toHaveLength(0);

    await ensureBucketCors(client, b, 'https://second.example.com');
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]!.flatMap((rule) => rule.AllowedOrigins ?? [])).toContain(
      'https://second.example.com',
    );
  });
});

describe('CORS command availability', () => {
  it('is implemented by the SDK this project depends on', () => {
    // A guard against a dependency change quietly removing the ability to
    // configure this at all.
    expect(typeof GetBucketCorsCommand).toBe('function');
    expect(typeof PutBucketCorsCommand).toBe('function');
  });
});

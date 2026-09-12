import { describe, expect, it } from 'vitest';
import express from 'express';
import { jsonBodyParser, isRawObjectUploadRequest } from './jsonBodyParser.js';
import type { Express, Request } from 'express';

function fakeRequest(method: string, path: string): Request {
  return { method, path } as Request;
}

describe('isRawObjectUploadRequest', () => {
  it('matches the browser upload proxy PUT, with or without a route prefix', () => {
    expect(isRawObjectUploadRequest(fakeRequest('PUT', '/api/storages/abc/upload-object'))).toBe(
      true,
    );
    expect(
      isRawObjectUploadRequest(fakeRequest('PUT', '/console/api/storages/abc/upload-object/')),
    ).toBe(true);
    // Express matches routes case-insensitively, so this must not diverge from it.
    expect(isRawObjectUploadRequest(fakeRequest('PUT', '/api/Storages/abc/Upload-Object'))).toBe(
      true,
    );
  });

  it('leaves every other route to the JSON parser', () => {
    expect(isRawObjectUploadRequest(fakeRequest('PUT', '/api/storages/abc/text-object'))).toBe(
      false,
    );
    expect(isRawObjectUploadRequest(fakeRequest('POST', '/api/storages/abc/upload-links'))).toBe(
      false,
    );
    expect(isRawObjectUploadRequest(fakeRequest('GET', '/api/storages/abc/upload-object'))).toBe(
      false,
    );
    // A storage literally named "upload-object" must not disable JSON parsing
    // for its own metadata routes.
    expect(isRawObjectUploadRequest(fakeRequest('PUT', '/api/storages/upload-object'))).toBe(false);
    expect(
      isRawObjectUploadRequest(fakeRequest('PUT', '/api/storages/abc/upload-object/extra')),
    ).toBe(false);
  });
});

/** Run the parser against a real app and report what the route observed. */
async function putThroughApp(
  app: Express,
  path: string,
  contentType: string,
  body: Buffer,
): Promise<{ status: number; payload: unknown; receivedBytes: number }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    });
    return (await res.json()) as { status: number; payload: unknown; receivedBytes: number };
  } finally {
    server.close();
  }
}

function buildApp(): Express {
  const app = express();
  app.use(jsonBodyParser());
  app.put('*', (req, res) => {
    // Mirrors how the real routes read their body. When the parser ran, the
    // stream is already consumed and the payload is on req.body; when it stood
    // aside, the route is the only reader and streams the bytes itself.
    if (req.body !== undefined) {
      res.json({ status: 200, payload: req.body, receivedBytes: 0 });
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.json({ status: 200, payload: null, receivedBytes: Buffer.concat(chunks).length });
    });
  });
  app.use((err: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number })?.status ?? 500;
    const type = (err as { type?: string })?.type ?? 'unknown';
    res.status(status).json({ status, payload: type, receivedBytes: 0 });
  });
  return app;
}

describe('jsonBodyParser', () => {
  const jsonBody = Buffer.from(JSON.stringify({ name: 'a.json', content: 'hello' }));

  it('still parses JSON bodies on ordinary routes', async () => {
    const result = await putThroughApp(
      buildApp(),
      '/api/storages/abc/text-object',
      'application/json',
      jsonBody,
    );
    expect(result.status).toBe(200);
    expect(result.payload).toEqual({ name: 'a.json', content: 'hello' });
  });

  it('streams a JSON-typed file body to the upload route instead of parsing it', async () => {
    // Regression: a file named *.json uploads as application/json, and the
    // global parser used to buffer it and reject it before the route ran.
    const fileBytes = Buffer.from('{"not":"a request body"}\n');
    const result = await putThroughApp(
      buildApp(),
      '/api/storages/abc/upload-object',
      'application/json',
      fileBytes,
    );
    expect(result.status).toBe(200);
    expect(result.payload).toBeNull();
    expect(result.receivedBytes).toBe(fileBytes.length);
  });

  it('streams an upload larger than the JSON parser limit', async () => {
    const bigFile = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const result = await putThroughApp(
      buildApp(),
      '/api/storages/abc/upload-object',
      'application/json',
      bigFile,
    );
    expect(result.status).toBe(200);
    expect(result.receivedBytes).toBe(bigFile.length);
  });

  it('keeps enforcing the JSON body limit where the parser does apply', async () => {
    const result = await putThroughApp(
      buildApp(),
      '/api/storages/abc/text-object',
      'application/json',
      Buffer.alloc(3 * 1024 * 1024, 0x61),
    );
    expect(result.status).toBe(413);
  });
});

import { createHmac, timingSafeEqual } from 'crypto';
import { getSessionSecret } from '../config/env.js';
import { UPLOAD_SESSION_TTL_MS } from '../config/upload.js';

/**
 * One in-flight chunked upload, as the server remembers it.
 *
 * The storage's own `uploadId` is carried here and never handed to the browser
 * in the clear. It is a capability: anyone holding it can add parts to that
 * upload, and `Key` is a parameter of the part request rather than of the
 * upload, so exposing it would let a client write parts to an arbitrary key —
 * past the configured `bucketPath` prefix the whole route layer is built
 * around. The client gets a signed token instead, and the server reads the key
 * it computed back out of it.
 */
export interface UploadSession {
  /** Storage-side multipart upload id. Never used by the browser directly. */
  uploadId: string;
  bucketId: string;
  /** Fully-resolved object key, computed server-side at creation. */
  key: string;
  contentType: string;
  /** Total object size the client declared, checked again at completion. */
  size: number;
  /** Part size sealed at creation, so a config change cannot desync a session. */
  partSize: number;
  /** Total bytes of the last part, which is the only one allowed to be short. */
  lastPartSize: number;
  /** Who started it, so a token cannot be replayed by another account. */
  userId: string;
  issuedAt: number;
}

/**
 * Upload sessions are carried by the client, not stored by the server.
 *
 * The obvious alternative — a `Map` keyed by a random token — works exactly
 * until there is more than one process serving requests, and then fails in the
 * worst possible way: part 40 of a 1 GB upload lands on a replica that never saw
 * the session and is rejected as unknown, so some parts succeed and some do not
 * depending on which instance the load balancer picked. Nothing in the response
 * points at the cause. The same holds across a restart, where every in-flight
 * upload is lost at once.
 *
 * Signing the session into the token removes the shared state entirely: any
 * instance can verify it, because the secret lives in the database
 * (`getSessionSecret`), and a restart changes nothing. The cost is that the
 * token is larger and that its contents are readable by whoever holds it —
 * which is why the contents are only ever what the client already knows, and
 * the storage's `uploadId` is not among them.
 *
 * Tokens are signed, not encrypted. The signature is what matters: a client
 * cannot alter the key, the size, or the upload id without invalidating it.
 */
export function createSessionToken(session: Omit<UploadSession, 'issuedAt'>): string {
  const payload: UploadSession = { ...session, issuedAt: Date.now() };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Tolerance for a token issued by an instance whose clock is slightly ahead. */
const CLOCK_SKEW_MS = 60 * 1000;

function sign(body: string): string {
  // Domain-separated so a signature minted for one purpose can never be
  // presented as another, even though both use the same secret.
  return createHmac('sha256', getSessionSecret()).update(`upload-session:${body}`).digest('base64url');
}

/**
 * Verify a token and return its session, or null if it is forged or expired.
 *
 * Expiry is checked on read rather than by sweeping: nothing has to be stored,
 * so an abandoned upload costs nothing until someone presents its token.
 */
export function parseSessionToken(token: string, now = Date.now()): UploadSession | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  let parsed: UploadSession;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadSession;
  } catch {
    return null;
  }

  if (!parsed?.uploadId || !parsed?.bucketId || !parsed?.key) return null;
  if (!Number.isFinite(parsed.size) || parsed.size <= 0) return null;
  if (!Number.isFinite(parsed.partSize) || parsed.partSize <= 0) return null;
  if (!Number.isFinite(parsed.lastPartSize) || parsed.lastPartSize <= 0) return null;
  if (!Number.isFinite(parsed.issuedAt)) return null;
  if (now - parsed.issuedAt > UPLOAD_SESSION_TTL_MS) return null;
  if (now < parsed.issuedAt - CLOCK_SKEW_MS) return null;

  return parsed;
}

/** How many parts a session's size works out to, at its sealed part size. */
export function sessionPartCount(session: Pick<UploadSession, 'size' | 'partSize'>): number {
  return Math.ceil(session.size / session.partSize);
}

/**
 * The exact byte length part `partNumber` must have.
 *
 * Derived rather than accepted from the client: the size and part size are
 * sealed in the token, so the server knows precisely how long every part should
 * be. That turns "the object came out the wrong size" into an error at the
 * offending part, with no trust in anything the client reports.
 */
export function expectedPartLength(
  session: Pick<UploadSession, 'size' | 'partSize' | 'lastPartSize'>,
  partNumber: number,
): number {
  return partNumber === sessionPartCount(session) ? session.lastPartSize : session.partSize;
}

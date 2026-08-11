import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { getSessionSecret } from '../config/env.js';

export const SESSION_COOKIE_NAME = 'storageconsole_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  userId: string;
  user: string;
  issuedAt: number;
}

function cookiePath(): string {
  return '/';
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return undefined;
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

export function createSessionToken(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}

export function parseSessionToken(token: string): SessionData | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = signPayload(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionData;
    if (!data?.userId || !data?.user || !data?.issuedAt) return null;
    if (Date.now() - data.issuedAt > SESSION_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function readSession(req: Request): SessionData | null {
  const raw = readCookie(req, SESSION_COOKIE_NAME);
  if (!raw) return null;
  return parseSessionToken(raw);
}

export function setSessionCookie(res: Response, data: SessionData): void {
  const token = createSessionToken(data);
  const secure = process.env.NODE_ENV === 'production';
  const maxAgeSec = Math.floor(SESSION_MAX_AGE_MS / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    `Path=${cookiePath()}`,
    `Max-Age=${maxAgeSec}`,
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    `Path=${cookiePath()}`,
    'Max-Age=0',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

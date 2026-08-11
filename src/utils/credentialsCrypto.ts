import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getCredentialsSecret } from '../config/env.js';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(`studio-credentials:${secret}`).digest();
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptCredential(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncryptedCredential(plaintext)) return plaintext;
  const key = deriveKey(getCredentialsSecret());
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString('base64url');
  return `${PREFIX}${payload}`;
}

export function decryptCredential(value: string): string {
  if (!value) return value;
  if (!isEncryptedCredential(value)) {
    throw new Error('Credential is not encrypted');
  }
  const payload = value.slice(PREFIX.length);
  const buf = Buffer.from(payload, 'base64url');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Invalid encrypted credential payload');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
  const key = deriveKey(getCredentialsSecret());
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

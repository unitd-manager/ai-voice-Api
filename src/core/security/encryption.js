import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM envelope: "v1.<iv>.<tag>.<ciphertext>" (base64url). Key = HKDF(ENCRYPTION_KEY).
// In development without ENCRYPTION_KEY a key is derived from the JWT secret so flows still work.
const keyMaterial = env.ENCRYPTION_KEY ?? `dev-only:${env.JWT_REFRESH_SECRET}`;
const KEY = Buffer.from(hkdfSync('sha256', keyMaterial, 'voice-agent-saas', 'field-encryption', 32));

export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Malformed ciphertext');
  const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
export const encryptJson = (o) => encrypt(JSON.stringify(o));
export const decryptJson = (b) => JSON.parse(decrypt(b));

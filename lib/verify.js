// Input checks.
import crypto from 'node:crypto';
import { b58decode } from './units.js';

export class UserError extends Error {}

// A Solana address is a 32-byte public key in base58 (32 to 44 characters).
export function isSolana(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  const b = b58decode(s);
  return !!b && b.length === 32;
}

// A display name a member may choose. Letters, digits, space, - _ . only.
export function cleanName(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/\s+/g, ' ');
  return /^[A-Za-z0-9 _.\-]{1,24}$/.test(t) ? t : null;
}

export const newKey = (slug) => `${slug}_${crypto.randomBytes(24).toString('base64url')}`;
export const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

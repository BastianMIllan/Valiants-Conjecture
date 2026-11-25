// Input checks.
import { b58decode } from './units.js';

export class UserError extends Error {}

// A Solana address is a 32-byte public key in base58 (32 to 44 characters).
export function isSolana(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  const b = b58decode(s);
  return !!b && b.length === 32;
}

// A GitHub username: letters, digits and hyphens, starting with a letter or digit, at most 39 characters.
export const isGithubLogin = (s) => typeof s === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s);

// The line a member publishes in a public gist to link their GitHub account to a wallet.
export const gistLineOf = (tag, wallet) => `${tag} wallet: ${wallet}`;

// What people type for a GitHub account: "alice", "@alice" or "https://github.com/alice".
export function normLogin(s) {
  return String(s ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
}

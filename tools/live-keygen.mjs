// Creates the Ed25519 key pair that signs the live mirror's snapshots.
//
//   npm run live:keygen -- <path of the private key file, outside the repository>
//
// Writes the private key to that path (PEM, PKCS#8; it is never printed) and prints the public
// key, to set as LIVE_PUBKEY on the site. Refuses a path inside the repository and never
// overwrites an existing file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
if (!arg || arg.startsWith('-')) {
  console.error('usage: npm run live:keygen -- <path of the private key file, outside the repository>');
  console.error('for example: npm run live:keygen -- ~/.valiant/live-ed25519-private.pem');
  process.exit(2);
}
const target = path.resolve(arg.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'));

// The path with symbolic links resolved in the part of it that exists already.
function real(p) {
  let head = p;
  const tail = [];
  while (!fs.existsSync(head)) {
    const up = path.dirname(head);
    if (up === head) break;
    tail.unshift(path.basename(head));
    head = up;
  }
  try { head = fs.realpathSync.native(head); } catch {}
  return path.join(head, ...tail);
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel));
};

if (inside(target, repo) || inside(real(target), real(repo))) {
  console.error(`Refused: ${target} is inside the repository (${repo}). A private key must never be stored there. Choose a path outside it.`);
  process.exit(1);
}
if (fs.existsSync(target)) {
  console.error(`Refused: ${target} exists already and is not overwritten. Remove it first or choose another path.`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
console.log(`Private key written to ${target}. Keep it on this machine only: the site never needs it.`);
console.log('Public key, to set as LIVE_PUBKEY on the site:');
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));

// The live mirror's publisher. It runs on the founder's own machine, next to the operator
// dashboard, and never on the site's server.
//
// Every 30 seconds it reads the dashboard's status over HTTP (read only), keeps the public figures
// listed in buildSnapshot (lib/live-snapshot.js) and nothing else (a whitelist: no other field can
// leave the machine), signs the exact bytes with an Ed25519 key and posts them to the site's
// /api/live. The machine is never exposed: it only makes outgoing requests.
//
//   npm run live                 publish every 30 seconds until stopped (errors back off, up to 5 min)
//   npm run live -- --dry-run    print the snapshot that would be published, then exit
//   npm run live -- --once       publish one snapshot, then exit
//
// Environment:
//   DASH_URL       the dashboard status (default http://localhost:4100/api/status)
//   LIVE_URL       the site's endpoint (default https://pequalsnp.onrender.com/api/live)
//   LIVE_KEY_FILE  the Ed25519 private key, PEM (default ~/.valiant/live-ed25519-private.pem),
//                  made by: npm run live:keygen -- <path outside the repository>
//   PNP_REPO       the official repository (default open-goat/pequalnp-proofs)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO } from '../lib/live.js';
import { buildSnapshot, signedBody } from '../lib/live-snapshot.js';
import { fetchText } from '../lib/http.js';

const DASH_URL = process.env.DASH_URL || 'http://localhost:4100/api/status';
const LIVE_URL = process.env.LIVE_URL || 'https://pequalsnp.onrender.com/api/live';
const KEY_FILE = process.env.LIVE_KEY_FILE || path.join(os.homedir(), '.valiant', 'live-ed25519-private.pem');
const REPO = process.env.PNP_REPO || DEFAULT_REPO;
const EVERY_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

const log = (msg) => console.log(`[live] ${new Date().toISOString()} ${msg}`);
const why = (e) => (e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.code || e?.code || e?.message || String(e));

let key = null;
function signingKey() {
  if (key) return key;
  let k;
  try {
    k = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  } catch (e) {
    throw new Error(`no signing key at ${KEY_FILE} (${why(e)}): create one with npm run live:keygen -- <path outside the repository>`);
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new Error(`the key at ${KEY_FILE} is not an Ed25519 private key`);
  key = k;
  log(`signing with the key at ${KEY_FILE}; its public key (LIVE_PUBKEY on the site) is ${crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('base64')}`);
  return key;
}

function sendable(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
}

async function readDashboard() {
  let r;
  try {
    r = await fetchText(DASH_URL, { headers: { accept: 'application/json' }, timeoutMs: 20_000, maxBytes: 64 << 20 });
  } catch (e) {
    throw new Error(`the dashboard did not answer at ${DASH_URL} (${why(e)})`);
  }
  if (!r.ok) throw new Error(`the dashboard answered HTTP ${r.status}`);
  try { return JSON.parse(r.text); } catch { throw new Error('the dashboard answer is not JSON'); }
}

async function publishOnce() {
  if (!sendable(LIVE_URL)) throw new Error(`LIVE_URL must be an https address (or http on localhost): ${LIVE_URL}`);
  const k = signingKey();
  const snapshot = buildSnapshot(await readDashboard(), { repo: REPO });
  const { body, signature } = signedBody(snapshot, k);
  let r;
  try {
    r = await fetch(LIVE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-live-signature': signature, 'user-agent': 'valiant-live-publisher/1.0' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`the site did not answer at ${LIVE_URL} (${why(e)})`);
  }
  const text = (await r.text().catch(() => '')).slice(0, 300);
  if (r.status !== 200) {
    let error = text;
    try { error = JSON.parse(text).error || text; } catch {}
    throw new Error(`the site refused the snapshot: HTTP ${r.status} ${error}`.trim());
  }
  return { bytes: body.length, snapshot };
}

const summary = (r) => {
  const s = r.snapshot;
  return `${Math.ceil(r.bytes / 1024)} KB: ${s.counts.accepted ?? '?'} merged, ${s.waiting.length} checking, board #${s.rank.all ?? '?'} all time, #${s.rank.hour ?? '?'} this hour`;
};

// Never stops on its own: every error is one log line, then a wait of 30 s doubling up to 5 min.
function run() {
  let fails = 0;
  let wait = EVERY_MS;
  let sent = 0;
  let toldAt = 0;
  const tick = async () => {
    try {
      const r = await publishOnce();
      sent++;
      if (fails || Date.now() - toldAt > 15 * 60_000) {
        log(`${fails ? 'publishing again' : 'publishing'}: ${sent} snapshot${sent === 1 ? '' : 's'} sent, latest ${summary(r)}`);
        toldAt = Date.now();
      }
      fails = 0;
      wait = EVERY_MS;
    } catch (e) {
      fails++;
      wait = fails === 1 ? EVERY_MS : Math.min(wait * 2, MAX_BACKOFF_MS);
      log(`${e?.message || e}; next try in ${Math.round(wait / 1000)} s`);
    }
    setTimeout(tick, wait);
  };
  tick();
}

async function main(args) {
  if (args.includes('--dry-run')) {
    try {
      process.stdout.write(`${JSON.stringify(buildSnapshot(await readDashboard(), { repo: REPO }), null, 2)}\n`);
    } catch (e) {
      log(e.message);
      process.exitCode = 1;
    }
    return;
  }
  if (args.includes('--once')) {
    try {
      log(`published one snapshot, ${summary(await publishOnce())}`);
    } catch (e) {
      log(e.message);
      process.exitCode = 1;
    }
    return;
  }
  process.on('uncaughtException', (e) => log(`unexpected error: ${why(e)}`));
  process.on('unhandledRejection', (e) => log(`unexpected error: ${why(e)}`));
  log(`reading ${DASH_URL} and publishing to ${LIVE_URL} every ${EVERY_MS / 1000} s`);
  run();
}

// A plain entry point, however it is started (through a link, a short path or another drive
// letter): what the tests need is in lib/live-snapshot.js.
main(process.argv.slice(2));

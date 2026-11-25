// The live mirror of the founder's operator dashboard (/live): a public, read-only copy of the
// founder's own proving run. That account is one of the team's own: it is never a member, and
// nothing here touches credits or payouts.
//
// The dashboard runs on the founder's machine, which is never reachable from outside. A small
// publisher there (tools/live-publisher.mjs, lib/live-snapshot.js) builds a sanitized snapshot
// every 30 seconds and posts it here, signed with an Ed25519 key. This side checks the signature
// over the exact bytes it received, the time the snapshot was made, and that it is newer than the
// last one. Then it keeps only the whitelisted fields below, each checked and cut to size, whatever
// was signed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const DEFAULT_REPO = 'open-goat/pequalnp-proofs';
// Largest snapshot accepted, as sent. A real one is about 45 KB; should one ever grow past this,
// the publisher shortens its lists until it fits.
export const MAX_BYTES = 128 * 1024;
export const LIMITS = Object.freeze({ accepted: 100, waiting: 150, activity: 40, top: 15, title: 160 });
const MAX_AGE_MS = 10 * 60 * 1000; // a snapshot made longer ago than this is refused
const MAX_AHEAD_MS = 2 * 60 * 1000; // clock drift allowed for a snapshot dated in the future

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A pull request on the official repository, and nothing else.
export const prPattern = (repo = DEFAULT_REPO) => new RegExp(`^https://github\\.com/${reEsc(repo)}/pull/[0-9]{1,9}$`);
// A step id as the official effort writes them (L-meta-5768, L-lib-12), so that no other text can
// travel as an id. lib/live-snapshot.js reads activity lines with the same rule.
export const STEP_ID = /^L-[A-Za-z]{1,16}-[0-9]{1,7}$/;
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes, base64
// A well-formed x-live-signature. The server refuses anything else before it reads the body.
export const looksSigned = (v) => typeof v === 'string' && SIGNATURE.test(v.trim());
const T_MIN = Date.UTC(2020, 0, 1);
const T_MAX = Date.UTC(2100, 0, 1);

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e9 ? v : null);

// An ISO 8601 time with a zone, as a normalised UTC string; null for anything else.
export function isoTime(v) {
  if (typeof v !== 'string' || v.length > 40 || !ISO.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= T_MIN && t <= T_MAX ? new Date(t).toISOString() : null;
}

// One line of plain text: no control, invisible or direction-changing characters, at most n
// characters (a longer text is cut and ends with an ellipsis).
const HIDDEN_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const hex = (c) => `\\u${c.toString(16).padStart(4, '0')}`;
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`, 'g');
export function textLine(v, n) {
  if (typeof v !== 'string') return '';
  const s = v.slice(0, n * 8).replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('').trimEnd()}…` : s;
}

// Text with no place on a public page, should the dashboard ever put some in a title: a local path,
// the run's or the key's folder, a key file, a GitHub token or a PEM block. Such a title is
// published empty (the step id and its pull request link still are).
const PRIVATE_TEXT = /[A-Za-z]:[\\/][\w .-]+[\\/]|[\\/]pnp[\\/]|\.valiant\b|\.pem\b|\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{6,}|-----BEGIN/i;
export function publicTitle(v) {
  const t = textLine(v, LIMITS.title);
  return PRIVATE_TEXT.test(t) || (typeof v === 'string' && PRIVATE_TEXT.test(v.slice(0, LIMITS.title * 8))) ? '' : t;
}

// At most `max` valid entries of a list, each rebuilt by f (null drops an entry).
function take(v, max, f) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) {
    if (out.length >= max) break;
    const y = plain(x) ? f(x) : null;
    if (y) out.push(y);
  }
  return out;
}

// The whitelist: only what /live shows. Every field is checked and cut to size; anything else, at
// any depth, is dropped. Used on every snapshot received, and by the publisher before it signs one.
export function cleanSnapshot(s, { repo = DEFAULT_REPO } = {}) {
  const src = plain(s) ? s : {};
  const PR = prPattern(repo);
  const pr = (u) => typeof u === 'string' && PR.test(u);
  const step = (v) => typeof v === 'string' && STEP_ID.test(v);
  const login = (v) => typeof v === 'string' && LOGIN.test(v);
  const c = plain(src.counts) ? src.counts : {};
  const r = plain(src.rank) ? src.rank : {};
  const b = plain(src.board) ? src.board : {};
  const e = plain(src.engine) ? src.engine : {};
  return {
    account: login(src.account) ? src.account : null,
    start: isoTime(src.start),
    end: isoTime(src.end),
    counts: { accepted: count(c.accepted), merging: count(c.merging), prs: count(c.prs), checking: count(c.checking) },
    rank: { hour: count(r.hour), all: count(r.all), ahead: count(r.ahead), steps_all: count(r.steps_all), steps_hour: count(r.steps_hour) },
    board: {
      agents: count(b.agents),
      top: take(b.top, LIMITS.top, (x) => (login(x.github) ? { github: x.github, steps: count(x.steps), hour: count(x.hour) } : null)),
    },
    accepted: take(src.accepted, LIMITS.accepted, (x) => {
      const state = x.state === 'merged' || x.state === 'accepted' ? x.state : null;
      if (!state || !step(x.id) || !pr(x.url)) return null;
      return { id: x.id, title: publicTitle(x.title), url: x.url, at: isoTime(x.at), merged_at: state === 'merged' ? isoTime(x.merged_at) : null, state };
    }),
    waiting: take(src.waiting, LIMITS.waiting, (x) => (step(x.id) && pr(x.url) ? { id: x.id, title: publicTitle(x.title), url: x.url, at: isoTime(x.at) } : null)),
    ready: count(src.ready),
    engine: { sentHour: count(e.sentHour) },
    activity: take(src.activity, LIMITS.activity, (x) => {
      const at = isoTime(x.at);
      return at && step(x.step) && pr(x.url) ? { at, step: x.step, url: x.url } : null;
    }),
  };
}

export function createLive({ dataDir, publicKey, repo = DEFAULT_REPO, log = console }) {
  // There is no built-in key. Without one (LIVE_PUBKEY empty or "off") the mirror is off: it
  // accepts no snapshot and shows none, not even one saved earlier.
  const given = String(publicKey || '').trim();
  let key = null;
  if (given && given.toLowerCase() !== 'off') {
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(given, 'base64'), format: 'der', type: 'spki' });
      if (k.asymmetricKeyType === 'ed25519') key = k;
    } catch {
      /* reported just below */
    }
    if (!key) log.error('[live] LIVE_PUBKEY is not an Ed25519 public key (base64 of its SPKI DER): no snapshot is accepted until it is fixed');
  }
  // Which key a saved snapshot was accepted with: after the key changes (a revoked key), what the
  // old key signed is never shown again.
  const keyId = key ? crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16) : null;

  const file = path.join(dataDir, 'live.json');
  // The public answer is the same bytes until the next snapshot: compressed once, with an ETag.
  const pack = (body) => ({ body: Buffer.from(body), gzip: zlib.gzipSync(body), etag: `W/"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22)}"` });
  const none = pack(`{"at":null,"configured":${!!key}}`);
  let cur = null; // the latest snapshot accepted: { at, ms, json, body, gzip, etag }
  const keep = (at, snapshot) => {
    const json = JSON.stringify(snapshot);
    cur = { at, ms: Date.parse(at), json, ...pack(`{"at":${JSON.stringify(at)},"snapshot":${json}}`) };
  };

  // The last snapshot survives a restart, and so does the replay check, as long as the key is the same.
  if (key) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = isoTime(saved?.at);
      if (at && plain(saved.snapshot) && saved.key === keyId) keep(at, cleanSnapshot(saved.snapshot, { repo }));
    } catch (e) {
      if (e?.code !== 'ENOENT') log.error(`[live] ${file} is unreadable (${e.message}): starting without a snapshot`);
    }
  }

  // Written whole to a temporary file, then renamed over the old one.
  function save() {
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, `{"v":1,"at":${JSON.stringify(cur.at)},"key":${JSON.stringify(keyId)},"saved_at":${JSON.stringify(new Date().toISOString())},"snapshot":${cur.json}}`);
      fs.renameSync(tmp, file);
    } catch (e) {
      log.error(`[live] could not save ${file}: ${e.message}`);
    }
  }

  const answer = (status, error) => ({ status, body: { ok: false, error } });

  // raw: the request body exactly as received (a Buffer); signature: the x-live-signature header.
  function ingest(raw, signature, now = Date.now()) {
    if (!key) return answer(503, 'the live mirror is not configured on this server');
    let good = false;
    if (looksSigned(signature)) {
      try { good = crypto.verify(null, raw, key, Buffer.from(signature.trim(), 'base64')); } catch { good = false; }
    }
    if (!good) return answer(401, 'missing or invalid x-live-signature');
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return answer(400, 'the body is not valid JSON'); }
    if (!plain(msg) || msg.v !== 1 || typeof msg.at !== 'string' || !plain(msg.snapshot)) return answer(400, 'expected {"v":1,"at":"<ISO time>","snapshot":{...}}');
    const at = isoTime(msg.at);
    if (!at) return answer(400, '"at" must be an ISO 8601 time');
    const t = Date.parse(at);
    if (now - t > MAX_AGE_MS) return answer(400, 'the snapshot is more than 10 minutes old');
    if (t - now > MAX_AHEAD_MS) return answer(400, "the snapshot is dated in the future: check the publisher's clock");
    if (cur && t <= cur.ms) return answer(409, 'the snapshot is not newer than the last one accepted');
    keep(at, cleanSnapshot(msg.snapshot, { repo }));
    save();
    return { status: 200, body: { ok: true, at } };
  }

  // The public answer: { body, gzip, etag } of {"at","snapshot"} (or {"at":null,"configured"} before
  // the first snapshot), the same until the next one, and the snapshot's age in seconds, given apart.
  function view(now = Date.now()) {
    if (!cur) return { ...none, age: null };
    return { body: cur.body, gzip: cur.gzip, etag: cur.etag, age: Math.max(0, Math.round((now - cur.ms) / 1000)) };
  }

  return { ingest, view, configured: !!key };
}

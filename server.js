// Valiant's Conjecture: the team's server.
//  - members register with a Solana wallet and get a private key for the API
//  - the desk relay hands official steps (taken under our GitHub handle) to their agents
//  - the PR bot opens every pull request from our account, so pequalnp.com credits us
//  - the ledger reads the official record and credits each accepted proof to the member who sent it
//  - the pay wallet sends SOL to members whenever it is funded
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { openStore } from './lib/store.js';
import { createPnp } from './lib/pnp.js';
import { createDesk } from './lib/desk.js';
import { createGithub } from './lib/github.js';
import { createPayout } from './lib/payout.js';
import { checkLean } from './lib/leanrules.js';
import { isSolana, cleanName, newKey, hashKey, sha256, UserError } from './lib/verify.js';
import { fmtUnits } from './lib/units.js';
import { joinTxt, skillMd } from './lib/texts.js';

const store = openStore(config.dataDir);
const db = store.db;
db.keys ||= {}; // sha256(key) -> wallet
db.submissions ||= {}; // id -> { id, wallet, aid, gap_id, path, module, sha256, at, pr, verdict, ... }
db.unattributed ||= {}; // lemma id -> credit (accepted under our handle, no matching submission)
const pnp = createPnp();
const desk = createDesk({ config, db, store });
const github = createGithub({ config });
const URL_ = config.publicUrl;
const OUR = () => (config.github.handle || '').toLowerCase();
// The team on the official record: the current account, then any former ones
// (PNP_FORMER_HANDLES), so a change of account never drops proofs already accepted.
const OURS = () => (OUR() ? [...new Set([OUR(), ...config.github.formerHandles])] : []);
const ourRecord = () => {
  const entries = OURS().map((h) => pnp.state.byHandle.get(h)).filter(Boolean);
  return { steps: entries.reduce((a, e) => a + (e.steps || 0), 0), lemmas: entries.flatMap((e) => e.lemmas || []) };
};
const ACTIVE_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '');

// ---------------------------------------------------------------- admin token
let ADMIN = config.adminToken;
if (!ADMIN) {
  const f = path.join(config.dataDir, 'admin-token.txt');
  if (fs.existsSync(f)) ADMIN = fs.readFileSync(f, 'utf8').trim();
  else {
    ADMIN = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(f, `${ADMIN}\n`);
  }
  console.log(`[admin] dashboard password is in ${f}`);
}
const isAdmin = (req) => {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

// ---------------------------------------------------------------- ledger
const weightOf = (c) => config.rewards.weights[c.kind] ?? config.rewards.weights.default ?? 1;
const normPr = (u) => {
  const m = String(u || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  return m ? `${m[1].toLowerCase()}#${m[2]}` : null;
};

function creditIndex() {
  const idx = new Map();
  for (const [w, bucket] of Object.entries(db.credits)) for (const id of Object.keys(bucket)) idx.set(id, w);
  for (const id of Object.keys(db.unattributed)) idx.set(id, null);
  return idx;
}

// Every lemma the official record credits to our handle is matched to the
// submission whose pull request it came from, and credited to that member.
let ingesting = false;
async function ingest() {
  const c = pnp.state.contributors;
  if (!c || !OUR() || ingesting) return;
  ingesting = true;
  try {
    const { lemmas } = ourRecord();
    const seen = new Set(lemmas.map((l) => l.id));
    const known = creditIndex();
    const byPr = new Map(Object.values(db.submissions).filter((s) => s.pr).map((s) => [normPr(s.pr.url), s]));
    let fetched = 0;
    let changed = false;
    for (const l of lemmas) {
      if (known.has(l.id)) {
        const w = known.get(l.id);
        const cr = w ? db.credits[w][l.id] : db.unattributed[l.id];
        if (cr?.revoked) { delete cr.revoked; changed = true; }
        continue;
      }
      if (fetched >= 20) break; // the rest next cycle: be gentle with the export
      fetched++;
      let meta;
      try { meta = await pnp.lemma(l.id, l.ref); } catch { continue; }
      const credit = { id: l.id, ref: l.ref, title: l.title, at: l.at, kind: meta.kind || 'unknown', program: meta.program || null, pr_url: meta.contributor?.pr_url || null };
      let s = byPr.get(normPr(credit.pr_url));
      if (!s && meta.artifact?.content_hash) {
        s = Object.values(db.submissions).find((x) => x.pr && x.path === meta.artifact.lean_file && meta.artifact.content_hash === `sha256:${x.sha256}`);
      }
      if (s && db.members[s.wallet]) {
        (db.credits[s.wallet] ||= {})[l.id] = { ...credit, submission: s.id };
        Object.assign(s, { accepted: true, lemma_id: l.id, verdict: 'ACCEPTED' });
      } else {
        db.unattributed[l.id] = credit;
      }
      changed = true;
    }
    if ((c.contributors || []).length) {
      // A step that leaves the official record stops counting (unless already paid).
      const all = [...Object.values(db.credits).flatMap((b) => Object.values(b)), ...Object.values(db.unattributed)];
      for (const cr of all) if (!seen.has(cr.id) && !cr.revoked) { cr.revoked = nowIso(); changed = true; }
    }
    if (changed) { store.save(); stateCache = null; }
  } finally {
    ingesting = false;
  }
}

// The official checker's verdict on each open pull request.
async function pollVerdicts() {
  if (!github.configured()) return;
  const open = Object.values(db.submissions)
    .filter((s) => s.pr && !s.final && Date.now() - Date.parse(s.at) < 4 * DAY_MS)
    .sort((a, b) => String(a.checked_at || '').localeCompare(String(b.checked_at || '')))
    .slice(0, 15);
  for (const s of open) {
    try {
      const v = await github.verdict(s.pr.number);
      if (!s.accepted) s.verdict = v.verdict;
      Object.assign(s, { verdict_url: v.verdict_url, merged: v.merged, pr_state: v.state, checked_at: nowIso() });
      if (v.merged || v.state === 'closed') s.final = true;
      delete s.check_error;
    } catch (e) {
      s.check_error = e.message;
      s.checked_at = nowIso();
    }
  }
  if (open.length) store.save();
}

function memberView(w) {
  const m = db.members[w];
  const t = Date.now();
  let steps = 0, weight = 0, day = 0, last = null;
  for (const c of Object.values(db.credits[w] || {})) {
    if (c.revoked) continue;
    steps++;
    weight += weightOf(c);
    if (t - Date.parse(c.at) < DAY_MS) day++;
    if (!last || c.at > last) last = c.at;
  }
  const live = Object.values(db.assignments || {}).filter((a) => a.wallet === w && a.status === 'active' && t - Date.parse(a.last_seen) < ACTIVE_MS);
  const paid = db.payments ? db.payments.filter((p) => p.wallet === w).reduce((a, p) => a + BigInt(p.lamports), 0n) : 0n;
  return {
    wallet: w,
    name: m.name || null,
    display: m.name || short(w),
    joined_at: m.created_at,
    steps,
    weight,
    steps_24h: day,
    last_proof_at: last,
    active: live.length > 0,
    working_on: live[0] ? db.leases[live[0].lease]?.gap?.id ?? null : null,
    owed: fmtUnits(payout.owedOf(w), 9),
    paid: fmtUnits(paid, 9),
  };
}

// Split `lamports` across every accepted step not yet allocated, by weight.
function allocate(lamports) {
  const rows = [];
  let total = 0;
  let from = null, to = null;
  for (const [w, m] of Object.entries(db.members)) {
    if (m.banned) continue;
    let steps = 0, weight = 0;
    const ids = [];
    for (const c of Object.values(db.credits[w] || {})) {
      if (c.revoked || c.alloc) continue;
      steps++;
      weight += weightOf(c);
      ids.push(c.id);
      if (!from || c.at < from) from = c.at;
      if (!to || c.at > to) to = c.at;
    }
    if (steps) { rows.push({ wallet: w, name: m.name || null, steps, weight, lemmas: ids }); total += weight; }
  }
  if (!rows.length) return null;
  const scale = 1000;
  const totalS = BigInt(Math.round(total * scale));
  let dist = 0n;
  rows.sort((a, b) => b.weight - a.weight);
  for (const r of rows) {
    const u = (BigInt(lamports) * BigInt(Math.round(r.weight * scale))) / totalS;
    dist += u;
    Object.assign(r, { share: r.weight / total, lamports: u.toString(), amount: fmtUnits(u, 9) });
  }
  const next = db.epochs.reduce((n, x) => Math.max(n, +String(x.id).slice(1) || 0), 0) + 1;
  const epoch = { id: `E${String(next).padStart(4, '0')}`, created_at: nowIso(), from, to, unit: 'SOL', pool: fmtUnits(lamports, 9), total_weight: total, distributed: fmtUnits(dist, 9), dust: fmtUnits(BigInt(lamports) - dist, 9), rows };
  for (const r of rows) for (const id of r.lemmas) db.credits[r.wallet][id].alloc = epoch.id;
  db.epochs.push(epoch);
  stateCache = null;
  return epoch;
}

const payout = createPayout({ config, db, store, allocate, isPayable: (w) => !!db.members[w] && !db.members[w].banned });

// ---------------------------------------------------------------- public views
let stateCache = null;
let stateAt = 0;
function publicState() {
  if (stateCache && Date.now() - stateAt < 4000) return stateCache;
  const s = pnp.state;
  const h = s.head || {};
  const views = Object.entries(db.members).filter(([, m]) => !m.banned).map(([w]) => memberView(w));
  const entry = ourRecord();
  const ourSteps = entry.steps;
  const outsideSteps = h.outside?.steps || s.contributors?.steps || 0;
  const ps = payout.status();
  stateCache = {
    project: config.project,
    url: URL_,
    handle: config.github.handle || null,
    pay_wallet: ps.address,
    cluster: ps.cluster,
    rewards: { split: config.rewards.split, min_payout: config.payout.minPayout, interval_minutes: config.payout.intervalMinutes },
    official: {
      generated_at: h.generated_at || null,
      counters: h.counters || {},
      outside: { count: h.outside?.count || 0, steps: outsideSteps },
      agents_now: h.agents_now_total ?? null,
      agents_fleet: h.agents_now_fleet ?? null,
      agents_public: h.agents_now_public ?? null,
    },
    team: {
      members: views.length,
      steps: ourSteps,
      attributed: views.reduce((a, v) => a + v.steps, 0),
      steps_24h: views.reduce((a, v) => a + v.steps_24h, 0),
      active_now: views.filter((v) => v.active).length,
      share: outsideSteps ? ourSteps / outsideSteps : 0,
      paid: ps.paid_total,
      owed: ps.owed_total,
    },
    board: views
      .filter((v) => v.steps > 0 || v.active)
      .sort((a, b) => b.steps - a.steps || String(b.last_proof_at).localeCompare(String(a.last_proof_at)))
      .slice(0, 100),
    programs: (s.map?.programs || []).map((p) => ({ key: p.key, title: p.title, status: p.status })),
    team_lemmas: entry.lemmas.map((l) => l.id),
    feed: (s.feed || []).slice(0, 40).map((e) => {
      const by = e.lemma_id ? s.byLemma.get(e.lemma_id) : null;
      return { seq: e.seq, at: e.at, kind: e.kind, lemma_id: e.lemma_id || null, by: by || null, team: !!by && OURS().includes(by.toLowerCase()) };
    }),
    sync: { ok: s.lastOk, err: s.lastErr },
  };
  stateAt = Date.now();
  return stateCache;
}

function memberPublic(w) {
  const m = db.members[w];
  if (!m || m.banned) return { member: false, wallet: w };
  const credits = Object.values(db.credits[w] || {})
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((c) => ({ id: c.id, title: c.title, at: c.at, kind: c.kind, pr_url: c.pr_url, paid_in: c.alloc || null, revoked: !!c.revoked }));
  const payments = (db.payments || []).filter((p) => p.wallet === w).slice(-50).reverse().map((p) => ({ amount: p.amount, at: p.at, sig: p.sig, url: payout.explorer(p.sig) }));
  const submissions = Object.values(db.submissions)
    .filter((s) => s.wallet === w)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20)
    .map((s) => ({ gap: s.gap_id, at: s.at, pr: s.pr?.url || null, verdict: s.verdict || 'pending' }));
  return { member: true, ...memberView(w), credits, payments, submissions };
}

// ---------------------------------------------------------------- http helpers
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'content-type': type,
    'content-length': buf.length,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': CSP,
    'cache-control': 'no-cache',
    ...extra,
  });
  res.end(buf);
}
const json = (res, status, obj) => send(res, status, obj);
const text = (res, status, s, type = 'text/plain; charset=utf-8') => send(res, status, s, type, { 'access-control-allow-origin': '*' });

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new UserError(`body over ${Math.round(limit / 1024)} KB`)); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readBody(req, limit = 16 * 1024) {
  const raw = await readRaw(req, limit);
  if (!raw) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { throw new UserError('body is not valid JSON'); }
}

const buckets = new Map();
function limited(key, max, perMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > perMs) buckets.set(key, (b = { t: now, n: 0 }));
  return ++b.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.t > 10 * 60 * 1000) buckets.delete(k);
}, 60 * 1000).unref();

const ipOf = (req) => (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

function serveFile(res, rel) {
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    // Pages carry absolute links for share cards (og:image needs a full URL).
    const body = ext === '.html' ? Buffer.from(buf.toString('utf8').replaceAll('%PUBLIC_URL%', URL_)) : buf;
    send(res, 200, body, MIME[ext] || 'application/octet-stream', ext === '.png' || ext === '.svg' ? { 'cache-control': 'public, max-age=86400' } : {});
  });
}

function memberFromKey(req) {
  const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!k) return null;
  const w = db.keys[hashKey(k)];
  const m = w && db.members[w];
  return m && !m.banned ? m : null;
}

const safeBranch = (id) => String(id || 'step').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'step';
const safePath = (p) => typeof p === 'string' && /^[A-Za-z0-9_./-]+\.lean$/.test(p) && !p.split('/').includes('..') && !p.startsWith('/');

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  const ip = ipOf(req);
  const M = req.method;
  let m;

  // ---- agent-facing texts
  if (p === '/join.txt') return text(res, 200, joinTxt());
  if (p === '/skill.md' || p === '/SKILL.md') return text(res, 200, skillMd(), 'text/markdown; charset=utf-8');

  // ---- public API
  if (p === '/api/health') return json(res, 200, { ok: true, sync: pnp.state.lastOk, err: pnp.state.lastErr });
  if (p === '/api/state' && M === 'GET') return json(res, 200, publicState());
  // Live badges for the README (shields.io "endpoint" format).
  if ((m = p.match(/^\/api\/badge\/([a-z-]+)$/)) && M === 'GET') {
    const s = publicState();
    const n = (v) => Number(v || 0).toLocaleString('en-US');
    const b = {
      proven: ['lemmas proven', n(s.official.counters.checked)],
      agents: ['agents online', n(s.official.agents_now)],
      team: ['team proofs', n(s.team.steps)],
      members: ['members', n(s.team.members)],
      paid: ['paid out', `${Number(s.team.paid || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })} SOL`],
    }[m[1]];
    if (!b) return json(res, 404, { error: 'no such badge' });
    return send(res, 200, { schemaVersion: 1, label: b[0], message: b[1], color: 'ff3b00', labelColor: '111111', cacheSeconds: 300 }, 'application/json; charset=utf-8', {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    });
  }
  if ((m = p.match(/^\/api\/member\/([^/]+)$/)) && M === 'GET') {
    const w = decodeURIComponent(m[1]);
    if (!isSolana(w)) return json(res, 400, { error: 'not a Solana address' });
    return json(res, 200, memberPublic(w));
  }

  if (p === '/api/register' && M === 'POST') {
    if (limited(`rg:${ip}`, 10, 60_000)) return json(res, 429, { ok: false, error: 'slow down: retry in a minute' });
    const body = await readBody(req);
    const wallet = String(q.wallet || body.wallet || '').trim();
    if (!isSolana(wallet)) throw new UserError('wallet must be a Solana address (base58, 32 to 44 characters)');
    if (db.members[wallet]?.banned) return json(res, 403, { ok: false, error: 'this wallet is not eligible' });
    const fresh = !db.members[wallet];
    if (fresh) db.members[wallet] = { wallet, name: cleanName(q.name || body.name || ''), created_at: nowIso(), banned: false, note: '', keys: 0 };
    const key = newKey(config.project.slug);
    db.keys[hashKey(key)] = wallet;
    db.members[wallet].keys = (db.members[wallet].keys || 0) + 1;
    store.save();
    stateCache = null;
    return json(res, 200, {
      ok: true,
      wallet,
      name: db.members[wallet].name,
      key,
      new_member: fresh,
      page: `${URL_}/m/${wallet}`,
      next: `Save the key. Then follow ${URL_}/join.txt from STEP 2.`,
    });
  }

  if (p.startsWith('/api/desk/') || p === '/api/submit' || p.startsWith('/api/submission/') || p === '/api/me') {
    const mem = memberFromKey(req);
    if (!mem) return json(res, 401, { ok: false, error: `send your key as "Authorization: Bearer <key>" (register: ${URL_}/join.txt)` });
    return agentApi(req, res, p, q, M, mem);
  }

  // ---- internal dashboard API
  if (p.startsWith('/api/admin/')) {
    if (limited(`ad:${ip}`, 120, 60_000)) return json(res, 429, { error: 'slow down' });
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    return admin(req, res, p, M);
  }

  // ---- pages
  if (M !== 'GET' && M !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  if (p === '/' || p === '/index.html') return serveFile(res, 'index.html');
  if (/^\/m\/[^/]+\/?$/.test(p)) return serveFile(res, 'member.html');
  if (p === '/admin' || p === '/admin/') return serveFile(res, 'admin.html');
  return serveFile(res, p.slice(1));
}

async function agentApi(req, res, p, q, M, mem) {
  const w = mem.wallet;
  let m;
  if (p === '/api/me' && M === 'GET') {
    const mine = Object.values(db.assignments || {}).filter((a) => a.wallet === w && a.status === 'active').map((a) => ({ assignment: a.id, gap: a.gap_id }));
    return json(res, 200, { ok: true, ...memberPublic(w), assignments: mine });
  }

  if (p === '/api/desk/next' && M === 'GET') {
    if (limited(`nx:${w}`, 20, 60_000)) return json(res, 429, { ok: false, error: 'one request every few seconds at most' });
    // Never take a step from the official desk that we could not submit.
    if (!github.configured()) return json(res, 503, { ok: false, gap: null, error: 'the team is not open for proofs yet: you are registered, try again later' });
    const r = await desk.next(w, { hard: q.hard === '1', another: q.another === '1' });
    return json(res, 200, { ok: true, ...r });
  }
  if (p === '/api/desk/beat' && M === 'POST') {
    if (limited(`bt:${w}`, 12, 60_000)) return json(res, 429, { ok: false, error: 'renew every 10 minutes' });
    const r = desk.beat(String(q.assignment || ''), w);
    return json(res, r.status, r.body);
  }
  if (p === '/api/desk/release' && M === 'POST') {
    const r = await desk.release(String(q.assignment || ''), w, String(q.reason || ''), q.program ? String(q.program) : null);
    return json(res, r.status, r.body);
  }

  if (p === '/api/submit' && M === 'POST') {
    if (limited(`sb:${w}`, 6, 60_000)) return json(res, 429, { ok: false, error: 'slow down: at most a few submissions a minute' });
    const a = desk.get(String(q.assignment || ''), w);
    if (!a) return json(res, 404, { ok: false, error: 'no such assignment' });
    const gap = db.leases[a.lease]?.gap;
    if (!gap) return json(res, 410, { ok: false, error: 'this step is no longer known: take a new one' });
    let file = await readRaw(req, 200 * 1024);
    if (/^\s*\{/.test(file)) { try { file = JSON.parse(file).file || ''; } catch { /* plain text that starts with { */ } }
    file = file.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
    const chk = checkLean(file, gap);
    if (!chk.ok) return json(res, 422, { ok: false, errors: chk.errors, warnings: chk.warnings });
    if (!safePath(gap.file)) return json(res, 500, { ok: false, error: 'the step has an unexpected file path' });
    if (!github.configured()) return json(res, 503, { ok: false, error: 'the server cannot open pull requests yet (GITHUB_TOKEN / PNP_HANDLE)' });

    const existing = Object.values(db.submissions).find((s) => s.aid === a.id && s.pr);
    if (existing) {
      if (existing.final || existing.accepted) return json(res, 409, { ok: false, error: 'this pull request is closed or already accepted: take a new step' });
      await github.updateFile({ branch: existing.pr.branch, path: gap.file, content: file, title: String(gap.id) });
      Object.assign(existing, { sha256: sha256(file), updated_at: nowIso(), verdict: null, resubmits: (existing.resubmits || 0) + 1 });
      store.save();
      return json(res, 200, { ok: true, submission: existing.id, pr: existing.pr.url, updated: true, warnings: chk.warnings });
    }
    if (a.status !== 'active') return json(res, 410, { ok: false, error: 'this step was settled or withdrawn: take a new one' });
    if (!(await desk.beforeSubmit(a))) return json(res, 410, { ok: false, error: 'another agent proved this step first: take a new one' });
    let pr;
    try {
      pr = await github.openPr({ branch: safeBranch(gap.id), path: gap.file, content: file, title: String(gap.id) });
    } catch (e) {
      console.error('[pr]', e.message);
      return json(res, 502, { ok: false, error: `could not open the pull request (${e.message}); your step is still held: send again in a minute` });
    }
    const s = { id: `s_${crypto.randomBytes(8).toString('base64url')}`, wallet: w, aid: a.id, gap_id: gap.id ?? null, path: gap.file, module: gap.module ?? null, sha256: sha256(file), size: file.length, at: nowIso(), pr, verdict: null };
    db.submissions[s.id] = s;
    await desk.afterSubmit(a);
    store.save();
    stateCache = null;
    return json(res, 200, { ok: true, submission: s.id, pr: pr.url, warnings: chk.warnings, next: 'Take the next step now. Check the verdict later.' });
  }

  if ((m = p.match(/^\/api\/submission\/([^/]+)$/)) && M === 'GET') {
    const s = db.submissions[m[1]];
    if (!s || s.wallet !== w) return json(res, 404, { ok: false, error: 'no such submission' });
    return json(res, 200, { ok: true, submission: s.id, assignment: s.aid, gap: s.gap_id, pr: s.pr?.url, verdict: s.verdict || 'pending', verdict_url: s.verdict_url || null, merged: !!s.merged, accepted: !!s.accepted, lemma: s.lemma_id || null });
  }
  return json(res, 404, { ok: false, error: 'not found' });
}

async function admin(req, res, p, M) {
  let m;
  if (p === '/api/admin/overview' && M === 'GET') {
    const members = Object.keys(db.members).map((w) => {
      const v = memberView(w);
      const mem = db.members[w];
      const unalloc = Object.values(db.credits[w] || {}).filter((c) => !c.revoked && !c.alloc).length;
      return { ...v, banned: !!mem.banned, note: mem.note || '', keys: mem.keys || 0, unallocated: unalloc, held: (db.payout?.hold || []).includes(w) };
    });
    members.sort((a, b) => b.steps - a.steps || String(b.joined_at).localeCompare(String(a.joined_at)));
    const subs = Object.values(db.submissions).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60)
      .map((s) => ({ id: s.id, wallet: s.wallet, gap: s.gap_id, at: s.at, pr: s.pr?.url, verdict: s.verdict || 'pending', accepted: !!s.accepted, resubmits: s.resubmits || 0, error: s.check_error || null }));
    return json(res, 200, {
      project: config.project,
      handle: config.github.handle || null,
      github_ready: github.configured(),
      members,
      submissions: subs,
      unattributed: Object.values(db.unattributed).sort((a, b) => b.at.localeCompare(a.at)),
      epochs: db.epochs.slice(-50).reverse().map(({ rows, ...e }) => ({ ...e, recipients: rows.length })),
      payout: { ...payout.status(), balance_now: await payout.liveBalance() },
      desk: desk.status(),
      rewards: config.rewards,
      sync: { ok: pnp.state.lastOk, err: pnp.state.lastErr, files: pnp.state.files },
      official: { outside: pnp.state.head?.outside || null, ours: ourRecord().steps },
    });
  }

  if ((m = p.match(/^\/api\/admin\/member\/([^/]+)$/))) {
    const w = decodeURIComponent(m[1]);
    const mem = db.members[w];
    if (!mem) return json(res, 404, { error: 'no such member' });
    if (M === 'GET') {
      return json(res, 200, {
        ...memberView(w),
        ...mem,
        credits: Object.values(db.credits[w] || {}).sort((a, b) => b.at.localeCompare(a.at)).map((c) => ({ ...c, weight: weightOf(c) })),
        payments: (db.payments || []).filter((x) => x.wallet === w).reverse().map((x) => ({ ...x, url: payout.explorer(x.sig) })),
        submissions: Object.values(db.submissions).filter((s) => s.wallet === w).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
      });
    }
    if (M === 'POST') {
      const b = await readBody(req);
      if (typeof b.banned === 'boolean') mem.banned = b.banned;
      if (typeof b.note === 'string') mem.note = b.note.slice(0, 500);
      if (typeof b.name === 'string') mem.name = cleanName(b.name);
      if (b.clear_hold) payout.clearHold(w);
      store.save();
      stateCache = null;
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/attribute' && M === 'POST') {
    const b = await readBody(req);
    const cr = db.unattributed[b.lemma];
    if (!cr) throw new UserError('no such unattributed lemma');
    if (!db.members[b.wallet]) throw new UserError('no such member');
    (db.credits[b.wallet] ||= {})[cr.id] = { ...cr, attributed_by: 'admin' };
    delete db.unattributed[b.lemma];
    store.save();
    stateCache = null;
    return json(res, 200, { ok: true });
  }

  if (p === '/api/admin/payout/run' && M === 'POST') return json(res, 200, await payout.tick({ manual: true }));
  if (p === '/api/admin/payout/pause' && M === 'POST') {
    const b = await readBody(req);
    db.payout.paused = !!b.paused;
    store.save();
    return json(res, 200, { ok: true, paused: db.payout.paused });
  }

  if ((m = p.match(/^\/api\/admin\/epoch\/(E\d+)\/csv$/)) && M === 'GET') {
    const e = db.epochs.find((x) => x.id === m[1]);
    if (!e) return json(res, 404, { error: 'no such allocation' });
    const rows = ['wallet,amount_sol,steps,weight,name', ...e.rows.map((r) => `${r.wallet},${r.amount},${r.steps},${r.weight},${r.name || ''}`)];
    return send(res, 200, `${rows.join('\n')}\n`, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${config.project.slug}-${e.id}.csv"` });
  }

  if (p === '/api/admin/sync' && M === 'POST') {
    await tick();
    await pollVerdicts();
    return json(res, 200, { ok: !!pnp.state.lastOk, sync: pnp.state.lastOk, err: pnp.state.lastErr });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- boot
async function tick() {
  const ok = await pnp.sync();
  if (ok) await ingest();
  stateCache = null;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof UserError) return json(res, 400, { ok: false, error: e.message });
    console.error('[http]', req.method, req.url, e);
    json(res, 500, { ok: false, error: 'server error' });
  });
});

server.listen(config.port, () => {
  console.log(`[${config.project.name}] listening on ${URL_} (port ${config.port})`);
  console.log(`  site       ${URL_}/`);
  console.log(`  agents     ${URL_}/join.txt   ${URL_}/skill.md`);
  console.log(`  dashboard  ${URL_}/admin`);
  console.log(`  handle     ${config.github.handle || '(not set: PNP_HANDLE)'}   pull requests ${github.configured() ? 'ready' : 'NOT configured (GITHUB_TOKEN)'}`);
  console.log(`  pay wallet ${payout.address() || '(none: npm run wallet)'}   auto-pay ${config.payout.enabled ? 'ON' : 'OFF'}`);
});
tick();
setInterval(tick, config.pnp.syncSeconds * 1000);
setInterval(() => desk.maintain(), 60 * 1000);
setInterval(() => pollVerdicts().catch(() => {}), 2 * 60 * 1000);
payout.schedule();

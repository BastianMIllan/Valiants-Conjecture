// Valiant's Conjecture: the team's server.
//  - members link their own GitHub account to a Solana wallet with a public gist
//  - they contribute to pequalnp.com with that account, the official way: their pull
//    requests and their points are theirs on the official board
//  - the ledger reads the official public record and credits each proof it lists for a
//    member's GitHub account after the moment they joined, once
//  - the team treasury pays those proofs in SOL
// The team's own GitHub accounts are never members: the team's own proving stays separate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { openStore } from './lib/store.js';
import { createPnp } from './lib/pnp.js';
import { createGithub } from './lib/github.js';
import { createPayout } from './lib/payout.js';
import { isSolana, isGithubLogin, normLogin, UserError } from './lib/verify.js';
import { fmtUnits } from './lib/units.js';
import { joinTxt, skillMd, gistLine, gistCommand, registerCommand } from './lib/texts.js';
import { createLive, looksSigned, MAX_BYTES as LIVE_MAX_BYTES } from './lib/live.js';

const store = openStore(config.dataDir);
const db = store.db;
// Keyed by GitHub logins and lemma ids from outside: no inherited keys, so a login such as
// "constructor" is an ordinary key and never reaches Object.prototype.
db.members = Object.assign(Object.create(null), db.members); // lower(github) -> member
db.credits = Object.assign(Object.create(null), db.credits); // lemma id -> credit
db.registrations ||= []; // recent sign-ups and wallet changes, for the dashboard
const pnp = createPnp({ config });
const gh = createGithub({ config });
const URL_ = config.publicUrl;
const REPO = config.pnp.repo;
// The founder's run, mirrored from the operator dashboard (/live). It never touches the ledger.
const live = createLive({ dataDir: config.dataDir, publicKey: config.live.publicKey, repo: REPO });
// Live snapshots being received right now, by address. The publisher sends one small snapshot
// every 30 seconds, read in milliseconds: one at a time per address, a few in all, and a deadline
// keep slow or abandoned uploads from holding the server's memory.
const liveUploads = new Set();
const LIVE_UPLOADS_MAX = 8;
const LIVE_READ_MS = 10_000;
// GET /api/live per address per minute: the page asks every 20 seconds.
const LIVE_READS_PER_MINUTE = 60;
const TEAM = new Set([config.github.handle, ...config.github.formerHandles].map((h) => String(h || '').toLowerCase()).filter(Boolean));
const isTeam = (login) => TEAM.has(String(login || '').toLowerCase());
const DAY_MS = 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '');
const avatarOf = (login) => `https://github.com/${encodeURIComponent(login)}.png?size=80`;

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

// ---------------------------------------------------------------- members
// One GitHub account is one member. A wallet belongs to one member for good: the
// current one and every earlier one stay theirs, so payment history never mixes.
const walletsOf = (m) => [...new Set([...(m.wallets || []).map((x) => x.wallet), m.wallet].filter(Boolean))];
function walletOwner(w) {
  for (const [k, m] of Object.entries(db.members)) if (m.wallet === w || (m.wallets || []).some((x) => x.wallet === w)) return k;
  return null;
}
function currentOwner(w) {
  for (const [k, m] of Object.entries(db.members)) if (m.wallet === w) return k;
  return null;
}
// A wallet (current or earlier) or a GitHub username -> the member's key.
function resolveMember(id) {
  if (isSolana(id)) {
    const k = walletOwner(id);
    if (k) return k;
  }
  const login = normLogin(id).toLowerCase();
  return isGithubLogin(login) && db.members[login] ? login : null;
}

// A pull request on the official repository, from a number or an address.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PR_URL = new RegExp(`^https://github\\.com/${reEsc(REPO)}/pull/(\\d{1,9})/?$`, 'i');
function prUrl(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e8) return `https://github.com/${REPO}/pull/${v}`;
  const s = String(v ?? '').trim();
  if (/^#?\d{1,7}$/.test(s)) return `https://github.com/${REPO}/pull/${s.replace('#', '')}`;
  const m = s.match(PR_URL);
  return m ? `https://github.com/${REPO}/pull/${m[1]}` : null;
}

// ---------------------------------------------------------------- ledger
const W = config.rewards.weights;
const goodWeight = (v) => (v !== null && v !== '' && Number.isFinite(+v) && +v >= 0 ? +v : null);
// Own keys only: a kind such as "constructor" must never reach Object.prototype.
const weightOf = (c) => goodWeight(typeof c.kind === 'string' && Object.hasOwn(W, c.kind) ? W[c.kind] : undefined) ?? goodWeight(W.default) ?? 1;
const kindWeights = Object.keys(W).some((k) => k !== 'default');

// Every lemma the official record lists for a member's GitHub account, accepted at or
// after the moment they joined, becomes one credit. A lemma id is credited once, ever.
function ingest() {
  if (!pnp.state.contributors) return false;
  const byHandle = pnp.state.byHandle;
  const now = nowIso();
  let changed = false;
  for (const [key, m] of Object.entries(db.members)) {
    if (m.banned || isTeam(key)) continue;
    const e = byHandle.get(key);
    if (!e) continue;
    const since = Date.parse(m.joined_at);
    for (const l of e.lemmas) {
      if (!(Date.parse(l.at) >= since)) continue;
      const cur = db.credits[l.id];
      if (cur) {
        if (cur.login === key) {
          if (cur.revoked) { delete cur.revoked; changed = true; }
        } else if (cur.revoked && !cur.alloc) {
          // The record moved this proof to another member before it was paid.
          Object.assign(cur, { github: m.github, login: key, wallet: m.wallet, at: l.at, ref: l.ref, title: l.title, kind: null, pr_url: prUrl(l.ref), credited_at: now });
          for (const k of ['revoked', 'meta_at', 'meta_tries', 'program']) delete cur[k];
          changed = true;
        }
        continue;
      }
      db.credits[l.id] = { id: l.id, github: m.github, login: key, wallet: m.wallet, at: l.at, ref: l.ref, title: l.title, kind: null, pr_url: prUrl(l.ref), credited_at: now };
      changed = true;
    }
  }
  // A proof that leaves its member's record stops counting, unless it was already paid.
  if (pnp.state.contributors.count > 0) {
    for (const c of Object.values(db.credits)) {
      if (c.alloc || c.revoked) continue;
      if (!byHandle.get(c.login)?.ids.has(c.id)) { c.revoked = now; changed = true; }
    }
  }
  if (changed) { store.save(); stateCache = null; }
  return changed;
}

// Each credited lemma's own file in the record: its kind and the pull request it came from.
let enriching = false;
async function enrich(limit = 10) {
  if (enriching) return;
  enriching = true;
  let changed = false;
  try {
    const todo = Object.values(db.credits).filter((c) => !c.meta_at && !c.revoked).sort((a, b) => String(a.credited_at).localeCompare(String(b.credited_at))).slice(0, limit);
    for (const c of todo) {
      if (!c.ref) { c.meta_at = nowIso(); changed = true; continue; }
      let meta;
      try {
        meta = await pnp.lemma(c.id, c.ref);
      } catch {
        c.meta_tries = (c.meta_tries || 0) + 1;
        if (c.meta_tries >= 5) c.meta_at = nowIso(); // give up: the credit stands without it
        changed = true;
        continue;
      }
      if (meta && typeof meta === 'object') {
        if (typeof meta.kind === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(meta.kind)) c.kind = meta.kind;
        if (typeof meta.program === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(meta.program)) c.program = meta.program;
        const who = meta.contributor && typeof meta.contributor === 'object' ? meta.contributor : {};
        const pr = prUrl(who.pr_url);
        if (pr && (typeof who.github !== 'string' || who.github.toLowerCase() === c.login)) c.pr_url = pr;
      }
      c.meta_at = nowIso();
      changed = true;
    }
  } finally {
    enriching = false;
    if (changed) { store.save(); stateCache = null; }
  }
}

const newestFirst = (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

function indexes() {
  const credits = new Map(); // login -> [credit]
  for (const c of Object.values(db.credits)) {
    let a = credits.get(c.login);
    if (!a) credits.set(c.login, (a = []));
    a.push(c);
  }
  const paid = new Map(); // wallet -> lamports
  for (const p of db.payments || []) paid.set(p.wallet, (paid.get(p.wallet) || 0n) + BigInt(p.lamports));
  return { credits, paid };
}

function memberView(key, idx = indexes()) {
  const m = db.members[key];
  const t = Date.now();
  let steps = 0, weight = 0, day = 0, last = null, unallocated = 0;
  for (const c of idx.credits.get(key) || []) {
    if (c.revoked) continue;
    steps++;
    weight += weightOf(c);
    if (t - Date.parse(c.at) < DAY_MS) day++;
    if (!last || c.at > last) last = c.at;
    if (!c.alloc) unallocated++;
  }
  const paid = walletsOf(m).reduce((a, w) => a + (idx.paid.get(w) || 0n), 0n);
  const rec = pnp.state.byHandle.get(key);
  return {
    github: m.github,
    login: key,
    wallet: m.wallet,
    avatar: avatarOf(m.github),
    joined_at: m.joined_at,
    steps,
    weight,
    steps_24h: day,
    last_proof_at: last,
    active: day > 0,
    official_steps: rec ? rec.steps : 0,
    unallocated,
    owed: fmtUnits(payout.owedOf(m.wallet), 9),
    paid: fmtUnits(paid, 9),
  };
}

// Split `lamports` across every credited proof not yet allocated, by weight. Each
// member's share goes to their current wallet.
function allocate(lamports) {
  const byMember = new Map();
  let total = 0;
  let from = null, to = null;
  for (const c of Object.values(db.credits)) {
    if (c.revoked || c.alloc) continue;
    const m = db.members[c.login];
    if (!m || m.banned || isTeam(c.login)) continue;
    if (kindWeights && !c.meta_at) continue; // its kind is not known yet: next time
    const w = weightOf(c);
    let r = byMember.get(c.login);
    if (!r) byMember.set(c.login, (r = { wallet: m.wallet, github: m.github, steps: 0, weight: 0, lemmas: [] }));
    r.steps++;
    r.weight += w;
    r.lemmas.push(c.id);
    total += w;
    if (!from || c.at < from) from = c.at;
    if (!to || c.at > to) to = c.at;
  }
  const rows = [...byMember.values()];
  if (!rows.length || !(total > 0)) return null;
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
  for (const r of rows) for (const id of r.lemmas) db.credits[id].alloc = epoch.id;
  db.epochs.push(epoch);
  stateCache = null;
  return epoch;
}

// Version 1 members were wallets. What the treasury still owes such a wallet, if no member
// has taken it since, is paid to that same wallet, as version 1 would have, unless banned there.
function v1Payable(w) {
  const v1 = db.archive_v1?.members;
  return !!v1 && typeof v1 === 'object' && Object.hasOwn(v1, w) && !v1[w]?.banned && !walletOwner(w);
}

const payout = createPayout({
  config, db, store, allocate,
  isPayable: (w) => {
    const k = currentOwner(w);
    if (k) return !db.members[k].banned && !isTeam(k);
    return v1Payable(w);
  },
});

// A wallet the treasury already keeps books for (owed, paid, in a transfer, held) that no
// member owns: a version 1 balance. A gist proves a GitHub account, not a wallet, so nobody
// may adopt such a wallet: its balance and history would become theirs.
function hasBooks(w) {
  const p = db.payout || {};
  return payout.owedOf(w) > 0n
    || (db.payments || []).some((x) => x.wallet === w)
    || (db.batches || []).some((b) => b.items.some((it) => it.wallet === w))
    || (p.hold || []).includes(w) || (p.solo || []).includes(w) || Object.hasOwn(p.fails || {}, w);
}

// ---------------------------------------------------------------- registration
const verifying = new Set();
const noUser = new Map(); // lower(github) -> until when GitHub's "no such user" is remembered
const isRefusal = (r) => /^refused/.test(r.result);
function logRegistration(entry) {
  db.registrations.push({ at: nowIso(), ...entry });
  // Refused attempts make room first, so a burst of them never pushes real sign-ups out.
  const refused = db.registrations.filter(isRefusal);
  if (refused.length > 100) {
    const drop = new Set(refused.slice(0, refused.length - 100));
    db.registrations = db.registrations.filter((r) => !drop.has(r));
  }
  if (db.registrations.length > 300) db.registrations.splice(0, db.registrations.length - 300);
}

function regView(m) {
  return {
    github: m.github,
    wallet: m.wallet,
    joined_at: m.joined_at,
    gist: m.gist || null,
    page: `${URL_}/m/${m.wallet}`,
    next: `Read ${config.pnp.site}/join.txt and follow it with the GitHub account @${m.github}. Every proof the official board credits to @${m.github} from now on is paid in SOL to ${short(m.wallet)}.`,
  };
}

// Checks that need no GitHub call. null: go ahead and verify the gist.
function preCheck(key, github, wallet) {
  if (isTeam(key)) return { status: 403, body: { ok: false, error: `@${github} is one of the team's own accounts. It cannot join as a member.` } };
  const m = db.members[key];
  if (m?.banned) return { status: 403, body: { ok: false, error: 'This GitHub account is not eligible.' } };
  const owner = walletOwner(wallet);
  if (owner && owner !== key) return { status: 409, body: { ok: false, error: 'This wallet is already registered to another GitHub account. Use a different wallet.' } };
  if (!owner && hasBooks(wallet)) return { status: 409, body: { ok: false, error: 'This wallet already has a payout history with the team from before. Use a different wallet.' } };
  if (m && m.wallet === wallet) return { status: 200, body: { ok: true, ...regView(m), new_member: false, wallet_changed: false, already_registered: true } };
  return null;
}

// When a member last changed wallets (or joined): a new wallet needs a gist made after it.
function lastChange(m) {
  const times = [m.joined_at, ...(m.wallets || []).map((x) => x.at)].map((t) => Date.parse(t)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

async function register(github, wallet) {
  const key = github.toLowerCase();
  const pre = preCheck(key, github, wallet);
  if (pre) return pre;
  const unknownUntil = noUser.get(key);
  if (unknownUntil > Date.now()) return { status: 404, body: { ok: false, error: `GitHub has no user @${github}. Check the spelling of your GitHub username.` } };
  if (verifying.has(key)) return { status: 429, body: { ok: false, error: `A check for @${github} is already running. Try again in a moment.` } };
  verifying.add(key);
  const known = db.members[key];
  let v;
  try {
    v = await gh.verifyGist(github, wallet, { notBefore: known ? lastChange(known) : null });
  } finally {
    verifying.delete(key);
  }
  if (!v.ok) {
    if (v.status === 404) noUser.set(key, Date.now() + 5 * 60 * 1000);
    if (v.status === 422 || v.status === 404) {
      logRegistration({ github, wallet, result: v.status === 404 ? 'refused: no such GitHub user' : v.fresh ? 'refused: no gist since the last wallet change' : 'refused: no gist with the line' });
      store.save();
    }
    const body = { ok: false, error: v.error };
    if (v.status === 422) {
      Object.assign(body, {
        line: gistLine(wallet),
        command: { bash: gistCommand('sh', wallet), powershell: gistCommand('ps', wallet) },
        fix: v.fresh
          ? 'To change wallets, publish a new public gist on that GitHub account holding exactly that line (a gist from before your last wallet change does not count), then try again.'
          : 'Publish a public gist on that GitHub account holding exactly that line, then try again. A gist published a moment ago can take a minute to show.',
      });
    }
    return { status: v.status, body };
  }
  // Every account is known by GitHub's numeric id: a username can pass to someone else.
  if (!Number.isSafeInteger(v.githubId)) return { status: 502, body: { ok: false, error: 'GitHub did not say which account owns the gist. Try again in a few minutes.' } };
  // The ledger may have changed while GitHub answered.
  const again = preCheck(key, v.login, wallet);
  if (again) return again;
  const now = nowIso();
  let m = db.members[key];
  if (m && Number.isSafeInteger(m.github_id) && m.github_id !== v.githubId) {
    // The member renamed or deleted their account and someone else took the username.
    logRegistration({ github: v.login, wallet, result: 'refused: different GitHub account' });
    store.save();
    return { status: 409, body: { ok: false, error: `@${v.login} now belongs to a different GitHub account than the member who registered it. Contact the team.` } };
  }
  const fresh = !m;
  let moved = '0';
  if (fresh) {
    m = db.members[key] = { github: v.login, github_id: v.githubId, wallet, joined_at: now, gist: v.gist.url, wallets: [{ wallet, at: now, gist: v.gist.url }], banned: false, note: '' };
  } else {
    // A new wallet: future credits and everything not sent yet go to it. Paid history stays.
    const mv = payout.moveOwed(m.wallet, wallet);
    if (!mv.ok) return { status: 409, body: { ok: false, error: `Your wallet was not changed: ${mv.error}. Try again in a few minutes.` } };
    moved = mv.moved;
    (m.wallets ||= []).push({ wallet, at: now, gist: v.gist.url });
    Object.assign(m, { github: v.login, github_id: m.github_id ?? v.githubId, wallet, gist: v.gist.url });
  }
  logRegistration({ github: v.login, wallet, result: fresh ? 'joined' : 'wallet changed' });
  store.save();
  stateCache = null;
  return { status: 200, body: { ok: true, ...regView(m), new_member: fresh, wallet_changed: !fresh, moved_owed: moved } };
}

// ---------------------------------------------------------------- public views
let stateCache = null;
let stateAt = 0;
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);

function publicState() {
  if (stateCache && Date.now() - stateAt < 4000) return stateCache;
  const s = pnp.state;
  const h = s.head || {};
  const idx = indexes();
  const keys = Object.keys(db.members).filter((k) => !db.members[k].banned && !isTeam(k));
  const views = keys.map((k) => memberView(k, idx));
  const inTeam = new Set(keys);
  const ps = payout.status();
  stateCache = {
    project: config.project,
    url: URL_,
    pay_wallet: ps.address,
    cluster: ps.cluster,
    rewards: { split: config.rewards.split, min_payout: config.payout.minPayout, interval_minutes: config.payout.intervalMinutes },
    join: {
      gist_line: gistLine(),
      gist_sh: gistCommand('sh'),
      gist_ps: gistCommand('ps'),
      register_sh: registerCommand('sh'),
      register_ps: registerCommand('ps'),
      official_join: `${config.pnp.site}/join.txt`,
    },
    official: {
      site: config.pnp.site,
      repo: REPO,
      generated_at: h.generated_at || null,
      counters: h.counters && typeof h.counters === 'object' ? h.counters : {},
      outside: { count: h.outside?.count || s.contributors?.count || 0, steps: h.outside?.steps || s.contributors?.steps || 0 },
      agents_now: h.agents_now_total ?? null,
      agents_fleet: h.agents_now_fleet ?? null,
      agents_public: h.agents_now_public ?? null,
    },
    team: {
      members: views.length,
      proofs: views.reduce((a, v) => a + v.steps, 0),
      proofs_24h: views.reduce((a, v) => a + v.steps_24h, 0),
      active_24h: views.filter((v) => v.active).length,
      paid: ps.paid_total,
      owed: ps.owed_total,
    },
    board: views
      .sort((a, b) => b.steps - a.steps || String(b.last_proof_at || '').localeCompare(String(a.last_proof_at || '')) || String(a.joined_at).localeCompare(String(b.joined_at)))
      .slice(0, 100)
      .map(({ weight, unallocated, ...v }) => v),
    programs: (Array.isArray(s.map?.programs) ? s.map.programs : [])
      .filter((p) => p && typeof p.key === 'string' && typeof p.status === 'string')
      .map((p) => ({ key: p.key, title: str(p.title) || p.key, status: p.status })),
    member_lemmas: Object.values(db.credits).filter((c) => !c.revoked && inTeam.has(c.login)).map((c) => c.id),
    feed: (s.feed || []).slice(0, 40).map((e) => {
      const lemma = str(e.lemma_id, 120);
      const by = lemma ? s.byLemma.get(lemma) || null : null;
      return { seq: e.seq ?? null, at: str(e.at, 40), kind: str(e.kind, 40) || 'event', lemma_id: lemma, by, member: !!by && inTeam.has(by.toLowerCase()) };
    }),
    sync: { ok: s.lastOk, err: s.lastErr ? 'the official record could not be read just now' : null },
    mode: config.mode,
    founder: founderView(s),
    sponsor: { payments: config.sponsor.payments, split: config.rewards.split, wall: `${config.pnp.site}/sponsors` },
  };
  stateAt = Date.now();
  return stateCache;
}

// The founder's live standing on the official board, from the public contributors record (never a fixed number).
function founderView(s) {
  const handle = config.sponsor.founder;
  const all = [...(s.byHandle?.values?.() || [])].filter((e) => e && typeof e.steps === 'number');
  const me = s.byHandle?.get?.(handle.toLowerCase()) || null;
  if (!me || !all.length) return { handle, rank: null, steps: null, contributors: all.length || null, profile: `${config.pnp.site}/a/${handle}` };
  const rank = 1 + all.filter((e) => e.steps > me.steps).length;
  return { handle: me.github || handle, rank, steps: me.steps, contributors: all.length, profile: `${config.pnp.site}/a/${me.github || handle}` };
}

// Sponsor mode: the live page's top bar and footer point to the sponsor home instead of the member program.
function sponsorize(html) {
  return html
    .replace(/<a href="\/#cta">Join<\/a>\s*<a href="\/#board">Board<\/a>\s*<a href="\/#fees">Pay<\/a>/, '<a href="/#fund">Fund</a>')
    .replace(/ It is separate from the member program:[^<]*?depend on it\./, '')
    .replace(/<a href="\/#board">members' board<\/a><a href="\/join.txt">join.txt<\/a>/, '<a href="/#fund">sponsorship fund</a>')
    .replace(/Those proofs are the founder's, under the founder's own name: they are never credited or paid by Valiant's Conjecture\./, "Those proofs are the founder's, under the founder's own name.");
}

function memberPublic(key) {
  const m = db.members[key];
  if (!m || m.banned || isTeam(key)) return null;
  const idx = indexes();
  const credits = (idx.credits.get(key) || [])
    .slice()
    .sort(newestFirst)
    .map((c) => ({ id: c.id, title: c.title, at: c.at, kind: c.kind || null, ref: c.ref || null, pr_url: c.pr_url || null, wallet: c.wallet, paid_in: c.alloc || null, revoked: !!c.revoked }));
  const ws = new Set(walletsOf(m));
  const payments = (db.payments || []).filter((p) => ws.has(p.wallet)).slice(-50).reverse()
    .map((p) => ({ amount: p.amount, wallet: p.wallet, at: p.at, sig: p.sig, url: payout.explorer(p.sig) }));
  const wallets = (m.wallets || []).slice().reverse().map((x, i) => ({ wallet: x.wallet, since: x.at, gist: x.gist || null, current: i === 0 }));
  return { member: true, ...memberView(key, idx), gist: m.gist || null, official_url: `${config.pnp.site}/a/${encodeURIComponent(m.github)}`, credits, payments, wallets };
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
  "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
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
// The body exactly as sent (bytes), or TOO_LARGE when it is larger than `limit`: such a body is
// read to its end and thrown away, so the client gets its answer. null when nobody is left to
// answer: the client hung up, took longer than `ms`, or sent more than `hardCap` (the connection is
// dropped). It never rejects: a client hanging up is not a server error.
const TOO_LARGE = Symbol('too large');
function readCapped(req, limit, { hardCap = limit * 4, ms = 10_000 } = {}) {
  return new Promise((resolve) => {
    let timer = null;
    const done = (v) => { clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => { done(null); req.destroy(); }, ms);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > hardCap) return done(TOO_LARGE);
    let size = 0;
    let chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > hardCap) { done(null); req.destroy(); return; }
      if (size > limit) chunks = null;
      else chunks?.push(c);
    });
    req.on('end', () => done(chunks ? Buffer.concat(chunks) : TOO_LARGE));
    req.on('close', () => done(null)); // after 'end' this changes nothing
    req.on('error', () => done(null));
  });
}

// GET /api/live: the same bytes until the next snapshot, gzipped once for clients that accept it,
// and 304 for a client that already has them (If-None-Match). The age is in x-live-age (seconds).
const acceptsGzip = (req) => String(req.headers['accept-encoding'] || '').split(',').some((t) => {
  const [name, ...params] = t.split(';').map((s) => s.trim().toLowerCase());
  return name === 'gzip' && !params.some((q) => /^q=0(?:\.0*)?$/.test(q));
});
function sendLive(req, res, v) {
  const head = { 'cache-control': 'no-store', etag: v.etag, vary: 'accept-encoding' };
  if (v.age !== null) head['x-live-age'] = String(v.age);
  const weak = (t) => t.trim().replace(/^W\//, '');
  if (String(req.headers['if-none-match'] || '').split(',').some((t) => weak(t) === weak(v.etag))) {
    res.writeHead(304, head);
    return res.end();
  }
  if (acceptsGzip(req)) return send(res, 200, v.gzip, 'application/json; charset=utf-8', { ...head, 'content-encoding': 'gzip' });
  return send(res, 200, v.body, 'application/json; charset=utf-8', head);
}
async function readBody(req, limit = 16 * 1024) {
  const raw = await readRaw(req, limit);
  if (!raw) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  let v;
  try { v = JSON.parse(raw); } catch { throw new UserError('body is not valid JSON'); }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
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
  for (const [k, t] of noUser) if (t <= now) noUser.delete(k);
}, 60 * 1000).unref();

// Behind TRUST_PROXY=<n> reverse proxies, each proxy appends the address it saw to
// X-Forwarded-For, so the client is the n-th entry from the right. Entries further left are
// whatever the client sent, and are never trusted.
const PROXIES = Math.floor(+process.env.TRUST_PROXY) > 0 ? Math.floor(+process.env.TRUST_PROXY) : /^(true|yes|on)$/i.test(process.env.TRUST_PROXY || '') ? 1 : 0;
function ipOf(req) {
  if (PROXIES) {
    const xs = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xs.length >= PROXIES) return xs[xs.length - PROXIES];
  }
  return req.socket.remoteAddress || '?';
}

// A page on another site may not make its visitors' browsers register (each attempt costs a
// GitHub check). Browsers say where a request comes from; programs (curl, agents) say nothing.
function crossSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

function serveFile(res, rel) {
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    // Pages carry absolute links for share cards (og:image needs a full URL).
    let html = ext === '.html' ? buf.toString('utf8').replaceAll('%PUBLIC_URL%', URL_) : null;
    if (html !== null && config.mode === 'sponsor' && rel === 'live.html') html = sponsorize(html);
    const body = html !== null ? Buffer.from(html) : buf;
    send(res, 200, body, MIME[ext] || 'application/octet-stream', ext === '.png' || ext === '.svg' ? { 'cache-control': 'public, max-age=86400' } : {});
  });
}

function decodeId(s) {
  try { return decodeURIComponent(s).trim(); } catch { return null; }
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  const ip = ipOf(req);
  const M = req.method;
  let m;

  // ---- agent-facing texts
  if (config.mode === 'sponsor' && (p === '/join.txt' || p === '/skill.md' || p === '/SKILL.md')) {
    return text(res, 200, `${config.project.name} does not run its own sign-up: it supports the official effort as a sponsor.\nTo prove steps with your own AI agent, follow the official instructions: ${config.pnp.site}/join.txt\nYour proofs are credited to your own GitHub account on ${config.pnp.site}.\n`);
  }
  if (p === '/join.txt') return text(res, 200, joinTxt());
  if (p === '/skill.md' || p === '/SKILL.md') return text(res, 200, skillMd(), 'text/markdown; charset=utf-8');

  // ---- public API
  if (p === '/api/health') return json(res, 200, { ok: true, sync: pnp.state.lastOk, contributors: pnp.state.contributorsAt });
  if (p === '/api/state' && M === 'GET') return json(res, 200, publicState());
  // Live badges for the README (shields.io "endpoint" format).
  if ((m = p.match(/^\/api\/badge\/([a-z-]+)$/)) && M === 'GET') {
    const s = publicState();
    const n = (v) => Number(v || 0).toLocaleString('en-US');
    const b = {
      proven: ['lemmas proven', n(s.official.counters.checked)],
      agents: ['agents online', n(s.official.agents_now)],
      proofs: ['member proofs', n(s.team.proofs)],
      team: ['member proofs', n(s.team.proofs)], // former name of "proofs"
      members: ['members', n(s.team.members)],
      paid: ['paid out', `${Number(s.team.paid || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })} SOL`],
    }[m[1]];
    if (!b) return json(res, 404, { error: 'no such badge' });
    return send(res, 200, { schemaVersion: 1, label: b[0], message: b[1], color: '2B6FD6', labelColor: '1B1A17', cacheSeconds: 300 }, 'application/json; charset=utf-8', {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    });
  }
  if ((m = p.match(/^\/api\/member\/([^/]+)$/)) && M === 'GET') {
    const id = decodeId(m[1]);
    const login = normLogin(id || '');
    if (!id || (!isSolana(id) && !isGithubLogin(login))) return json(res, 400, { error: 'not a Solana address or a GitHub username' });
    const key = resolveMember(id);
    const pub = key && memberPublic(key);
    if (!pub) return json(res, 200, { member: false, wallet: isSolana(id) ? id : null, github: isSolana(id) ? null : login });
    return json(res, 200, pub);
  }

  // The founder's run, live (lib/live.js): anyone reads the latest snapshot; only the publisher on
  // the founder's machine can post one, signed with its key.
  if (p === '/api/live') {
    if (M === 'GET' || M === 'HEAD') {
      if (limited(`lg:${ip}`, LIVE_READS_PER_MINUTE, 60_000)) return json(res, 429, { ok: false, error: 'too many requests from your connection: the live page refreshes on its own every 20 seconds' });
      return sendLive(req, res, live.view());
    }
    if (M !== 'POST') return json(res, 405, { ok: false, error: 'the live mirror is read with GET' });
    if (limited(`lv:${ip}`, config.live.postsPerMinute, 60_000)) return json(res, 429, { ok: false, error: 'too many snapshots from your connection' });
    // Refused before a byte of the body is read, and the connection closed.
    const refuse = (status, error) => send(res, status, { ok: false, error }, 'application/json; charset=utf-8', { connection: 'close' });
    if (!live.configured) return refuse(503, 'the live mirror is not configured on this server');
    if (!looksSigned(req.headers['x-live-signature'])) return refuse(401, 'missing or invalid x-live-signature');
    if (liveUploads.has(ip)) return refuse(429, 'a snapshot from your connection is still being received');
    if (liveUploads.size >= LIVE_UPLOADS_MAX) return refuse(503, 'too many snapshots are being received: try again shortly');
    liveUploads.add(ip);
    let raw;
    try {
      raw = await readCapped(req, LIVE_MAX_BYTES, { ms: LIVE_READ_MS });
    } finally {
      liveUploads.delete(ip);
    }
    if (raw === null) return; // the client hung up or took too long: the connection is closed
    if (raw === TOO_LARGE) return refuse(413, `a snapshot may be at most ${LIVE_MAX_BYTES / 1024} KB`);
    const r = live.ingest(raw, req.headers['x-live-signature']);
    return json(res, r.status, r.body);
  }

  if (p === '/api/register') {
    if (config.mode === 'sponsor') return json(res, 410, { ok: false, error: `Sign-ups are closed: ${config.project.name} supports pequalnp.com as a sponsor and does not pay members. To prove steps, follow ${config.pnp.site}/join.txt with your own agent.` });
    if (M !== 'POST') return json(res, 405, { ok: false, error: `use POST ${URL_}/api/register?github=<login>&wallet=<address>` });
    if (crossSite(req)) return json(res, 403, { ok: false, error: `Register from ${URL_} or with the commands in ${URL_}/join.txt.` });
    if (limited(`rg:${ip}`, config.registerPerMinute, 60_000)) return json(res, 429, { ok: false, error: 'Too many attempts from your connection. Try again in a minute.' });
    const body = await readBody(req);
    const wallet = String(q.wallet ?? body.wallet ?? '').trim();
    const github = normLogin(q.github ?? body.github ?? '');
    if (!isSolana(wallet)) throw new UserError('wallet must be a Solana address (base58, 32 to 44 characters)');
    if (!isGithubLogin(github)) throw new UserError('github must be a GitHub username (letters, digits and hyphens, up to 39 characters)');
    if (limited(`rgl:${github.toLowerCase()}`, 6, 60_000)) return json(res, 429, { ok: false, error: `Too many attempts for @${github}. Try again in a minute.` });
    if (limited('rg:all', 60, 60_000)) return json(res, 429, { ok: false, error: 'Many people are joining right now. Try again in a minute.' });
    const r = await register(github, wallet);
    return json(res, r.status, r.body);
  }

  // Version 1 endpoints. Members now contribute with their own GitHub account.
  if (/^\/api\/(desk\/|submit$|submission\/|me$)/.test(p)) {
    return json(res, 410, { ok: false, error: `This endpoint was retired: members now contribute with their own GitHub account. Read ${URL_}/join.txt` });
  }

  // ---- internal dashboard API
  if (p.startsWith('/api/admin/')) {
    if (limited(`ad:${ip}`, 120, 60_000)) return json(res, 429, { error: 'slow down' });
    if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
    return admin(req, res, p, M);
  }

  // ---- pages
  if (M !== 'GET' && M !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  if (p === '/' || p === '/index.html') return serveFile(res, config.mode === 'sponsor' ? 'sponsor.html' : 'index.html');
  if (/^\/m\/[^/]+\/?$/.test(p)) {
    if (config.mode === 'sponsor') { res.writeHead(302, { location: '/' }); return res.end(); }
    return serveFile(res, 'member.html');
  }
  if (p === '/live' || p === '/live/') return serveFile(res, 'live.html');
  if (p === '/admin' || p === '/admin/') return serveFile(res, 'admin.html');
  return serveFile(res, p.slice(1));
}

async function admin(req, res, p, M) {
  let m;
  if (p === '/api/admin/overview' && M === 'GET') {
    const idx = indexes();
    const members = Object.keys(db.members).map((k) => {
      const mem = db.members[k];
      return { ...memberView(k, idx), banned: !!mem.banned, team: isTeam(k), note: mem.note || '', gist: mem.gist || null, wallets: walletsOf(mem).length, held: (db.payout?.hold || []).includes(mem.wallet) };
    });
    members.sort((a, b) => b.steps - a.steps || String(a.joined_at).localeCompare(String(b.joined_at)));
    const credits = Object.values(db.credits).sort(newestFirst).slice(0, 80)
      .map((c) => ({ id: c.id, title: c.title, at: c.at, github: c.github, login: c.login, wallet: c.wallet, kind: c.kind || null, pr_url: c.pr_url || null, alloc: c.alloc || null, revoked: c.revoked || null }));
    let beforeJoin = 0;
    let onRecord = 0;
    for (const [k, mem] of Object.entries(db.members)) {
      const e = pnp.state.byHandle.get(k);
      if (!e) continue;
      onRecord++;
      const since = Date.parse(mem.joined_at);
      for (const l of e.lemmas) if (Date.parse(l.at) < since) beforeJoin++;
    }
    return json(res, 200, {
      project: config.project,
      team_handles: [...TEAM].map((h) => ({ github: pnp.state.byHandle.get(h)?.github || h, steps: pnp.state.byHandle.get(h)?.steps || 0 })),
      github: { token: gh.tokenSet, token_state: gh.tokenState(), gist_line: gistLine() },
      members,
      credits,
      // The latest sign-ups and wallet changes, and at most 20 refused attempts beside them.
      registrations: [...db.registrations.filter((r) => !isRefusal(r)).slice(-40), ...db.registrations.filter(isRefusal).slice(-20)]
        .sort((a, b) => String(b.at).localeCompare(String(a.at))),
      epochs: db.epochs.slice(-50).reverse().map(({ rows, ...e }) => ({ ...e, recipients: rows.length })),
      payout: { ...payout.status(), balance_now: await payout.liveBalance() },
      rewards: config.rewards,
      sync: {
        ok: pnp.state.lastOk,
        err: pnp.state.lastErr,
        files: pnp.state.files,
        contributors_at: pnp.state.contributorsAt,
        contributors_err: pnp.state.contributorsErr,
        refresh_seconds: config.pnp.contributorsSeconds,
      },
      record: { contributors: pnp.state.contributors?.count || 0, skipped: pnp.state.contributors?.skipped || 0, members_on_record: onRecord, before_join: beforeJoin },
    });
  }

  if ((m = p.match(/^\/api\/admin\/member\/([^/]+)$/))) {
    const id = decodeId(m[1]);
    const key = id && resolveMember(id);
    const mem = key && db.members[key];
    if (!mem) return json(res, 404, { error: 'no such member' });
    if (M === 'GET') {
      return json(res, 200, {
        ...memberView(key),
        banned: !!mem.banned,
        note: mem.note || '',
        gist: mem.gist || null,
        wallets: (mem.wallets || []).slice().reverse(),
        credits: Object.values(db.credits).filter((c) => c.login === key).sort(newestFirst).map((c) => ({ ...c, weight: weightOf(c) })),
        payments: (db.payments || []).filter((x) => walletsOf(mem).includes(x.wallet)).reverse().map((x) => ({ ...x, url: payout.explorer(x.sig) })),
      });
    }
    if (M === 'POST') {
      const b = await readBody(req);
      if (typeof b.banned === 'boolean') mem.banned = b.banned;
      if (typeof b.note === 'string') mem.note = b.note.slice(0, 500);
      if (b.clear_hold) payout.clearHold(mem.wallet);
      store.save();
      stateCache = null;
      if (b.banned === false) ingest(); // proofs made while banned count again
      return json(res, 200, { ok: true });
    }
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
    const rows = ['wallet,amount_sol,steps,weight,github', ...e.rows.map((r) => `${r.wallet},${r.amount},${r.steps},${r.weight},${String(r.github || r.name || '').replace(/[^A-Za-z0-9 _.-]/g, '')}`)];
    return send(res, 200, `${rows.join('\n')}\n`, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${config.project.slug}-${e.id}.csv"` });
  }

  if (p === '/api/admin/sync' && M === 'POST') {
    await tick({ force: true });
    return json(res, 200, { ok: !!pnp.state.lastOk && !pnp.state.lastErr, sync: pnp.state.lastOk, err: pnp.state.lastErr, contributors: pnp.state.contributorsAt, contributors_err: pnp.state.contributorsErr });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- boot
// One sync at a time; a periodic one is skipped while another is running or queued.
let chain = Promise.resolve();
let queued = 0;
function tick({ force = false } = {}) {
  if (!force && queued) return chain;
  queued++;
  const run = chain.then(async () => {
    try {
      await pnp.sync({ force });
      ingest();
      await enrich();
      stateCache = null;
    } finally {
      queued--;
    }
  });
  chain = run.catch((e) => console.error('[sync]', e));
  return chain;
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
  console.log(`  live       ${URL_}/live   ${live.configured ? 'signed snapshots from the operator dashboard' : "OFF: set LIVE_PUBKEY to the publisher's public key (npm run live:keygen prints it)"}`);
  console.log(`  record     ${config.pnp.data} (contributors at most every ${config.pnp.contributorsSeconds}s)`);
  console.log(`  gist check ${gh.tokenSet ? 'with a read-only GitHub token' : 'WITHOUT A GITHUB TOKEN: GitHub allows about 60 checks an hour, so a few people can block sign-ups. Set GITHUB_TOKEN in production.'}`);
  console.log(`  team       ${[...TEAM].map((h) => `@${h}`).join(', ') || '(none)'}: never members, never credited`);
  console.log(`  treasury   ${payout.address() || '(none: npm run wallet)'}   auto-pay ${config.payout.enabled ? 'ON' : 'OFF'}`);
});
tick();
setInterval(tick, config.pnp.syncSeconds * 1000);
payout.schedule();

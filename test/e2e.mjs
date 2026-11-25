// End-to-end test, fully local: our real server against the mock world.
// Members link their own GitHub account to a wallet with a public gist, the official
// record credits their proofs to their own handles, the ledger credits what came after
// they joined, and the team treasury sends SOL, including dropped, ambiguous and
// interrupted transfers, and a member moving to a new wallet.
// Run: npm test
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { createWorld } from './mock-world.mjs';
import { createLive } from '../lib/live.js';
import { buildSnapshot } from '../lib/live-snapshot.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL = (x) => BigInt(Math.round(Number(x) * 1e9));
let passed = 0;
let failed = 0;
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log(`  ok    ${msg}`); }
  else { failed++; console.log(`  FAIL  ${msg}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}
const section = (t) => console.log(`\n# ${t}`);

// ---------------------------------------------------------------- world + server
const world = createWorld();
const mp = await world.listen();
const M = `http://127.0.0.1:${mp}`;
const tmp = [];
const mkdir = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); tmp.push(d); return d; };
const dataDir = mkdir('valiant-e2e-');
const pay = Keypair.generate();
const PAY = pay.publicKey.toBase58();
const port = 3900 + Math.floor(Math.random() * 80);
const base = `http://127.0.0.1:${port}`;

// Nothing from the developer's own environment may reach the server under test.
const APP_VARS = ['PROJECT_NAME', 'TICKER', 'TAGLINE', 'TOKEN_CA', 'PUMP_URL', 'X_URL', 'TG_URL', 'PROJECT_SLUG', 'PUBLIC_URL', 'RENDER_EXTERNAL_URL', 'PORT', 'DATA_DIR', 'ADMIN_TOKEN', 'REGISTER_PER_MINUTE', 'PNP_SITE', 'PNP_DATA', 'PNP_REPO', 'SYNC_SECONDS', 'CONTRIBUTORS_REFRESH_SECONDS', 'GITHUB_API', 'GIST_RAW_BASE', 'GITHUB_TOKEN', 'GIST_TAG', 'PNP_HANDLE', 'PNP_FORMER_HANDLES', 'SPLIT_CONTRIBUTORS', 'SPLIT_SPONSOR', 'SPLIT_OPS', 'SOLANA_RPC', 'SOLANA_CLUSTER', 'PAYOUT_SECRET_KEY', 'PAYOUTS_ENABLED', 'PAYOUT_INTERVAL_MINUTES', 'PAYOUT_RESERVE_SOL', 'MIN_DISTRIBUTION_SOL', 'MIN_PAYOUT_SOL', 'PRIORITY_MICROLAMPORTS', 'PAYOUT_CONFIRM_TIMEOUT_SEC', 'PAYOUT_POLL_MS', 'PAYOUT_BATCH_SIZE', 'TRUST_PROXY', 'LIVE_PUBKEY', 'LIVE_POSTS_PER_MINUTE'];
// The live mirror's signing key, made for this run only, and another key that must be refused.
const liveKeys = crypto.generateKeyPairSync('ed25519');
const otherKeys = crypto.generateKeyPairSync('ed25519');
const env = { ...process.env };
for (const k of APP_VARS) delete env[k];
Object.assign(env, {
  PORT: String(port),
  PUBLIC_URL: base,
  DATA_DIR: dataDir,
  ADMIN_TOKEN: 'test-admin',
  PNP_DATA: `${M}/data/`,
  GITHUB_API: `${M}/gh`,
  GIST_RAW_BASE: `${M}/gistraw/`,
  PNP_HANDLE: 'qed-bot',
  PNP_FORMER_HANDLES: 'Old-QED',
  REGISTER_PER_MINUTE: '200',
  SOLANA_RPC: `${M}/rpc`,
  SOLANA_CLUSTER: 'localnet',
  PAYOUT_SECRET_KEY: JSON.stringify(Array.from(pay.secretKey)),
  PAYOUTS_ENABLED: '1',
  PAYOUT_INTERVAL_MINUTES: '600',
  PAYOUT_CONFIRM_TIMEOUT_SEC: '3',
  PAYOUT_POLL_MS: '100',
  PAYOUT_RESERVE_SOL: '0.01',
  SYNC_SECONDS: '600',
  CONTRIBUTORS_REFRESH_SECONDS: '600',
  TRUST_PROXY: '1',
  LIVE_PUBKEY: liveKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  LIVE_POSTS_PER_MINUTE: '20',
});

let child = null;
let logs = '';
async function startServer(e = env, b = base) {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${b}/api/health`); if (r.ok && (await r.json()).sync) return; } catch {}
    await sleep(100);
  }
  throw new Error(`server did not start:\n${logs}`);
}
async function stopServer() {
  if (!child) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await done;
  child = null;
}
async function call(method, p, { admin, json: body, text: txt, base: b = base, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (admin) headers.authorization = 'Bearer test-admin';
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (txt !== undefined) { headers['content-type'] = 'text/plain'; payload = txt; }
  const r = await fetch(`${b}${p}`, { method, headers, body: payload });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
const sync = () => call('POST', '/api/admin/sync', { admin: true });
const runPayout = async () => (await call('POST', '/api/admin/payout/run', { admin: true })).json;
const overview = async () => (await call('GET', '/api/admin/overview', { admin: true })).json;
const member = async (id) => (await call('GET', `/api/member/${encodeURIComponent(id)}`)).json;
const reg = (github, wallet) => call('POST', `/api/register?github=${encodeURIComponent(github)}&wallet=${encodeURIComponent(wallet)}`);
const wal = () => Keypair.generate().publicKey.toBase58();
const W = Object.fromEntries(['alice', 'alice2', 'bob', 'bob2', 'carol', 'dave', 'erin', 'erin2', 'frank', 'grace', 'henry', 'ctor', 'mallory', 'trent', 'sybil'].map((k) => [k, wal()]));
const line = (w) => `valiant-conjecture wallet: ${w}`;

// ---------------------------------------------------------------- live mirror helpers
const pr = (n) => `https://github.com/open-goat/pequalnp-proofs/pull/${n}`;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const LIVE_KEYS = ['account', 'start', 'end', 'counts', 'rank', 'board', 'accepted', 'waiting', 'ready', 'engine', 'activity'];
// 64 bytes in base64: shaped like a signature, signed by nobody.
const FAKE_SIG = Buffer.alloc(64, 7).toString('base64');
let liveAt = 0;
const nextAt = () => new Date((liveAt = Math.max(Date.now(), liveAt + 1))); // strictly newer every time
const liveBody = (snapshot, at = nextAt()) => JSON.stringify({ v: 1, at: at.toISOString(), snapshot });
const signLive = (body, key = liveKeys.privateKey) => crypto.sign(null, Buffer.from(body), key).toString('base64');
async function postLive(body, { sig = signLive(body), from = '198.51.100.7' } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': from };
  if (sig) headers['x-live-signature'] = sig;
  const r = await fetch(`${base}/api/live`, { method: 'POST', headers, body });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j };
}
async function getLive() {
  const r = await fetch(`${base}/api/live`);
  return { status: r.status, cache: r.headers.get('cache-control'), age: r.headers.get('x-live-age'), json: await r.json() };
}
// GET /api/live with exactly these headers (no automatic Accept-Encoding), body as received.
function rawGet(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/live`, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}
// A snapshot upload on its own connection, sending only `body` of the `length` it announces: what
// comes back, and how long until the server closes the connection.
function rawUpload({ from, sig, length, body = '' }) {
  const sock = net.connect(port, '127.0.0.1');
  const opened = Date.now();
  let data = '';
  sock.on('data', (d) => { data += d; });
  sock.on('error', () => {});
  const closed = new Promise((resolve) => sock.on('close', () => resolve({ ms: Date.now() - opened, data })));
  const head = ['POST /api/live HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Type: application/json', `Content-Length: ${length}`, `X-Forwarded-For: ${from}`];
  if (sig) head.push(`X-Live-Signature: ${sig}`);
  sock.write(`${head.join('\r\n')}\r\n\r\n${body}`);
  return { sock, closed, within: (ms) => Promise.race([closed, sleep(ms).then(() => null)]) };
}

// Shaped like the operator dashboard's /api/status, including everything that must stay private.
function dashboardStatus() {
  const t = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const top = Array.from({ length: 80 }, (_, i) => ({ github: i === 6 ? 'BastianMIllan' : `prover-${i + 1}`, all: 200 - i * 2, hour: i % 5 }));
  return {
    paused: null,
    account: 'BastianMIllan',
    accepted: [
      { id: 'L-meta-5768', title: 'A step toward: four-cycle-free bipartite incidence (step 1 of 2)', n: 11455, url: pr(11455), merged: false, acceptedAt: t(60e3), mergedAt: null, sentAt: t(4000e3) },
      { id: 'L-meta-5633', title: `Table 1a: ${'x'.repeat(300)}`, n: 11451, url: pr(11451), merged: true, acceptedAt: t(120e3), mergedAt: t(90e3), sentAt: t(4100e3) },
      { id: 'L-meta-5634', title: 'merged elsewhere', n: 1, url: 'https://github.com/elsewhere/repo/pull/1', merged: true, acceptedAt: t(130e3), mergedAt: t(100e3), sentAt: t(4200e3) },
    ],
    waiting: [
      { id: 'L-meta-6524', title: '', n: 12042, url: pr(12042), sentAt: t(30e3), fault: false },
      { id: 'L-meta-7406', title: 'just posted', n: '12058', url: pr(12058), sentAt: null, fault: false },
      { id: 'L-meta-6183', title: 'checker fault', n: 11664, url: pr(11664), sentAt: t(3000e3), fault: true },
    ],
    ready: 80,
    now: new Date().toISOString(),
    start: Date.now() - 20 * 3600e3,
    end: Date.now() + 10 * 3600e3,
    setup: { toolchain: true, deps: true, mathlib: 1, mathlibText: 'ready', defs: true },
    engine: {
      policy: 'third-in-line: hold a proof while two other pull requests are in the queue',
      limits: { per10: 20, perHour: 90, perDay: 900, inFlight: 120 },
      pace: { last10: 19, lastHour: 83, last24: 254, inflight: 108 },
      sender: { aliveS: 30, sentHour: 75 },
      robot: { aliveS: 1, triedHour: 2, passedHour: 3, passedAll: 4, last: 'D:/pnp/work/L-meta-7527/Proof.lean passed' },
      family: { aliveS: 3, okHour: 1, triedHour: 2 },
      provers: { stepsTouched15: 83 },
      uploads: { last10: 1, lastHour: 2, last24: 3, per10: 4, perHour: 5, perDay: 6, prestageCap: 7 },
      health: { ok: false, n: 3, ageS: 10, failing: ['C:/Users/someone/.valiant/token ghp_0123456789abcdefghijklmnopqrstuvwxyz'] },
      resends: { sent: 1, tried: 2 },
      blocked: 3,
    },
    poller: { alive: true, last_line_age_s: 3 },
    counts: { accepted: 53, merging: 14, prs: 253, held: 15, seen: 1699 },
    rank: { hour: 2, all: 7, ahead: 5, tied: 2, steps_all: 53, steps_hour: 15 },
    board: {
      at: new Date().toISOString(),
      agents: 290,
      outside: { count: 510, steps: 1906, newest: { github: 'someone', lemma_id: 'L-meta-5050', ref: 'ee3905db1c34', at: t(1e3) }, faces: [{ github: 'someone' }] },
      hour: top.slice(0, 10).map((r) => ({ ...r, last: t(5e3) })),
      top,
      total: 510,
      leaderHour: { github: 'prover-1', all: 200, hour: 17, last: t(5e3) },
    },
    steps: [
      { id: 'L-meta-7527', title: 'in work', status: 'released', posted: false, statement: 'theorem in_work_statement : True', taken_at: t(10e3) },
      { id: 'L-meta-7457', title: 'held proof', status: 'held', posted: false, statement: 'theorem held_statement : True', ready_at: t(5e3) },
    ],
    prs: [{ id: 'L-meta-1708', url: pr(3868), title: 'lost', n: 3868, verdict: 'LOST', merged: false, state: 'closed', final: true, sentAt: t(9000e3) }],
    activity: [
      { at: t(5e3), text: 'Working on L-meta-7527: A step toward: in work', src: 'me' },
      { at: t(6e3), text: `Pull request sent as BastianMIllan for L-meta-7406 (posted step): ${pr(12058)}`, src: 'me' },
      { at: t(6e3), text: 'L-meta-7406 was posted by the desk: its pull request was opened from the held proof', src: 'me' },
      { at: t(7e3), text: "Proof of L-meta-7457 is ready and staged; held because 2 other pull request(s) are already in the checker's queue (we would be third or later)", src: 'me' },
      { at: t(8e3), text: 'Pull request sent as BastianMIllan for L-meta-7000 (posted step): https://evil.example/open-goat/pequalnp-proofs/pull/1', src: 'me' },
      { at: t(9e3), text: 'Permission denied writing D:/pnp/state.json', src: 'me' },
      { at: t(10e3), text: `Pull request sent as BastianMIllan for L-meta-6524 (posted step): ${pr(12042)}`, src: 'me' },
    ],
  };
}

try {
  await startServer();

  section('Agent texts');
  const jt = await call('GET', '/join.txt');
  ok(jt.status === 200 && jt.text.includes(`${base}/api/register?github=<login>&wallet=<address>`), 'join.txt explains registering, with this server URL');
  ok(jt.text.includes('gh auth status') && jt.text.includes(line('<address>')), 'join.txt checks that gh is signed in and names the exact gist line');
  ok(jt.text.includes(`printf 'valiant-conjecture wallet: %s\\n' "<address>" | gh gist create --public`) && jt.text.includes(`"${line('<address>')}" | gh gist create --public`), 'join.txt gives the gist command for bash and for PowerShell');
  ok(jt.text.includes('Invoke-RestMethod -Method Post') && jt.text.includes('Read https://pequalnp.com/join.txt and follow it exactly'), 'join.txt registers from PowerShell too, then hands over to the official instructions');
  ok(!/\/api\/desk|\/api\/submit|qed-bot|Authorization: Bearer/i.test(jt.text), 'join.txt has no desk relay, no submit step, no API key, and never names the team account');
  const sk = await call('GET', '/skill.md');
  ok(sk.text.startsWith('---\nname: join-pnp\n') && sk.text.includes(jt.text.slice(0, 80)), 'skill.md has the skill frontmatter and the same instructions');
  const home = await call('GET', '/');
  ok(home.text.includes('id="verify"') && home.text.includes('id="gist-line"') && home.text.includes('Independent team · not affiliated with pequalnp.com') && !home.text.includes('BastianMIllan on'), 'the home page has the three-step join, the independence label, and no team-account credit line');

  section('Version 1 endpoints are retired');
  ok((await call('GET', '/api/desk/next')).status === 410, 'the desk relay is gone (410, pointing to join.txt)');
  const sub = await call('POST', '/api/submit?assignment=x', { text: 'theorem x' });
  ok(sub.status === 410 && /join\.txt/.test(sub.json?.error), 'the submit endpoint is gone: the server never opens a pull request for a member');

  section("Top bar and the live page");
  const lp = await call('GET', '/live');
  ok(lp.status === 200 && lp.text.includes('/live.js') && lp.text.includes("The founder's own agents, live:") && lp.text.includes('separate from the member program'), 'the live page answers at /live and says the account is the founder\'s own, separate from member payouts');
  for (const [label, p] of [['home page', '/'], ['member page', '/m/alice'], ['live page', '/live']]) {
    const html = (await call('GET', p)).text;
    const nav = html.match(/<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
    const outside = [...nav.matchAll(/<a [^>]*target="_blank"[^>]*>/g)].map((x) => x[0]);
    ok(nav.includes('href="/live"') && nav.includes('href="https://github.com/BastianMIllan/Valiants-Conjecture"') && nav.includes('href="https://x.com/Kvothe_Web3"') && outside.length === 2 && outside.every((a) => a.includes('rel="noopener noreferrer"')), `the ${label} has Live, GitHub and X in its top bar, the outside links in a new tab with no opener`);
  }

  section("Live mirror: signed snapshots only");
  const g0 = await getLive();
  ok(g0.status === 200 && g0.json?.at === null && g0.json.configured === true && g0.cache === 'no-store', 'before the first snapshot the mirror answers {"at":null,"configured":true}, never cached', g0);
  ok((await call('PUT', '/api/live', { json: {} })).status === 405, 'methods other than GET, HEAD and POST are refused (405)');
  const snap = {
    account: 'BastianMIllan',
    now: ago(5000),
    start: ago(3600e3),
    end: new Date(Date.now() + 3600e3).toISOString(),
    counts: { accepted: 53, merging: 14, prs: 253, checking: 2, held_ids: ['L-meta-7457'] },
    rank: { hour: 2, all: 7, ahead: 5, tied: 2, steps_all: 53, steps_hour: 15 },
    board: { agents: 290, top: Array.from({ length: 20 }, (_, i) => ({ github: `prover-${i + 1}`, steps: 120 - i, hour: i % 4, email: `p${i}@example.com` })) },
    accepted: [
      { id: 'L-meta-5633', title: `${'A long statement '.repeat(30)}end`, url: pr(11451), at: ago(600e3), merged_at: ago(300e3), state: 'merged', statement: 'theorem hidden_statement : True' },
      { id: 'L-meta-5768', title: 'accepted, being merged', url: pr(11455), at: ago(500e3), merged_at: null, state: 'accepted' },
      { id: 'L-meta-5999', title: 'a pull request elsewhere', url: 'https://github.com/someone/else/pull/1', at: ago(400e3), state: 'merged' },
      { id: '<img src=x onerror=alert(1)>', title: 'not a step id', url: pr(11460), at: ago(400e3), state: 'merged' },
    ],
    waiting: [
      { id: 'L-meta-6524', title: '', url: pr(12042), at: ago(60e3) },
      { id: 'L-meta-6525', title: 'script link', url: 'javascript:alert(1)', at: ago(60e3) },
    ],
    ready: 80,
    held: 15,
    engine: { stepsTouched15: 83, sentHour: 75, lastHour: 83, limits: { perHour: 90 }, policy: 'third-in-line', health: { failing: ['D:/pnp/x'] } },
    activity: [
      { at: ago(30e3), step: 'L-meta-7406', url: pr(12058), text: 'Working on L-meta-7527' },
      { at: ago(40e3), step: 'L-meta-7000', url: 'https://evil.example/pull/1' },
    ],
    steps: [{ id: 'L-meta-7527', status: 'held', statement: 'theorem in_work_statement : True' }],
    paused: { by: 'operator' },
    setup: { mathlibText: 'ready' },
  };
  const lb1 = liveBody(snap);
  ok((await postLive(lb1, { sig: '' })).status === 401, 'an unsigned snapshot is refused (401)');
  ok((await postLive(lb1, { sig: signLive(lb1, otherKeys.privateKey) })).status === 401, 'a snapshot signed with another key is refused (401)');
  ok((await postLive(lb1.replace('"ready":80', '"ready":81'), { sig: signLive(lb1) })).status === 401, 'a snapshot changed after it was signed is refused (401)');
  ok((await postLive(lb1, { sig: 'not-a-signature' })).status === 401, 'a malformed signature is refused (401)');
  ok((await postLive(liveBody(snap, new Date(Date.now() - 11 * 60e3)))).status === 400, 'a snapshot made more than 10 minutes ago is refused (400)');
  ok((await postLive(liveBody(snap, new Date(Date.now() + 3 * 60e3)))).status === 400, 'a snapshot dated more than 2 minutes ahead is refused (400)');
  ok((await postLive('{"v":1,"at":')).status === 400, 'a signed body that is not JSON is refused (400)');
  const shapes = [{ v: 2, at: new Date().toISOString(), snapshot: snap }, { v: 1, at: new Date().toISOString(), snapshot: [1, 2] }, { v: 1, at: 'yesterday', snapshot: snap }];
  const shaped = [];
  for (const x of shapes) shaped.push((await postLive(JSON.stringify(x))).status);
  ok(shaped.every((s) => s === 400), 'a signed body of the wrong shape (version, snapshot, time) is refused (400)', shaped);
  ok((await postLive(liveBody({ ...snap, filler: 'x'.repeat(140 * 1024) }, new Date()))).status === 413, 'a snapshot over 128 KB is refused (413), even signed');

  const v1 = await postLive(lb1);
  ok(v1.status === 200 && v1.json?.ok && v1.json.at === JSON.parse(lb1).at, 'a snapshot signed with the key is accepted', v1);
  const g1 = await getLive();
  const s1 = g1.json?.snapshot || {};
  ok(g1.json.at === JSON.parse(lb1).at && !('age_s' in g1.json) && Number(g1.age) >= 0 && Number(g1.age) < 30 && g1.cache === 'no-store', 'GET /api/live returns it, with its age in seconds in the x-live-age header, never cached', { at: g1.json.at, age: g1.age, cache: g1.cache });
  ok(JSON.stringify(Object.keys(s1)) === JSON.stringify(LIVE_KEYS), 'only the whitelisted fields are kept: unknown fields such as steps, the pause state and the setup are dropped', Object.keys(s1));
  ok(JSON.stringify(Object.keys(s1.engine || {})) === '["sentHour"]' && JSON.stringify(Object.keys(s1.counts || {})) === '["accepted","merging","prs","checking"]' && JSON.stringify(Object.keys(s1.rank || {})) === '["hour","all","ahead","steps_all","steps_hour"]', 'only figures the page shows are kept: one engine figure, no limits, policy, health, held count or ties; unknown counts are dropped', { engine: s1.engine, counts: s1.counts, rank: s1.rank });
  ok(s1.board?.top?.length === 15 && s1.board.top.every((r) => JSON.stringify(Object.keys(r)) === '["github","steps","hour"]'), 'the board keeps its top 15 rows, each a handle and two figures', s1.board?.top?.length);
  ok(s1.accepted?.length === 2 && s1.accepted[0].title.length <= 160 && s1.accepted[0].title.endsWith('…') && !('statement' in s1.accepted[0]) && s1.accepted[1].state === 'accepted', 'an over-long title is cut to 160 characters, and entries with a foreign pull request link or an invalid step id are dropped', s1.accepted);
  ok(s1.waiting?.length === 1 && s1.waiting[0].id === 'L-meta-6524' && s1.activity?.length === 1 && JSON.stringify(Object.keys(s1.activity[0])) === '["at","step","url"]', 'only official pull request links survive, in the checking list and in the activity', { waiting: s1.waiting, activity: s1.activity });
  ok(!/hidden_statement|in_work_statement|L-meta-7527|L-meta-7457|third-in-line|example\.com|evil\.example|javascript:|onerror|D:\/pnp|mathlib|operator/.test(JSON.stringify(g1.json)), 'nothing outside the whitelist reaches the public answer');
  ok((await postLive(lb1)).status === 409, 'the same snapshot sent again is refused as a replay (409)');
  ok((await postLive(liveBody(snap, new Date(Date.parse(JSON.parse(lb1).at) - 1000)))).status === 409, 'an older snapshot is refused too (409), even signed and recent');

  section('Live mirror: what readers get');
  const gz = await rawGet({ 'accept-encoding': 'gzip' });
  let gzJson = null;
  try { gzJson = JSON.parse(zlib.gunzipSync(gz.body).toString('utf8')); } catch {}
  const plainGet = await rawGet();
  ok(gz.status === 200 && gz.headers['content-encoding'] === 'gzip' && gzJson?.at === JSON.parse(lb1).at && plainGet.status === 200 && !plainGet.headers['content-encoding'] && plainGet.body.equals(zlib.gunzipSync(gz.body)) && gz.body.length < plainGet.body.length / 2 && /accept-encoding/.test(gz.headers.vary || ''), 'the snapshot is sent gzipped to clients that accept it, and as is to the others', { gzip: gz.body.length, plain: plainGet.body.length });
  const tag = gz.headers.etag;
  const nm = await rawGet({ 'if-none-match': tag });
  ok(/^W\/"[A-Za-z0-9_-]{22}"$/.test(tag || '') && plainGet.headers.etag === tag && nm.status === 304 && nm.body.length === 0 && Number(nm.headers['x-live-age']) >= 0, 'it has an ETag, and a reader that already has it gets 304 with the age and no body', { tag, status: nm.status });
  let readsSlowed = 0;
  for (let i = 0; i < 61; i++) if ((await rawGet({ 'x-forwarded-for': '198.51.100.61', 'if-none-match': tag })).status === 429) readsSlowed++;
  ok(readsSlowed === 1, 'more than 60 reads a minute from one connection are slowed down (429)', readsSlowed);

  section('Live mirror: uploads that are refused, slow or abandoned');
  const unsignedEnd = await rawUpload({ from: '203.0.113.50', length: 100000 }).within(3000);
  ok(unsignedEnd !== null && /^HTTP\/1\.1 401 /.test(unsignedEnd.data) && /connection: close/i.test(unsignedEnd.data), 'a snapshot with no signature is refused (401) before its body is read, and the connection closed', unsignedEnd?.data.split('\r\n')[0]);
  const held = [];
  for (let i = 1; i <= 8; i++) held.push(rawUpload({ from: `203.0.113.${i}`, sig: FAKE_SIG, length: 20000, body: '{"v":1,' }));
  await sleep(400);
  const busy = await postLive(liveBody(snap), { sig: FAKE_SIG, from: '203.0.113.9' });
  const twice = await postLive(liveBody(snap), { sig: FAKE_SIG, from: '203.0.113.1' });
  ok(busy.status === 503 && twice.status === 429, 'while 8 uploads are being received, another one is refused (503), and one address sends one at a time (429)', { busy: busy.status, twice: twice.status });
  const heldEnds = await Promise.all(held.map((u) => u.within(15000)));
  ok(heldEnds.every((e) => e && e.ms >= 9000 && e.ms < 13000 && e.data === ''), 'an upload that has not arrived 10 seconds later is dropped', heldEnds.map((e) => e && { ms: e.ms, got: e.data.slice(0, 12) }));
  const gone = rawUpload({ from: '203.0.113.20', sig: FAKE_SIG, length: 20000, body: '{"v":1,' });
  await sleep(200);
  gone.sock.destroy();
  await gone.closed;
  await sleep(200);
  const lb3 = liveBody(snap);
  const v3 = await postLive(lb3, { from: '203.0.113.9' });
  const changed = await rawGet({ 'if-none-match': tag });
  ok(v3.status === 200 && changed.status === 200 && changed.headers.etag !== tag && !/\[http\] POST \/api\/live/.test(logs), 'afterwards a signed snapshot is accepted again and gets a new ETag; an abandoned upload is not logged as a server error', { v3: v3.status, changed: changed.status });

  section('Live mirror: no key, a wrong key, a new key');
  const offDir = mkdir('valiant-live-');
  for (const [label, key] of [['no LIVE_PUBKEY', ''], ['LIVE_PUBKEY=off', 'off'], ['a LIVE_PUBKEY that is not an Ed25519 key', 'not-a-key']]) {
    const log = { n: 0, error() { this.n++; } };
    const l = createLive({ dataDir: offDir, publicKey: key, log });
    const v = JSON.parse(l.view().body);
    const lbk = liveBody(snap);
    ok(!l.configured && l.ingest(Buffer.from(lbk), signLive(lbk)).status === 503 && v.at === null && v.configured === false && log.n === (key === 'not-a-key' ? 1 : 0), `with ${label} the mirror is off: even a signed snapshot is refused (503), and the page is told it is not configured`, { v, errors: log.n });
  }
  const keyDir = mkdir('valiant-live-');
  const spki = (kp) => kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const silent = { error() {} };
  const lk = liveBody(snap);
  const acceptedOnce = createLive({ dataDir: keyDir, publicKey: spki(liveKeys), log: silent }).ingest(Buffer.from(lk), signLive(lk)).status;
  const sameKey = JSON.parse(createLive({ dataDir: keyDir, publicKey: spki(liveKeys), log: silent }).view().body);
  const newKey = JSON.parse(createLive({ dataDir: keyDir, publicKey: spki(otherKeys), log: silent }).view().body);
  ok(acceptedOnce === 200 && sameKey.at === JSON.parse(lk).at && newKey.at === null && newKey.configured === true, 'with the same key a restart shows the saved snapshot; after the key changes (a revoked key), what the old key signed is never shown again', { sameKey: sameKey.at, newKey: newKey.at });

  section("Live mirror: the publisher's whitelist");
  const status = dashboardStatus();
  const built = buildSnapshot(status);
  ok(JSON.stringify(Object.keys(built)) === JSON.stringify(LIVE_KEYS), 'a snapshot built from the dashboard status has only the whitelisted fields', Object.keys(built));
  ok(!/in_work_statement|held_statement|L-meta-7527|L-meta-7457|statement|Working on|staged|held because|third|policy|limits|uploads|health|resends|blocked|paused|setup|mathlib|poller|robot|family|D:\/pnp|C:\/Users|ghp_|evil\.example|elsewhere|Permission|desk|L-meta-1708|someone/.test(JSON.stringify(built)), 'none of the private data is in it: steps in work or held, statements, engine limits, policy, uploads, health, the pause state, the setup, paths, tokens, other activity lines, foreign links');
  ok(JSON.stringify(built.activity.map((a) => [a.step, a.url])) === JSON.stringify([['L-meta-7406', pr(12058)], ['L-meta-6524', pr(12042)]]) && built.activity.every((a) => JSON.stringify(Object.keys(a)) === '["at","step","url"]'), 'of the activity, only the "pull request sent" lines with an official link remain, as {at, step, url}', built.activity);
  ok(built.accepted.length === 2 && built.accepted[0].id === 'L-meta-5768' && built.accepted[0].state === 'accepted' && built.accepted[1].state === 'merged' && !!built.accepted[1].merged_at && built.accepted[1].title.length <= 160, 'accepted proofs come newest first, merged or being merged, titles cut to 160 characters, foreign links dropped', built.accepted);
  ok(JSON.stringify(built.waiting.map((w) => w.id)) === '["L-meta-7406","L-meta-6524","L-meta-6183"]' && built.waiting[0].at === null && built.counts.checking === 3, 'pull requests waiting for the checker come newest first by number, even one just opened with no time yet', built.waiting);
  ok(JSON.stringify(built.engine) === '{"sentHour":75}' && built.ready === 80 && !('held' in built) && !('now' in built) && built.board.agents === 290, 'the engine gives one figure, ready proofs are a count, and the held count and the dashboard clock stay private', { engine: built.engine, ready: built.ready });
  ok(built.board.top.length === 15 && built.board.top[6].github === 'BastianMIllan' && built.board.top[6].steps === 188 && JSON.stringify(built.rank) === '{"hour":2,"all":7,"ahead":5,"steps_all":53,"steps_hour":15}' && !!built.start && !!built.end, 'the board keeps its top 15 (handle, proofs, this hour), with the rank and the run window', built.board.top[6]);
  const hostile = dashboardStatus();
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  hostile.accepted = [
    { id: 'L-meta-9001', title: `C:\\Users\\PC\\.valiant\\live-ed25519-private.pem D:/pnp/state.json ${TOKEN}`, url: pr(13001), merged: true, acceptedAt: ago(3000), mergedAt: ago(2000) },
    { id: TOKEN, title: 'a token as a step id', url: pr(13002), merged: true, acceptedAt: ago(4000), mergedAt: ago(3000) },
    { id: 'L-meta-9003', title: 'A bound for f:\\{0,1\\}^n \\to \\{0,1\\}', url: pr(13003), merged: false, acceptedAt: ago(5000) },
  ];
  hostile.waiting = [{ id: 'L-meta-9004', title: '-----BEGIN PRIVATE KEY----- MC4CAQAwBQYDK2VwBCIEI', url: pr(13004), sentAt: ago(0) }, { id: 'L-meta_9005', title: 'not a step id', url: pr(13005), sentAt: ago(0) }];
  hostile.activity = [{ at: ago(0), text: `Pull request sent as BastianMIllan for ${TOKEN} (posted step): ${pr(13002)}` }, { at: ago(0), text: `Pull request sent as BastianMIllan for L-meta.9006 (posted step): ${pr(13006)}` }];
  const hs = buildSnapshot(hostile);
  const hsText = JSON.stringify(hs);
  ok(JSON.stringify(hs.accepted.map((a) => [a.id, a.title])) === JSON.stringify([['L-meta-9001', ''], ['L-meta-9003', 'A bound for f:\\{0,1\\}^n \\to \\{0,1\\}']]) && JSON.stringify(hs.waiting.map((w) => [w.id, w.title])) === '[["L-meta-9004",""]]' && hs.activity.length === 0 && ![TOKEN, '.valiant', 'D:/pnp', 'BEGIN', 'Users'].some((x) => hsText.includes(x)), 'a title holding a local path, a token or a key is published empty, and an id or activity line that is not a step id is dropped', { accepted: hs.accepted, waiting: hs.waiting, activity: hs.activity });
  const huge = dashboardStatus();
  huge.accepted = Array.from({ length: 600 }, (_, i) => ({ id: `L-meta-${i}`, title: 'y'.repeat(400), url: pr(20000 + i), merged: i % 2 === 0, acceptedAt: ago(i * 1000), mergedAt: ago(i * 500) }));
  huge.waiting = Array.from({ length: 600 }, (_, i) => ({ id: `L-meta-${i}`, title: 'z'.repeat(400), url: pr(30000 + i), sentAt: ago(0) }));
  huge.activity = Array.from({ length: 600 }, (_, i) => ({ at: ago(0), text: `Pull request sent as BastianMIllan for L-meta-${i} (posted step): ${pr(30000 + i)}` }));
  const hb = buildSnapshot(huge);
  const hbBytes = Buffer.byteLength(JSON.stringify({ v: 1, at: new Date().toISOString(), snapshot: hb }));
  ok(hb.accepted.length === 100 && hb.waiting.length === 150 && hb.activity.length === 40 && hbBytes < 128 * 1024 && hb.waiting[0].url === pr(30599) && hb.accepted[0].id === 'L-meta-0', 'however long the dashboard lists grow, a snapshot keeps the newest 100 accepted, 150 checking and 40 events, under 128 KB', { bytes: hbBytes });
  const lb2 = liveBody(built);
  const v2 = await postLive(lb2);
  const g2 = await getLive();
  ok(v2.status === 200 && JSON.stringify(g2.json.snapshot) === JSON.stringify(built), "the server accepts the publisher's snapshot and serves it exactly as built", v2);

  section('Live mirror: rate limit and restart');
  let slowed = 0;
  for (let i = 0; i < 21; i++) if ((await postLive('{}', { sig: '', from: '198.51.100.99' })).status === 429) slowed++;
  ok(slowed === 1, 'more than 20 snapshots a minute from one connection are slowed down (429)', slowed);
  await stopServer();
  await startServer();
  const g3 = await getLive();
  ok(g3.json?.at === JSON.parse(lb2).at && JSON.stringify(g3.json.snapshot) === JSON.stringify(built) && fs.existsSync(path.join(dataDir, 'live.json')), 'the last snapshot survives a restart (DATA_DIR/live.json)', g3.json?.at);
  ok((await postLive(lb2)).status === 409, 'and so does the replay check');

  section('Register: input checks');
  ok((await reg('alice', 'not-a-wallet')).status === 400, 'an invalid wallet is refused');
  ok((await reg('-alice', W.alice)).status === 400 && (await reg('al!ce', W.alice)).status === 400, 'an invalid GitHub username is refused');
  ok((await call('GET', '/api/register')).status === 405, 'registering needs POST');
  const ghBefore = world.gh.requests.length;
  const team1 = await reg('qed-bot', W.erin);
  const team2 = await reg('old-qed', W.erin);
  ok(team1.status === 403 && team2.status === 403 && world.gh.requests.length === ghBefore, "the team's own accounts (current and former) can never register, and GitHub is not even asked");
  const cross1 = await call('POST', `/api/register?github=erin&wallet=${W.erin}`, { headers: { origin: 'https://elsewhere.example' } });
  const cross2 = await call('POST', `/api/register?github=erin&wallet=${W.erin}`, { headers: { 'sec-fetch-site': 'cross-site' } });
  ok(cross1.status === 403 && cross2.status === 403 && world.gh.requests.length === ghBefore, "a page on another site cannot make its visitors' browsers register, so it cannot spend our GitHub checks");
  // Behind TRUST_PROXY=1 the client is the address the proxy appended; entries further left are the client's own.
  let forged = 0;
  for (let i = 0; i <= 200; i++) {
    const r = await call('POST', '/api/register?github=x&wallet=bad', { headers: { 'x-forwarded-for': `10.9.${i >> 8}.${i & 255}, 203.0.113.7` } });
    if (r.status === 429) forged++;
  }
  ok(forged === 1, 'a forged X-Forwarded-For entry does not get a connection a fresh allowance', forged);

  section('Register: proof by public gist');
  // alice already had a proof accepted before she joins: it must never be paid.
  world.controls.prove('Alice', 'L-meta-001', { at: new Date(Date.now() - 3600e3).toISOString() });
  world.controls.gist('Alice', `${line(W.alice)}\n`);
  const ra = await reg('alice', W.alice);
  ok(ra.status === 200 && ra.json.ok && ra.json.new_member && ra.json.github === 'Alice' && !!ra.json.joined_at, "alice joins: her gist holds the line, and GitHub's spelling of her name is kept", ra.json);
  ok(ra.json.page === `${base}/m/${W.alice}` && /pequalnp\.com\/join\.txt/.test(ra.json.next), 'the answer links her page and points to the official instructions');
  ok(world.gh.requests.length > ghBefore && world.gh.requests.every((x) => x.auth === null), 'without GITHUB_TOKEN, GitHub is called with no credentials');
  const n1 = world.gh.requests.length;
  const ra2 = await reg('ALICE', W.alice);
  ok(ra2.json?.ok && ra2.json.already_registered && ra2.json.new_member === false && world.gh.requests.length === n1, 'registering the same account and wallet again changes nothing and needs no GitHub call');

  world.controls.gist('mallory', `${line(W.mallory)}\n`, { owner: 'someone-else' });
  const rm = await reg('mallory', W.mallory);
  ok(rm.status === 422 && rm.json.error === `No public gist on @mallory contains the line: ${line(W.mallory)}`, 'a gist with the line but owned by someone else is refused', rm.json);
  ok(rm.json.command?.bash?.includes('gh gist create --public') && rm.json.command?.powershell?.includes(`"${line(W.mallory)}"`), 'the refusal gives the exact commands to publish the gist');

  world.controls.gist('trent', `valiant-conjecture wallet ${W.trent}\n${line(W.alice)}\n`);
  const rt = await reg('trent', W.trent);
  ok(rt.status === 422 && /No public gist on @trent contains the line/.test(rt.json.error), 'a gist without the exact line for this wallet is refused');

  world.controls.gist('sybil', `${line(W.sybil)}\n`, { rawHost: 'localhost' });
  const rs = await reg('sybil', W.sybil);
  ok(rs.status === 422 && world.gh.raw.length > 0 && !world.gh.raw.some((x) => /^localhost/i.test(x.host)), 'a gist file on any other host is never fetched (no SSRF)', world.gh.raw.map((x) => x.host));

  world.controls.gist('henry', `${line(W.henry)}\n`, { isPublic: false });
  ok((await reg('henry', W.henry)).status === 422, 'a secret gist does not count: the line must be in a public gist');

  const nobody = await reg('nobody-here', W.erin);
  ok(nobody.status === 404 && /no user @nobody-here/.test(nobody.json.error), 'an unknown GitHub user is refused with a clear message');
  const n404 = world.gh.requests.length;
  ok((await reg('nobody-here', W.erin)).status === 404 && world.gh.requests.length === n404, 'an unknown user is remembered for a few minutes: asking again costs no GitHub check');

  world.controls.gist('grace', `${line(W.grace)}\n`);
  world.gh.mode.rateLimit = 1;
  const rr = await reg('grace', W.grace);
  ok(rr.status === 503 && /try again in a few minutes/i.test(rr.json.error), "GitHub's rate limit becomes a friendly try-again", rr.json);
  ok((await reg('grace', W.grace)).json?.ok, 'once GitHub answers again, the same registration goes through');

  world.controls.gist('bob', `${line(W.alice)}\n`);
  const nb = world.gh.requests.length;
  ok((await reg('bob', W.alice)).status === 409 && world.gh.requests.length === nb, 'a wallet already registered to another account is refused');

  world.controls.gist('bob', `${line(W.bob)}\n`);
  const rb = await call('POST', '/api/register', { json: { github: '@bob', wallet: W.bob } });
  ok(rb.json?.ok && rb.json.github === 'bob', 'registration also takes a JSON body (and a leading @)');
  world.controls.gist('carol', `﻿my payout address\r\n${line(W.carol)}\r\n`, { filename: 'payout.txt', description: 'wallet' });
  world.controls.gist('carol', 'console.log(1)', { filename: 'snippet.js', description: 'other things' });
  ok((await reg('carol', W.carol)).json?.ok, 'a gist from PowerShell (CRLF, BOM) under another file name is found too');
  for (const who of ['dave', 'erin', 'frank']) world.controls.gist(who, `${line(W[who])}\n`);
  const rest = await Promise.all(['dave', 'erin', 'frank'].map((who) => reg(who, W[who])));
  ok(rest.every((x) => x.json?.ok), 'dave, erin and frank join at the same time');

  let hammered = 0;
  for (let i = 0; i < 7; i++) if ((await reg('hammer-time', W.trent)).status === 429) hammered++;
  ok(hammered === 1, 'more than six attempts a minute for one GitHub account are slowed down');

  section('Credit from the official record');
  world.controls.prove('Alice', 'L-meta-002');
  world.controls.prove('Alice', 'L-meta-003');
  world.controls.prove('bob', 'L-meta-004');
  world.controls.prove('carol', 'L-meta-005', { prUrl: 'https://github.com/elsewhere/other-repo/pull/1' });
  world.controls.prove('dave', 'L-meta-006', { kind: 'constructor' }); // must not disturb the weights
  world.controls.prove('qed-bot', 'L-meta-007');
  world.controls.prove('someone-else', 'L-meta-008');
  world.controls.prove('erin', 'L-meta-004'); // the same lemma listed twice: bob's listing comes first
  world.controls.junk(null, { github: 42 }, { github: 'not a login!', lemmas: [{ id: 'L-meta-030', at: new Date().toISOString() }] }, { github: 'frank', lemmas: [{ id: '', at: 'x' }, { id: 'L-meta-031', at: 'not a date' }, { title: 'no id' }] });
  const sy = await sync();
  ok(sy.json?.ok && !sy.json.contributors_err, 'the record syncs despite malformed rows', sy.json);
  const ma = await member(W.alice);
  ok(ma.member && ma.steps === 2 && ma.github === 'Alice', 'alice is credited with her two proofs since joining, not the one from before', ma.steps);
  ok(ma.official_steps === 3, 'her page still shows all three proofs she has on pequalnp.com');
  const c2 = ma.credits.find((c) => c.id === 'L-meta-002');
  ok(c2 && c2.kind === 'helper' && /^https:\/\/github\.com\/open-goat\/pequalnp-proofs\/pull\/\d+$/.test(c2.pr_url) && c2.wallet === W.alice, 'each credit carries its kind, its pull request on the official repository and the wallet at the time', c2);
  ok((await member('BOB')).steps === 1 && (await member('erin')).steps === 0, 'a lemma listed twice is credited once, to the member who joined first');
  const mc = await member('carol');
  ok(mc.steps === 1 && mc.credits[0].pr_url === null, 'a pull request link outside the official repository is ignored');
  ok((await member('frank')).steps === 0, 'malformed lemmas are skipped');
  let st = (await call('GET', '/api/state')).json;
  ok(st.team.members === 7 && st.team.proofs === 5, 'the team shows 7 members and 5 credited proofs', st.team);
  ok(!st.board.some((b) => b.login === 'qed-bot') && !st.member_lemmas.includes('L-meta-007') && !st.member_lemmas.includes('L-meta-008'), "the team account's and outsiders' proofs are never counted as members' work");
  ok(st.board[0].login === 'alice' && st.board[0].avatar === 'https://github.com/Alice.png?size=80', 'the board ranks alice first, with her GitHub picture');
  const fe = st.feed.find((e) => e.lemma_id === 'L-meta-002');
  ok(fe?.member === true && fe.by === 'Alice' && st.feed.find((e) => e.lemma_id === 'L-meta-008')?.member === false, "the live feed marks members' proofs");
  const badge = (await call('GET', '/api/badge/proofs')).json;
  const oldBadge = (await call('GET', '/api/badge/team')).json;
  ok(badge.message === '5' && badge.label === 'member proofs' && oldBadge.message === '5', "README badges count members' credited proofs; the old 'team' badge no longer shows the team account's totals");
  const page = await call('GET', '/m/alice');
  ok(page.status === 200 && page.text.includes('/member.js'), 'member pages answer at /m/<github> as well as /m/<wallet>');
  const stranger = await member(W.trent);
  ok(stranger.member === false && stranger.wallet === W.trent, 'a wallet that never joined is not a member');

  section('A proof that leaves the record stops counting until it is paid');
  world.controls.unprove('carol', 'L-meta-005');
  await sync();
  ok((await member('carol')).steps === 0, 'withdrawn from the record: it no longer counts for carol');
  world.controls.prove('carol', 'L-meta-005');
  await sync();
  ok((await member('carol')).steps === 1, 'listed again: it counts again, once');
  // The record moves it from carol to dave before it is paid: the first sync withdraws it, the next one moves it.
  world.controls.unprove('carol', 'L-meta-005');
  world.controls.prove('dave', 'L-meta-005');
  await sync();
  await sync();
  const dv = await member('dave');
  ok((await member('carol')).steps === 0 && dv.steps === 2 && dv.credits.some((c) => c.id === 'L-meta-005' && !c.revoked && c.wallet === W.dave), 'a proof the record moves to another member before it is paid moves with it, to their wallet');
  world.controls.unprove('dave', 'L-meta-005');
  world.controls.prove('carol', 'L-meta-005');
  await sync();
  await sync();
  ok((await member('carol')).steps === 1 && (await member('dave')).steps === 1, 'and back again');

  section('Treasury: funded once');
  world.controls.fund(PAY, SOL(1.01));
  const w = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace'].map((k) => W[k]);
  const before = w.map((x) => world.controls.balance(x));
  let r = await runPayout();
  ok(r.ok && r.allocated && r.sent === 4, 'one run allocated 1 SOL and paid four members', r);
  const got = w.map((x, i) => world.controls.balance(x) - before[i]);
  ok(got[0] === SOL(0.4) && got[1] === SOL(0.2) && got[2] === SOL(0.2) && got[3] === SOL(0.2), 'alice got 0.4 SOL (2 proofs), three others 0.2 SOL each', got.map(String));
  ok((await member('dave')).credits[0].kind === 'constructor', 'an odd kind name in the record is shown but weighs like any other proof');
  ok(got[4] === 0n && got[5] === 0n && got[6] === 0n, 'members without credited proofs got nothing');
  ok(world.sol.sent.length === 1, 'all four transfers went in one transaction');
  let ov = await overview();
  ok(ov.payout.owed_total === '0' && ov.payout.paid_total === '1', 'nothing is owed afterwards; 1 SOL paid in total', ov.payout);
  world.controls.unprove('Alice', 'L-meta-002');
  await sync();
  const paidGone = await member('alice');
  ok(paidGone.steps === 2 && paidGone.credits.some((c) => c.id === 'L-meta-002' && c.paid_in && !c.revoked), 'a proof that was already paid stays paid when it leaves the record');

  section('Treasury: nothing new');
  r = await runPayout();
  ok(r.ok && !r.allocated && r.sent === 0, 'a run with no new funds sends nothing', r);
  world.controls.fund(PAY, SOL(0.5));
  r = await runPayout();
  ok(r.ok && !r.allocated && r.sent === 0, 'new funds with no new credited proof wait in the treasury', r);

  section('Treasury: only new proofs share new funds');
  world.controls.prove('bob', 'L-meta-009');
  await sync();
  const b1 = world.controls.balance(w[1]);
  r = await runPayout();
  ok(r.sent === 1 && world.controls.balance(w[1]) - b1 >= SOL(0.49), 'the waiting 0.5 SOL went to the one member with a new proof', String(world.controls.balance(w[1]) - b1));

  section('The record as a plain list');
  world.controls.shape('list');
  world.controls.prove('carol', 'L-meta-010');
  await sync();
  ok((await member('carol')).steps === 2, 'the record as a plain list is read the same way');

  section('Treasury: a transfer that never lands');
  world.controls.fund(PAY, SOL(0.3));
  world.sol.mode.drop = 1;
  const b2 = world.controls.balance(w[2]);
  r = await runPayout();
  const due2 = SOL(r.allocated?.amount);
  ok(r.pending === 1 && world.controls.balance(w[2]) === b2 && due2 > SOL(0.29), 'a dropped transfer stays pending and nothing is credited', r);
  await sleep(9000); // past its last valid block (+ margin)
  r = await runPayout();
  ov = await overview();
  const failedB = ov.payout.batches.find((b) => b.status === 'failed');
  ok(failedB && /expired/.test(failedB.err), 'the dropped transfer is recognised as expired', failedB);
  ok(r.sent === 1 && world.controls.balance(w[2]) - b2 === due2, 'it is sent again and lands exactly once', String(world.controls.balance(w[2]) - b2));

  section('The record cannot be fetched');
  world.controls.shape('object');
  world.controls.failContributors(1);
  world.controls.prove('dave', 'L-meta-011');
  const badSync = await sync();
  ov = await overview();
  ok(!badSync.json.ok && !!badSync.json.contributors_err && !!ov.sync.contributors_err && (await member('dave')).steps === 1, 'when the record cannot be fetched, the last good copy stays in use', badSync.json);
  ok((await member('alice')).steps === 2 && (await member('carol')).steps === 2, 'and no proof is withdrawn because of it');
  await sync();
  ok((await member('dave')).steps === 2, 'the next sync picks up the new proof');

  section('Treasury: landed, but the answer was lost');
  world.controls.fund(PAY, SOL(0.2));
  world.sol.mode.errAfterLand = 1;
  const b3 = world.controls.balance(w[3]);
  r = await runPayout();
  const due3 = SOL(r.allocated?.amount);
  ok(r.sent === 1 && world.controls.balance(w[3]) - b3 === due3 && due3 > SOL(0.19), 'the server checks the chain, sees it landed, and counts it once', r);
  r = await runPayout();
  ok(r.sent === 0 && world.controls.balance(w[3]) - b3 === due3, 'and never sends it again');

  section('Treasury: server stopped mid-transfer');
  world.controls.prove('Alice', 'L-meta-012');
  await sync();
  world.controls.fund(PAY, SOL(0.1));
  world.sol.mode.hideMs = 5000;
  const b0 = world.controls.balance(W.alice);
  r = await runPayout();
  const due0 = SOL(r.allocated?.amount);
  ok(r.pending === 1 && due0 > SOL(0.09), 'the transfer is in flight when the server stops', r);
  world.controls.gist('Alice', `${line(W.alice2)}\n`);
  const early = await reg('alice', W.alice2);
  ok(early.status === 409 && /still being confirmed/.test(early.json?.error) && (await member('alice')).wallet === W.alice, 'a wallet change waits while a payout to the current wallet is in flight', early.json);
  await stopServer();
  await sleep(2500);
  world.sol.mode.hideMs = 0;
  env.GITHUB_TOKEN = 'test-read-token';
  await startServer();
  await sleep(1500);
  ov = await overview();
  ok(ov.payout.batches[0].status === 'confirmed', 'after restart the in-flight transfer is settled from its signature', ov.payout.batches[0]);
  r = await runPayout();
  ok(world.controls.balance(W.alice) - b0 === due0 && r.sent === 0, 'it was paid exactly once', String(world.controls.balance(W.alice) - b0));

  section('A member moves to a new wallet');
  world.controls.prove('Alice', 'L-meta-013');
  await sync();
  world.controls.fund(PAY, SOL(0.1));
  world.sol.mode.refuse = 1;
  r = await runPayout();
  const owedA = (await member('alice')).owed;
  ok(r.failed === 1 && SOL(owedA) > SOL(0.09), 'a refused transfer leaves alice owed on her current wallet', { r, owedA });
  const nTok = world.gh.requests.length;
  const moved = await reg('alice', W.alice2);
  ok(moved.json?.ok && moved.json.wallet_changed && moved.json.moved_owed === owedA && moved.json.joined_at === ra.json.joined_at, 'with a gist for the new wallet, alice moves: what she is owed follows her, her join time stays', moved.json);
  ok(world.gh.requests.length > nTok && world.gh.requests.slice(nTok).every((x) => x.auth === 'Bearer test-read-token'), 'with GITHUB_TOKEN set, it is sent to GitHub as a bearer token');
  // Her first gist, for her earlier wallet, is still public: anyone could post it again.
  const replay = await reg('alice', W.alice);
  ok(replay.status === 422 && /created after your last wallet change/.test(replay.json?.error) && (await member('alice')).wallet === W.alice2, "replaying alice's old gist cannot move her back to her earlier wallet: a change needs a gist made after the last one", replay.json);
  const bNew = world.controls.balance(W.alice2);
  const bOld = world.controls.balance(W.alice);
  r = await runPayout();
  ok(r.sent === 1 && world.controls.balance(W.alice2) - bNew === SOL(owedA) && world.controls.balance(W.alice) === bOld, 'the next run pays the new wallet, and nothing more goes to the old one', r);
  world.controls.prove('Alice', 'L-meta-014');
  await sync();
  const det = (await call('GET', '/api/admin/member/alice', { admin: true })).json;
  ok(det.credits.find((c) => c.id === 'L-meta-014')?.wallet === W.alice2 && det.credits.find((c) => c.id === 'L-meta-002')?.wallet === W.alice, 'new credits record the new wallet; earlier ones keep the old one');
  world.controls.gist('bob', `${line(W.alice)}\n`);
  ok((await reg('bob', W.alice)).status === 409, "alice's earlier wallet stays hers: nobody else can register it");
  const viaOld = await member(W.alice);
  ok(viaOld.member && viaOld.wallet === W.alice2 && viaOld.wallets.length === 2 && viaOld.wallets[0].current && viaOld.wallets[0].wallet === W.alice2, 'her earlier wallet still leads to her page, which lists both wallets');

  section('Books balance');
  ov = await overview();
  const all = [...w, W.alice2];
  const received = all.reduce((a, x) => a + world.controls.balance(x), 0n);
  const paidTotal = SOL(ov.payout.paid_total);
  const funded = SOL(1.01) + SOL(0.5) + SOL(0.3) + SOL(0.2) + SOL(0.1) + SOL(0.1);
  const fees = BigInt(world.sol.sent.length) * 5000n;
  ok(received === paidTotal, 'what members received equals what the ledger says was paid', { received: String(received), paidTotal: String(paidTotal) });
  ok(world.controls.balance(PAY) === funded - received - fees, 'the treasury holds exactly funded − paid − fees', String(world.controls.balance(PAY)));
  ok(world.controls.balance(PAY) >= SOL(0.0099), 'the reserve was never distributed');
  const m0 = await member('alice');
  ok(m0.payments.length === 3 && SOL(m0.paid) === SOL(0.4) + due0 + SOL(owedA) && m0.payments.every((x) => x.url.includes(x.sig)) && m0.payments[0].wallet === W.alice2, "alice's page lists her three payments, to both wallets, with transaction links", m0.payments);

  section('A username that passes to another GitHub account');
  world.controls.prove('bob', 'L-meta-016');
  await sync();
  const bobBefore = await member('bob');
  // bob renames his account; someone else takes the name "bob" and publishes a gist for their own wallet.
  world.controls.clearGists('bob');
  world.controls.gist('bob', `${line(W.bob2)}\n`, { ownerId: 777 });
  const taken = await reg('bob', W.bob2);
  const bobAfter = await member('bob');
  ok(taken.status === 409 && /different GitHub account/.test(taken.json?.error) && bobAfter.wallet === W.bob && bobAfter.owed === bobBefore.owed && bobAfter.steps === bobBefore.steps && bobAfter.credits.some((c) => c.id === 'L-meta-016' && c.wallet === W.bob && !c.paid_in), "the newcomer cannot take over bob's membership, his balance or his unpaid proofs", taken.json);
  ok((await overview()).registrations[0].result === 'refused: different GitHub account', 'the dashboard shows the refusal');

  section('A username that is also a JavaScript word');
  world.controls.gist('constructor', `${line(W.ctor)}\n`);
  const rc = await reg('constructor', W.ctor);
  ok(rc.status === 200 && rc.json.new_member === true && rc.json.github === 'constructor', 'the GitHub user "constructor" joins as a new member like anyone else', rc.json);
  world.controls.gist('ivan', `${line(W.ctor)}\n`);
  ok((await reg('ivan', W.ctor)).status === 409 && (await member(W.ctor)).github === 'constructor' && (await overview()).members.some((x) => x.login === 'constructor'), 'their wallet is theirs: nobody else can register it, and they are on the dashboard');

  section('GitHub refuses the token');
  world.gh.mode.rejectToken = true;
  world.controls.gist('erin', `${line(W.erin2)}\n`);
  const nRej = world.gh.requests.length;
  const re = await reg('erin', W.erin2);
  const tried = world.gh.requests.slice(nRej);
  ok(re.json?.ok && re.json.wallet_changed && tried.length === 2 && tried[0].auth && !tried[1].auth, 'a token GitHub refuses (401) is dropped and the check goes on without it', { re: re.json, tried });
  ok((await overview()).github.token_state === 'refused', 'and the dashboard says the token was refused');
  world.gh.mode.rejectToken = false;

  section('Admin controls');
  await call('POST', '/api/admin/payout/pause', { admin: true, json: { paused: true } });
  r = await runPayout();
  ok(r.skipped && /paused/.test(r.skipped), 'pausing stops payouts');
  await call('POST', '/api/admin/payout/pause', { admin: true, json: { paused: false } });
  ok((await call('GET', '/api/admin/overview')).status === 401, 'the dashboard API needs the password');
  await call('POST', '/api/admin/member/grace', { admin: true, json: { banned: true } });
  world.controls.prove('grace', 'L-meta-015');
  await sync();
  st = (await call('GET', '/api/state')).json;
  ok(!st.board.some((b) => b.login === 'grace') && (await member('grace')).member === false, 'a banned member leaves the board and their page');
  ok((await call('GET', '/api/admin/member/grace', { admin: true })).json.steps === 0 && (await reg('grace', W.grace)).status === 403, 'their new proofs do not count, and they cannot register again');
  await call('POST', `/api/admin/member/${W.grace}`, { admin: true, json: { banned: false } });
  ok((await member('grace')).steps === 1, 'unbanning restores them, with the proof made in between');
  const csv = await call('GET', `/api/admin/epoch/${ov.epochs[ov.epochs.length - 1].id}/csv`, { admin: true });
  ok(csv.status === 200 && csv.text.startsWith('wallet,amount_sol,steps,weight,github\n') && csv.text.includes(',Alice\n'), 'each allocation exports as CSV');

  section('Upgrading a version 1 ledger');
  await stopServer();
  const v1Dir = mkdir('valiant-v1-');
  const wx = wal(); // a version 1 member, paid in full
  const wy = wal(); // owed, but no version 1 member: version 1 never paid it either
  const wz = wal(); // a version 1 member still owed 0.002 SOL
  const at = new Date(Date.now() - 86400e3).toISOString();
  fs.writeFileSync(path.join(v1Dir, 'db.json'), JSON.stringify({
    version: 1,
    secret: 'fixture-secret',
    members: { [wx]: { wallet: wx, name: 'old', created_at: at, banned: false, note: '', keys: 1 }, [wz]: { wallet: wz, name: 'owed', created_at: at, banned: false, note: '', keys: 1 } },
    credits: { [wx]: { 'L-old-001': { id: 'L-old-001', ref: 'aa', title: 'old', at, alloc: 'E0001' } } },
    keys: { deadbeef: wx },
    submissions: { s_1: { id: 's_1', wallet: wx, at } },
    unattributed: {},
    leases: {},
    assignments: {},
    epochs: [{ id: 'E0001', created_at: at, from: at, to: at, unit: 'SOL', pool: '0.5', total_weight: 1, distributed: '0.5', dust: '0', rows: [{ wallet: wx, name: 'old', steps: 1, weight: 1, lemmas: ['L-old-001'], share: 1, lamports: '500000000', amount: '0.5' }] }],
    owed: { [wy]: '1000000', [wz]: '2000000' },
    payments: [{ id: `B00001:${wx}`, wallet: wx, lamports: '500000000', amount: '0.5', sig: 'sig1', batch: 'B00001', at }],
    batches: [{ id: 'B00001', items: [{ wallet: wx, lamports: '500000000' }], sig: 'sig1', blockhash: 'x', lvbh: 1, status: 'confirmed', created_at: at, done_at: at }],
    payout: { paused: true, solo: [], fails: {}, hold: [] },
  }));
  const port1 = port + 1;
  const base1 = `http://127.0.0.1:${port1}`;
  const env1 = { ...env, PORT: String(port1), PUBLIC_URL: base1, DATA_DIR: v1Dir, PAYOUTS_ENABLED: '0' };
  delete env1.PAYOUT_SECRET_KEY;
  await startServer(env1, base1);
  const ov1 = (await call('GET', '/api/admin/overview', { admin: true, base: base1 })).json;
  ok(ov1.members.length === 0 && ov1.payout.paid_total === '0.5' && ov1.payout.owed_total === '0.003' && ov1.payout.paused === true && ov1.epochs.length === 1 && ov1.payout.batches.length === 1, 'members start fresh; the treasury books, transfers and allocations carry over unchanged', ov1 && { members: ov1.members?.length, payout: ov1.payout, epochs: ov1.epochs });
  const adopt = [];
  for (const v of [wx, wy, wz]) {
    world.controls.gist('mallory', `${line(v)}\n`);
    adopt.push(await call('POST', `/api/register?github=mallory&wallet=${v}`, { base: base1 }));
  }
  ok(adopt.every((x) => x.status === 409 && /payout history/.test(x.json?.error)), 'nobody can adopt a version 1 wallet with a balance or payments by naming it in a gist, so nobody can carry its balance off with a wallet change', adopt.map((x) => x.json));
  await stopServer();
  const saved = JSON.parse(fs.readFileSync(path.join(v1Dir, 'db.json'), 'utf8'));
  ok(saved.version === 2 && !!saved.archive_v1?.members?.[wx] && !saved.keys && !saved.submissions && saved.secret === 'fixture-secret' && fs.readdirSync(v1Dir).some((f) => f.startsWith('db.json.v1-')), 'the old member tables are set aside, and a copy of the old file is kept');
  await startServer({ ...env1, PAYOUT_SECRET_KEY: env.PAYOUT_SECRET_KEY, PAYOUTS_ENABLED: '1' }, base1);
  await call('POST', '/api/admin/payout/pause', { admin: true, json: { paused: false }, base: base1 });
  const r1 = (await call('POST', '/api/admin/payout/run', { admin: true, base: base1 })).json;
  ok(r1?.sent === 1 && world.controls.balance(wz) === 2000000n && world.controls.balance(wy) === 0n, 'what version 1 still owed a member is paid to that same wallet; an amount version 1 owed no member stays put', r1);
} catch (e) {
  failed++;
  console.error('\nTEST CRASHED:', e);
} finally {
  if (process.env.KEEP && !failed) {
    // Leave a populated server and the mock world running, to look at the pages.
    await startServer().catch(() => {});
    console.log(`\nKEEP: ${base}  (dashboard password: test-admin)  ${passed} passed. Ctrl+C to stop.`);
    console.log(`KEEP_MEMBER: ${base}/m/alice`);
    await new Promise(() => {});
  }
  await stopServer();
  await world.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`\n--- server log ---\n${logs.slice(-4000)}`);
  process.exit(failed ? 1 : 0);
}

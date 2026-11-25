// End-to-end test, fully local: our real server against the mock world.
// Members link their own GitHub account to a wallet with a public gist, the official
// record credits their proofs to their own handles, the ledger credits what came after
// they joined, and the team treasury sends SOL, including dropped, ambiguous and
// interrupted transfers, and a member moving to a new wallet.
// Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { createWorld } from './mock-world.mjs';

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
const APP_VARS = ['PROJECT_NAME', 'TICKER', 'TAGLINE', 'TOKEN_CA', 'PUMP_URL', 'X_URL', 'TG_URL', 'PROJECT_SLUG', 'PUBLIC_URL', 'RENDER_EXTERNAL_URL', 'PORT', 'DATA_DIR', 'ADMIN_TOKEN', 'REGISTER_PER_MINUTE', 'PNP_SITE', 'PNP_DATA', 'PNP_REPO', 'SYNC_SECONDS', 'CONTRIBUTORS_REFRESH_SECONDS', 'GITHUB_API', 'GIST_RAW_BASE', 'GITHUB_TOKEN', 'GIST_TAG', 'PNP_HANDLE', 'PNP_FORMER_HANDLES', 'SPLIT_CONTRIBUTORS', 'SPLIT_SPONSOR', 'SPLIT_OPS', 'SOLANA_RPC', 'SOLANA_CLUSTER', 'PAYOUT_SECRET_KEY', 'PAYOUTS_ENABLED', 'PAYOUT_INTERVAL_MINUTES', 'PAYOUT_RESERVE_SOL', 'MIN_DISTRIBUTION_SOL', 'MIN_PAYOUT_SOL', 'PRIORITY_MICROLAMPORTS', 'PAYOUT_CONFIRM_TIMEOUT_SEC', 'PAYOUT_POLL_MS', 'PAYOUT_BATCH_SIZE', 'TRUST_PROXY'];
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

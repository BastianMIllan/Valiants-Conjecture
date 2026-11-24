// End-to-end test, fully local: our real server against the mock world.
// Members register, take steps through the desk relay, submit Lean files, the
// "checker" accepts pull requests, the ledger credits members, and the pay wallet
// sends SOL, including dropped, ambiguous and interrupted transfers.
// Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { createWorld } from './mock-world.mjs';
import { checkLean } from '../lib/leanrules.js';

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

// ---------------------------------------------------------------- lean rules (unit)
section('Lean format checks');
const gap0 = { id: 'L-x-1', module: 'L_x_1', statement: '∀ n : ℕ, n + 1 = 1 + n', imports: ['PEqualNP.Foo'] };
const good = `import Mathlib\nimport PEqualNP.Foo\n\n-- the obvious way\ntheorem L_x_1 : ∀ n : ℕ, n + 1 = 1 + n := by\n  intro n\n  omega\n`;
ok(checkLean(good, gap0).ok, 'a plain correct file passes');
ok(!checkLean(good.replace('omega', 'sorry'), gap0).ok, 'sorry is refused');
ok(!checkLean(good.replace('omega', 'native_decide'), gap0).ok, 'native_decide is refused');
ok(!checkLean(good.replace('-- the obvious way', 'def s := "x"'), gap0).ok, 'double quotes are refused');
ok(!checkLean(good.replace('import PEqualNP.Foo', 'import PEqualNP.Bar'), gap0).ok, 'imports outside gap.imports are refused');
ok(!checkLean(good.replace('theorem L_x_1', '#eval 1\ntheorem L_x_1'), gap0).ok, '# commands are refused');
ok(!checkLean(good.replace('theorem L_x_1', 'theorem Other'), gap0).ok, 'the theorem must carry gap.module');
ok(checkLean(good.replace('theorem L_x_1', 'set_option maxHeartbeats 400000 in\ntheorem L_x_1'), gap0).ok, 'an allowed set_option passes');
ok(!checkLean(good.replace('theorem L_x_1', 'set_option pp.all true in\ntheorem L_x_1'), gap0).ok, 'other options are refused');
ok(!checkLean(good.replace('theorem L_x_1', '@[reducible]\ntheorem L_x_1'), gap0).ok, 'attributes other than simp are refused');
ok(checkLean(good.replace('-- the obvious way', '-- no axiom needed'), gap0).warnings.length > 0 && checkLean(good.replace('-- the obvious way', '-- no axiom needed'), gap0).ok, 'a forbidden word in a comment only warns');

// ---------------------------------------------------------------- world + server
const world = createWorld();
const mp = await world.listen();
const M = `http://127.0.0.1:${mp}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collective-e2e-'));
const pay = Keypair.generate();
const PAY = pay.publicKey.toBase58();
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  PUBLIC_URL: base,
  DATA_DIR: dataDir,
  ADMIN_TOKEN: 'test-admin',
  PNP_SITE: `${M}/pnp`,
  PNP_DATA: `${M}/data/`,
  GITHUB_API: `${M}/gh`,
  PNP_HANDLE: 'qed-bot',
  GITHUB_TOKEN: 'test-token',
  PR_X_HANDLE: 'qed_team',
  SOLANA_RPC: `${M}/rpc`,
  SOLANA_CLUSTER: 'localnet',
  PAYOUT_SECRET_KEY: JSON.stringify(Array.from(pay.secretKey)),
  PAYOUTS_ENABLED: '1',
  PAYOUT_INTERVAL_MINUTES: '600',
  PAYOUT_CONFIRM_TIMEOUT_SEC: '3',
  PAYOUT_POLL_MS: '100',
  PAYOUT_RESERVE_SOL: '0.01',
  DESK_GAP_MS: '0',
  SYNC_SECONDS: '600',
};
let child = null;
let logs = '';
async function startServer() {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok && (await r.json()).sync) return; } catch {}
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
async function call(method, p, { key, admin, json: body, text: txt } = {}) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (admin) headers.authorization = 'Bearer test-admin';
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  if (txt !== undefined) { headers['content-type'] = 'text/plain'; payload = txt; }
  const r = await fetch(`${base}${p}`, { method, headers, body: payload });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
const sync = () => call('POST', '/api/admin/sync', { admin: true });
const runPayout = async () => (await call('POST', '/api/admin/payout/run', { admin: true })).json;
const overview = async () => (await call('GET', '/api/admin/overview', { admin: true })).json;
const leanFor = (g, extra = '') => `import Mathlib\n\ntheorem ${g.module} : ${g.statement} := by\n  intro n\n  omega${extra}\n`;

try {
  await startServer();

  section('Agent texts');
  const jt = await call('GET', '/join.txt');
  ok(jt.status === 200 && jt.text.includes(`${base}/api/register`) && jt.text.includes('/api/submit'), 'join.txt explains register, desk and submit with this server URL');
  ok(!/gh auth|gh pr create|\bgist\b/.test(jt.text), 'join.txt no longer asks for GitHub');
  const sk = await call('GET', '/skill.md');
  ok(sk.text.startsWith('---\nname: join-pnp\n'), 'skill.md has the skill frontmatter');

  section('Register');
  const members = [];
  for (let i = 0; i < 7; i++) {
    const w = Keypair.generate().publicKey.toBase58();
    const r = await call('POST', `/api/register?wallet=${w}${i === 0 ? '&name=alice' : ''}`);
    members.push({ wallet: w, key: r.json?.key });
  }
  ok(members.every((m) => m.key && m.key.startsWith('pnp_')), 'seven members registered, each with a key');
  globalThis.__alice = members[0].wallet;
  ok((await call('POST', '/api/register?wallet=not-a-wallet')).status === 400, 'an invalid wallet is refused');
  const again = await call('POST', `/api/register?wallet=${members[0].wallet}&name=mallory`);
  ok(again.json?.ok && again.json.new_member === false && again.json.name === 'alice', 'registering the same wallet again adds a key but cannot rename the member');
  ok((await call('GET', '/api/desk/next')).status === 401, 'the desk needs a key');
  ok((await call('GET', '/api/desk/next', { key: 'pnp_wrong' })).status === 401, 'a wrong key is refused');

  section('Desk relay (our handle holds the steps)');
  const asg = [];
  for (let i = 0; i < 5; i++) asg[i] = (await call('GET', '/api/desk/next', { key: members[i].key })).json;
  ok(asg.every((a) => a.ok && a.assignment && a.gap?.statement), 'five members each got a step');
  ok(new Set(asg.map((a) => a.gap.id)).size === 5, 'the five steps are distinct');
  ok(world.desk.calls.filter((c) => c.path === '/pnp/desk/next').every((c) => c.q.handle === 'qed-bot'), 'every desk request is made under our handle');
  ok(world.desk.calls.filter((c) => c.path === '/pnp/desk/next').slice(1).every((c) => c.q.another === '1'), 'after the first step we ask with another=1');
  const same = (await call('GET', '/api/desk/next', { key: members[0].key })).json;
  ok(same.assignment === asg[0].assignment, 'asking again returns the step already held');
  asg[5] = (await call('GET', '/api/desk/next', { key: members[5].key })).json;
  ok(asg[5].shared === true && asg.slice(0, 5).some((a) => a.gap.id === asg[5].gap.id), 'the sixth member shares a held step (five is the limit)');
  asg[6] = (await call('GET', '/api/desk/next?hard=1', { key: members[6].key })).json;
  ok(asg[6].assignment && !asg[6].shared && !asg.slice(0, 5).some((a) => a.gap.id === asg[6].gap.id), 'a hard step can be taken beyond the five');
  ok((await call('POST', `/api/desk/beat?assignment=${asg[1].assignment}`, { key: members[1].key })).status === 200, 'renewing a held step works');
  ok((await call('POST', `/api/desk/beat?assignment=${asg[1].assignment}`, { key: members[2].key })).status === 404, 'a member cannot renew another member\'s step');
  const rel = await call('POST', `/api/desk/release?assignment=${asg[4].assignment}&reason=missing_lemma`, { key: members[4].key });
  const l4 = [...world.desk.leases.values()].find((l) => l.gap.id === asg[4].gap.id);
  ok(rel.status === 200 && l4.status === 'released' && l4.reason === 'missing_lemma', 'handing a step back releases it at the desk with the reason');
  ok((await call('POST', `/api/desk/release?assignment=${asg[3].assignment}&reason=bogus`, { key: members[3].key })).status === 400, 'an unknown reason is refused');

  section('Submit (our account opens the pull request)');
  const bad = await call('POST', `/api/submit?assignment=${asg[0].assignment}`, { key: members[0].key, text: leanFor(asg[0].gap).replace('omega', 'sorry') + '-- "x"\n' });
  ok(bad.status === 422 && bad.json.errors.length >= 2 && world.gh.prs.length === 0, 'a file breaking the rules is refused with reasons, and no pull request is opened');
  ok((await call('POST', `/api/submit?assignment=${asg[1].assignment}`, { key: members[0].key, text: leanFor(asg[1].gap) })).status === 404, 'a member cannot submit on another member\'s step');
  const subs = [];
  for (let i = 0; i < 4; i++) subs[i] = (await call('POST', `/api/submit?assignment=${asg[i].assignment}`, { key: members[i].key, text: leanFor(asg[i].gap) })).json;
  ok(subs.every((s) => s.ok && s.submission && s.pr), 'four valid files were submitted', subs.map((s) => s.error || s.errors));
  const pr1 = world.gh.prs[0];
  const branchFile = world.gh.branches.get(pr1.branch)?.get(asg[0].gap.file);
  ok(world.gh.fork, 'the fork was created under our account');
  ok(pr1.head === `qed-bot:${asg[0].gap.id}` && pr1.title === asg[0].gap.id && pr1.base === 'main', 'the pull request comes from our account, titled with the step id');
  ok(branchFile && branchFile.content === leanFor(asg[0].gap) && branchFile.commits === 1, 'one branch, one commit, one file, with the member\'s exact content');
  ok(pr1.body === '**X handle**: @qed_team', 'the description carries only our X handle line');
  ok(asg.slice(0, 4).every((a) => [...world.desk.leases.values()].find((l) => l.gap.id === a.gap.id)?.status === 'submitted'), 'each submitted step is released at the desk as submitted');
  const sharedLease = [...world.desk.leases.values()].find((l) => l.gap.id === asg[5].gap.id);
  const beat6 = await call('POST', `/api/desk/beat?assignment=${asg[5].assignment}`, { key: members[5].key });
  ok(sharedLease.status === 'submitted' ? beat6.status === 410 : beat6.status === 200, 'the member sharing a step learns (410) when the other member sent it');

  section('Verdicts and fixes');
  world.controls.reject(4);
  await sync();
  const v4 = (await call('GET', `/api/submission/${subs[3].submission}`, { key: members[3].key })).json;
  ok(v4.verdict === 'REJECTED', 'a REJECTED verdict reaches the agent', v4);
  const fix = await call('POST', `/api/submit?assignment=${asg[3].assignment}`, { key: members[3].key, text: leanFor(asg[3].gap, '\n  -- fixed') });
  const f4 = world.gh.branches.get(world.gh.prs[3].branch).get(asg[3].gap.file);
  ok(fix.json?.updated === true && world.gh.prs.length === 4 && f4.commits === 2 && f4.content.includes('fixed'), 'a fix is pushed to the same pull request, no new one');
  ok((await call('GET', `/api/submission/${subs[0].submission}`, { key: members[1].key })).status === 404, 'a member cannot read another member\'s submission');

  section('Credit from the official record');
  for (const n of [1, 2, 3, 4]) world.controls.accept(n);
  const a5 = (await call('GET', '/api/desk/next', { key: members[0].key })).json;
  const s5 = (await call('POST', `/api/submit?assignment=${a5.assignment}`, { key: members[0].key, text: leanFor(a5.gap) })).json;
  world.controls.accept(5);
  world.controls.creditForeign('L-meta-9999');
  await sync();
  const mp0 = (await call('GET', `/api/member/${members[0].wallet}`)).json;
  ok(mp0.member && mp0.steps === 2 && mp0.display === 'alice', 'alice is credited with her two accepted proofs', mp0.steps);
  ok((await call('GET', `/api/member/${members[3].wallet}`)).json.steps === 1, 'the fixed proof is credited after acceptance');
  const st = (await call('GET', '/api/state')).json;
  ok(st.team.steps === 6 && st.team.attributed === 5, 'the team shows 6 steps under our handle, 5 traced to members', st.team);
  ok(st.board[0].wallet === members[0].wallet, 'the board ranks alice first');
  let ov = await overview();
  ok(ov.unattributed.length === 1 && ov.unattributed[0].id === 'L-meta-9999', 'a proof under our handle that did not come through the app is listed as unattributed');
  ok(s5.ok, 'a member can take and send another step after the first');

  section('Pay wallet: funded once');
  world.controls.fund(PAY, SOL(1.01));
  const w = members.map((m) => m.wallet);
  const before = w.map((x) => world.controls.balance(x));
  let r = await runPayout();
  ok(r.ok && r.allocated && r.sent === 4, 'one run allocated 1 SOL and paid four members', r);
  const got = w.map((x, i) => world.controls.balance(x) - before[i]);
  ok(got[0] === SOL(0.4) && got[1] === SOL(0.2) && got[2] === SOL(0.2) && got[3] === SOL(0.2), 'alice got 0.4 SOL (2 proofs), three others 0.2 SOL each', got.map(String));
  ok(got[4] === 0n && got[5] === 0n && got[6] === 0n, 'members without accepted proofs got nothing');
  ok(world.sol.sent.length === 1, 'all four transfers went in one transaction');
  ov = await overview();
  ok(ov.payout.owed_total === '0' && ov.payout.paid_total === '1', 'nothing is owed afterwards; 1 SOL paid in total', ov.payout);

  section('Pay wallet: nothing new');
  r = await runPayout();
  ok(r.ok && !r.allocated && r.sent === 0, 'a run with no new funds sends nothing', r);
  world.controls.fund(PAY, SOL(0.5));
  r = await runPayout();
  ok(r.ok && !r.allocated && r.sent === 0, 'new funds with no new accepted proof wait in the wallet', r);

  section('Pay wallet: only new proofs share new funds');
  const a6 = (await call('GET', '/api/desk/next', { key: members[1].key })).json;
  await call('POST', `/api/submit?assignment=${a6.assignment}`, { key: members[1].key, text: leanFor(a6.gap) });
  world.controls.accept(6);
  await sync();
  const b1 = world.controls.balance(w[1]);
  r = await runPayout();
  ok(r.sent === 1 && world.controls.balance(w[1]) - b1 >= SOL(0.49), 'the waiting 0.5 SOL went to the one member with a new proof', String(world.controls.balance(w[1]) - b1));

  section('Pay wallet: a transfer that never lands');
  const a7 = (await call('GET', '/api/desk/next', { key: members[2].key })).json;
  await call('POST', `/api/submit?assignment=${a7.assignment}`, { key: members[2].key, text: leanFor(a7.gap) });
  world.controls.accept(7);
  await sync();
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

  section('Pay wallet: landed, but the answer was lost');
  const a8 = (await call('GET', '/api/desk/next', { key: members[3].key })).json;
  await call('POST', `/api/submit?assignment=${a8.assignment}`, { key: members[3].key, text: leanFor(a8.gap) });
  world.controls.accept(8);
  await sync();
  world.controls.fund(PAY, SOL(0.2));
  world.sol.mode.errAfterLand = 1;
  const b3 = world.controls.balance(w[3]);
  r = await runPayout();
  const due3 = SOL(r.allocated?.amount);
  ok(r.sent === 1 && world.controls.balance(w[3]) - b3 === due3 && due3 > SOL(0.19), 'the server checks the chain, sees it landed, and counts it once', r);
  r = await runPayout();
  ok(r.sent === 0 && world.controls.balance(w[3]) - b3 === due3, 'and never sends it again');

  section('Pay wallet: server stopped mid-transfer');
  const a9 = (await call('GET', '/api/desk/next', { key: members[0].key })).json;
  await call('POST', `/api/submit?assignment=${a9.assignment}`, { key: members[0].key, text: leanFor(a9.gap) });
  world.controls.accept(9);
  await sync();
  world.controls.fund(PAY, SOL(0.1));
  world.sol.mode.hideMs = 5000;
  const b0 = world.controls.balance(w[0]);
  r = await runPayout();
  const due0 = SOL(r.allocated?.amount);
  ok(r.pending === 1 && due0 > SOL(0.09), 'the transfer is in flight when the server stops', r);
  await stopServer();
  await sleep(2500);
  world.sol.mode.hideMs = 0;
  await startServer();
  await sleep(1500);
  ov = await overview();
  ok(ov.payout.batches[0].status === 'confirmed', 'after restart the in-flight transfer is settled from its signature', ov.payout.batches[0]);
  r = await runPayout();
  ok(world.controls.balance(w[0]) - b0 === due0 && r.sent === 0, 'it was paid exactly once', String(world.controls.balance(w[0]) - b0));

  section('Books balance');
  ov = await overview();
  const received = w.reduce((a, x) => a + world.controls.balance(x), 0n);
  const paidTotal = BigInt(Math.round(Number(ov.payout.paid_total) * 1e9));
  const funded = SOL(1.01) + SOL(0.5) + SOL(0.3) + SOL(0.2) + SOL(0.1);
  const fees = BigInt(world.sol.sent.length) * 5000n;
  ok(received === paidTotal, 'what members received equals what the ledger says was paid', { received: String(received), paidTotal: String(paidTotal) });
  ok(world.controls.balance(PAY) === funded - received - fees, 'the pay wallet holds exactly funded − paid − fees', String(world.controls.balance(PAY)));
  ok(world.controls.balance(PAY) >= SOL(0.0099), 'the reserve was never distributed');
  const m0 = (await call('GET', `/api/member/${members[0].wallet}`)).json;
  ok(m0.payments.length === 2 && SOL(m0.paid) === SOL(0.4) + due0 && m0.payments.every((p) => p.url.includes(p.sig)), 'alice\'s page lists her two payments with transaction links', m0.payments);

  section('Admin controls');
  await call('POST', '/api/admin/payout/pause', { admin: true, json: { paused: true } });
  r = await runPayout();
  ok(r.skipped && /paused/.test(r.skipped), 'pausing stops payouts');
  await call('POST', '/api/admin/payout/pause', { admin: true, json: { paused: false } });
  ok((await call('GET', '/api/admin/overview')).status === 401, 'the dashboard API needs the password');
  await call('POST', `/api/admin/member/${members[6].wallet}`, { admin: true, json: { banned: true } });
  ok((await call('GET', '/api/desk/next', { key: members[6].key })).status === 401, 'a banned member\'s key stops working');
  const csv = await call('GET', `/api/admin/epoch/${ov.epochs[ov.epochs.length - 1].id}/csv`, { admin: true });
  ok(csv.status === 200 && csv.text.startsWith('wallet,amount_sol'), 'each allocation exports as CSV');
} catch (e) {
  failed++;
  console.error('\nTEST CRASHED:', e);
} finally {
  if (process.env.KEEP && !failed) {
    // Leave the populated server and mock world running, to look at the pages.
    console.log(`\nKEEP: ${base}  (dashboard password: test-admin)  ${passed} passed. Ctrl+C to stop.`);
    console.log(`KEEP_MEMBER: ${base}/m/${globalThis.__alice || ''}`);
    await new Promise(() => {});
  }
  await stopServer();
  await world.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`\n--- server log ---\n${logs.slice(-4000)}`);
  process.exit(failed ? 1 : 0);
}

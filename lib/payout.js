// The pay wallet. A plain Solana keypair held by this server: no on-chain program.
// Every few minutes:
//   1. settle any transfer still in flight (by its signature),
//   2. available = balance - what is already owed - reserve,
//   3. if enough is available and there are accepted steps not yet allocated,
//      split it across them (allocate) and add each member's share to what they are owed,
//   4. send every owed balance above the minimum, in batched System transfers.
// Safety: a batch is written to disk with its signature BEFORE it is broadcast,
// and is only counted as paid once the chain shows it confirmed. A batch whose
// blockhash expired without landing is retried; nothing is ever paid twice.
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, SendTransactionError } from '@solana/web3.js';
import { toUnits, fmtUnits, b58decode, b58encode } from './units.js';

const SOL = 9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadKeypair(config) {
  let raw = config.payout.secretKey;
  const file = path.join(config.dataDir, 'payout-key.json');
  if (!raw && fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  const bytes = raw.startsWith('[') ? JSON.parse(raw) : b58decode(raw);
  if (!bytes || bytes.length !== 64) throw new Error('the pay wallet key must be a 64-byte secret key (a JSON array, or base58 as exported by Phantom)');
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function createPayout({ config, db, store, allocate, isPayable }) {
  db.owed ||= {}; // wallet -> lamports (string)
  db.payments ||= []; // { id, wallet, lamports, amount, sig, batch, at }
  db.batches ||= []; // { id, items: [{ wallet, lamports }], sig, blockhash, lvbh, status, err, created_at, done_at }
  db.payout ||= { paused: false, solo: [], fails: {}, hold: [] };
  db.payout.solo ||= [];
  db.payout.fails ||= {};
  db.payout.hold ||= [];

  const P = config.payout;
  const kp = loadKeypair(config);
  const conn = kp ? new Connection(P.rpc, { commitment: 'confirmed', disableRetryOnRateLimit: false }) : null;
  const reserve = toUnits(P.reserve, SOL);
  const minDistribution = toUnits(P.minDistribution, SOL);
  const minPayout = toUnits(P.minPayout, SOL);
  let busy = false;
  let nextAt = null;

  const owedOf = (w) => BigInt(db.owed[w] || '0');
  const owedTotal = () => Object.values(db.owed).reduce((a, v) => a + BigInt(v), 0n);
  const addOwed = (w, u) => {
    const v = owedOf(w) + BigInt(u);
    if (v > 0n) db.owed[w] = v.toString();
    else delete db.owed[w];
  };
  const explorer = (sig) => `https://solscan.io/tx/${sig}${P.cluster && P.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(P.cluster)}` : ''}`;

  async function balance() {
    return BigInt(await conn.getBalance(kp.publicKey, 'confirmed'));
  }

  // ---------------------------------------------------------------- settling
  async function statusOf(b) {
    const st = (await conn.getSignatureStatuses([b.sig], { searchTransactionHistory: true })).value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      return st.err ? { done: 'failed', err: `on-chain error ${JSON.stringify(st.err)}` } : { done: 'confirmed' };
    }
    if (st && st.err) return { done: 'failed', err: `on-chain error ${JSON.stringify(st.err)}` };
    const height = await conn.getBlockHeight('confirmed');
    if (height > b.lvbh + 30) { // a margin past its last valid block, against a lagging node
      // Past its last valid block: look once more, then it can never land.
      const again = (await conn.getSignatureStatuses([b.sig], { searchTransactionHistory: true })).value[0];
      if (again && !again.err) return { done: 'confirmed' };
      if (again && again.err) return { done: 'failed', err: `on-chain error ${JSON.stringify(again.err)}` };
      return { done: 'failed', err: 'expired: the transaction never landed' };
    }
    return { done: null };
  }

  function finish(b, result) {
    b.status = result.done;
    b.done_at = new Date().toISOString();
    if (result.done === 'confirmed') {
      for (const it of b.items) {
        addOwed(it.wallet, -BigInt(it.lamports));
        db.payments.push({ id: `${b.id}:${it.wallet}`, wallet: it.wallet, lamports: it.lamports, amount: fmtUnits(it.lamports, SOL), sig: b.sig, batch: b.id, at: b.done_at });
        delete db.payout.fails[it.wallet];
      }
      db.payout.solo = db.payout.solo.filter((w) => !b.items.some((it) => it.wallet === w));
    } else {
      b.err = result.err;
      if (b.items.length > 1) {
        // Retry these one by one, so one bad recipient cannot block the others.
        for (const it of b.items) if (!db.payout.solo.includes(it.wallet)) db.payout.solo.push(it.wallet);
      } else {
        const w = b.items[0].wallet;
        db.payout.fails[w] = (db.payout.fails[w] || 0) + 1;
        if (db.payout.fails[w] >= 3 && !db.payout.hold.includes(w)) db.payout.hold.push(w);
      }
    }
    store.save();
  }

  async function settle(b, waitMs) {
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await statusOf(b);
      if (r.done) { finish(b, r); return r.done; }
      if (Date.now() >= until) return 'pending';
      await sleep(P.pollMs);
    }
  }

  async function resolvePending() {
    for (const b of db.batches.filter((x) => x.status === 'pending')) {
      try {
        await settle(b, 0);
      } catch (e) {
        db.payout.lastError = `checking ${b.id}: ${e.message}`;
      }
    }
  }

  // ---------------------------------------------------------------- sending
  async function sendBatch(items) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 + 400 * items.length }));
    if (P.priorityMicroLamports > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: P.priorityMicroLamports }));
    for (const it of items) {
      tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(it.wallet), lamports: BigInt(it.lamports) }));
    }
    tx.sign(kp);
    const raw = tx.serialize();
    const id = `B${String(db.batches.length + 1).padStart(5, '0')}`;
    const b = {
      id,
      items: items.map((it) => ({ wallet: it.wallet, lamports: String(it.lamports) })),
      sig: b58encode(tx.signature),
      blockhash,
      lvbh: lastValidBlockHeight,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    db.batches.push(b);
    store.flush(); // on disk before it can reach the chain

    try {
      await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
    } catch (e) {
      if (e instanceof SendTransactionError) {
        // The node refused it in simulation: it was never broadcast.
        finish(b, { done: 'failed', err: `refused: ${String(e.message).slice(0, 300)}` });
        return 'failed';
      }
      b.note = `send error, checking the chain: ${String(e.message).slice(0, 200)}`;
      store.save();
    }
    return settle(b, P.confirmTimeoutSec * 1000);
  }

  function chunks(list) {
    const out = [];
    const solo = new Set(db.payout.solo);
    let cur = [];
    for (const it of list) {
      if (solo.has(it.wallet)) { out.push([it]); continue; }
      cur.push(it);
      if (cur.length >= P.batchSize) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // ---------------------------------------------------------------- the run
  async function tick({ manual = false } = {}) {
    if (!kp) return { ok: false, skipped: 'no pay wallet configured' };
    if (busy) return { ok: false, skipped: 'a run is already in progress' };
    busy = true;
    const report = { ok: true, allocated: null, sent: 0, failed: 0, pending: 0 };
    try {
      await resolvePending();
      if (!P.enabled) return { ...report, ok: false, skipped: 'payouts are off (PAYOUTS_ENABLED)' };
      if (db.payout.paused) return { ...report, ok: false, skipped: 'paused from the dashboard' };
      if (db.batches.some((b) => b.status === 'pending')) return { ...report, ok: false, skipped: 'a transfer is still being confirmed' };

      let bal = await balance();
      const available = bal - owedTotal() - reserve;
      report.balance = fmtUnits(bal, SOL);
      report.available = fmtUnits(available > 0n ? available : 0n, SOL);
      if (available >= minDistribution) {
        const e = allocate(available);
        if (e) {
          for (const r of e.rows) addOwed(r.wallet, r.lamports);
          report.allocated = { epoch: e.id, recipients: e.rows.length, amount: e.distributed };
          store.save();
        }
      }

      const due = Object.keys(db.owed)
        .filter((w) => owedOf(w) >= minPayout && isPayable(w) && !db.payout.hold.includes(w))
        .map((w) => ({ wallet: w, lamports: owedOf(w) }))
        .sort((a, b) => (b.lamports > a.lamports ? 1 : -1));
      for (const group of chunks(due)) {
        const need = group.reduce((a, it) => a + it.lamports, 0n) + 50_000n;
        if (need > bal) { db.payout.lastError = 'the wallet holds less than what is owed: fund it'; break; }
        const r = await sendBatch(group);
        if (r === 'confirmed') { report.sent += group.length; bal = await balance(); }
        else if (r === 'failed') report.failed += group.length;
        else { report.pending += group.length; break; }
      }
      if (!report.failed) db.payout.lastError = null;
      return report;
    } catch (e) {
      db.payout.lastError = `${new Date().toISOString()} ${e.message}`;
      console.error('[payout]', e);
      return { ...report, ok: false, error: e.message };
    } finally {
      db.payout.lastRun = new Date().toISOString();
      db.payout.lastReport = { ...report, manual };
      busy = false;
      store.save();
    }
  }

  function schedule() {
    if (!kp) return;
    const every = P.intervalMinutes * 60000;
    nextAt = Date.now() + every;
    setInterval(() => {
      nextAt = Date.now() + every;
      tick().catch(() => {});
    }, every);
    // Settle anything left in flight by a previous run, right away.
    resolvePending().then(() => store.save()).catch((e) => console.error('[payout] resolve on boot:', e.message));
  }

  function status() {
    const recent = db.batches.slice(-25).reverse().map((b) => ({
      id: b.id,
      status: b.status,
      recipients: b.items.length,
      amount: fmtUnits(b.items.reduce((a, it) => a + BigInt(it.lamports), 0n), SOL),
      sig: b.sig,
      url: explorer(b.sig),
      err: b.err || null,
      note: b.note || null,
      at: b.created_at,
    }));
    return {
      configured: !!kp,
      address: kp ? kp.publicKey.toBase58() : null,
      cluster: P.cluster,
      enabled: P.enabled,
      paused: !!db.payout.paused,
      interval_minutes: P.intervalMinutes,
      next_run_at: nextAt ? new Date(nextAt).toISOString() : null,
      reserve: P.reserve,
      min_payout: P.minPayout,
      min_distribution: P.minDistribution,
      last_run: db.payout.lastRun || null,
      last_error: db.payout.lastError || null,
      last_report: db.payout.lastReport || null,
      last_balance: db.payout.lastReport?.balance ?? null,
      owed_total: fmtUnits(owedTotal(), SOL),
      paid_total: fmtUnits(db.payments.reduce((a, p) => a + BigInt(p.lamports), 0n), SOL),
      held_wallets: db.payout.hold,
      batches: recent,
    };
  }

  // For the dashboard: the balance right now, or null if the node cannot be reached.
  async function liveBalance() {
    if (!kp) return null;
    try {
      return fmtUnits(await Promise.race([balance(), sleep(5000).then(() => { throw new Error('timeout'); })]), SOL);
    } catch {
      return null;
    }
  }

  function clearHold(w) {
    db.payout.hold = db.payout.hold.filter((x) => x !== w);
    delete db.payout.fails[w];
    store.save();
  }

  return { tick, schedule, status, explorer, owedOf, clearHold, liveBalance, configured: () => !!kp, address: () => kp?.publicKey.toBase58() || null, SOL };
}

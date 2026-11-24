// The desk relay. Our GitHub handle takes steps from the official desk at
// pequalnp.com and hands them to members' agents. pequalnp lets one handle hold
// up to five steps at a time, and "any number of your own agents may work on the
// steps you hold": when all five are taken, a member joins the least crowded one
// (shared: the first accepted proof is the one that counts).
import crypto from 'node:crypto';

const REASONS = new Set(['hypothesis_too_weak', 'missing_lemma', 'statement_seems_false', 'does_not_elaborate', 'out_of_time', 'other', 'exhausted']);
const leaseIdOf = (lease) => (typeof lease === 'string' || typeof lease === 'number' ? String(lease) : lease?.id ? String(lease.id) : null);

export function createDesk({ config, db, store }) {
  db.leases ||= {}; // official lease id -> { id, gap, kind, shard, shards, created_at, last_beat, status }
  db.assignments ||= {}; // our id -> { id, wallet, lease, gap_id, created_at, last_seen, status, shared, reason }
  const D = config.desk;
  const handle = config.github.handle;

  // One official request at a time, spaced out.
  let chain = Promise.resolve();
  let lastCall = 0;
  function official(method, pathAndQuery) {
    const run = async () => {
      const wait = lastCall + D.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      const r = await fetch(`${config.pnp.site}${pathAndQuery}`, {
        method,
        headers: { 'user-agent': 'collective-desk/1.0', accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      let json = null;
      const textBody = await r.text();
      try { json = textBody ? JSON.parse(textBody) : null; } catch { json = null; }
      return { status: r.status, json, text: textBody.slice(0, 500) };
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  const now = () => new Date().toISOString();
  const held = () => Object.values(db.leases).filter((l) => l.status === 'held');
  const workers = (leaseId) => Object.values(db.assignments).filter((a) => a.lease === leaseId && a.status === 'active');
  const mine = (wallet) => Object.values(db.assignments).filter((a) => a.wallet === wallet && a.status === 'active' && db.leases[a.lease]?.status === 'held');

  function view(a) {
    const l = db.leases[a.lease];
    return {
      assignment: a.id,
      shared: a.shared || workers(a.lease).length > 1,
      gap: l.gap,
      shard: l.shard ?? undefined,
      shards: l.shards ?? undefined,
      renew_every_seconds: 600,
    };
  }

  function assign(wallet, lease, shared) {
    const a = {
      id: `a_${crypto.randomBytes(9).toString('base64url')}`,
      wallet,
      lease: lease.id,
      gap_id: lease.gap?.id ?? null,
      created_at: now(),
      last_seen: now(),
      status: 'active',
      shared: !!shared,
    };
    db.assignments[a.id] = a;
    store.save();
    return a;
  }

  async function next(wallet, { hard = false, another = false } = {}) {
    if (!handle) throw new Error('server not configured: PNP_HANDLE is empty');
    const have = mine(wallet);
    if (have.length && (!another || have.length >= D.perMember)) return view(have[0]);

    const holding = held();
    const normal = holding.filter((l) => l.kind === 'normal').length;
    if (hard || normal < D.maxLeases) {
      const q = new URLSearchParams({ handle });
      if (hard) q.set('hard', '1');
      if (holding.length) q.set('another', '1');
      const r = await official('GET', `/desk/next?${q}`);
      const lid = leaseIdOf(r.json?.lease);
      if (r.status === 200 && r.json?.gap && lid) {
        let lease = db.leases[lid];
        if (!lease || lease.status !== 'held') {
          lease = {
            id: lid,
            raw: r.json.lease,
            gap: r.json.gap,
            kind: hard ? 'hard' : 'normal',
            shard: r.json.shard ?? null,
            shards: r.json.shards ?? null,
            created_at: now(),
            last_beat: now(),
            status: 'held',
          };
          db.leases[lid] = lease;
        }
        const already = workers(lid).find((a) => a.wallet === wallet);
        return view(already || assign(wallet, lease, workers(lid).length > 0));
      }
      if (r.status === 200 && r.json && r.json.gap === null && !holding.length) {
        return { assignment: null, gap: null, message: 'every step is taken right now: wait a few minutes and ask again' };
      }
    }

    // All the steps we may hold are taken: work alongside another member.
    const pool = held().filter((l) => (hard ? true : l.kind === 'normal') && !workers(l.id).some((a) => a.wallet === wallet));
    if (!pool.length) return { assignment: null, gap: null, message: 'no step available right now: wait a few minutes and ask again' };
    pool.sort((x, y) => workers(x.id).length - workers(y.id).length);
    return view(assign(wallet, pool[0], true));
  }

  function get(id, wallet) {
    const a = db.assignments[id];
    if (!a || a.wallet !== wallet) return null;
    return a;
  }

  // A member's agent renews its assignment. The official lease is renewed by
  // maintain() on our side, once for every member working on it.
  function beat(id, wallet) {
    const a = get(id, wallet);
    if (!a) return { status: 404, body: { ok: false, error: 'no such assignment' } };
    const l = db.leases[a.lease];
    if (a.status !== 'active' || !l || l.status !== 'held') {
      return { status: 410, body: { ok: false, error: 'this step was settled or withdrawn: stop and ask for another' } };
    }
    a.last_seen = now();
    store.save();
    return { status: 200, body: { ok: true } };
  }

  async function release(id, wallet, reason, program) {
    const a = get(id, wallet);
    if (!a) return { status: 404, body: { ok: false, error: 'no such assignment' } };
    if (!REASONS.has(reason)) return { status: 400, body: { ok: false, error: `reason must be one of ${[...REASONS].join(', ')}` } };
    if (reason === 'exhausted' && !/^[0-9a-f]{64}$/i.test(program || '')) {
      return { status: 400, body: { ok: false, error: 'exhausted needs program=<sha256 of your search program, 64 hex>' } };
    }
    if (a.status !== 'active') return { status: 200, body: { ok: true, note: 'already closed' } };
    a.status = 'released';
    a.reason = reason;
    const l = db.leases[a.lease];
    if (l && l.status === 'held' && workers(l.id).length === 0) await officialRelease(l, reason, program);
    store.save();
    return { status: 200, body: { ok: true } };
  }

  async function officialRelease(l, reason, program) {
    const q = new URLSearchParams({ lease: l.id, reason });
    if (program) q.set('program', program.toLowerCase());
    try {
      await official('POST', `/desk/release?${q}`);
    } catch (e) {
      console.error('[desk] release failed:', e.message);
    }
    l.status = reason === 'submitted' ? 'submitted' : 'released';
    l.closed_at = now();
    for (const w of workers(l.id)) w.status = 'gone';
  }

  // Renew one lease with the desk right now. false = the step is gone (410).
  async function renewNow(l) {
    const r = await official('POST', `/desk/beat?${new URLSearchParams({ lease: l.id })}`);
    if (r.status === 410) {
      l.status = 'gone';
      l.closed_at = now();
      for (const w of workers(l.id)) w.status = 'gone';
      store.save();
      return false;
    }
    if (r.status >= 200 && r.status < 300) {
      l.last_beat = now();
      store.save();
    }
    return true;
  }

  // Called by the PR bot before it opens a pull request (join.txt step 6:
  // renew once; a 410 means someone else proved it first, so do not send).
  async function beforeSubmit(a) {
    const l = db.leases[a.lease];
    if (!l || l.status !== 'held') return false;
    return renewNow(l);
  }

  async function afterSubmit(a) {
    a.status = 'submitted';
    const l = db.leases[a.lease];
    if (l && l.status === 'held') await officialRelease(l, 'submitted');
    store.save();
  }

  let maintaining = false;
  async function maintain() {
    if (maintaining || !handle) return;
    maintaining = true;
    try {
      const t = Date.now();
      for (const l of held()) {
        const alive = workers(l.id).filter((a) => t - Date.parse(a.last_seen) < D.idleMinutes * 60000);
        if (!alive.length) {
          for (const w of workers(l.id)) { w.status = 'released'; w.reason = 'idle'; }
          await officialRelease(l, 'out_of_time');
          store.save();
          continue;
        }
        if (t - Date.parse(l.last_beat) > D.beatMinutes * 60000) await renewNow(l);
      }
      // Keep the history small: forget closed leases and assignments after a week.
      const old = t - 7 * 86400000;
      for (const [k, l] of Object.entries(db.leases)) if (l.status !== 'held' && Date.parse(l.closed_at || l.created_at) < old) delete db.leases[k];
      for (const [k, a] of Object.entries(db.assignments)) if (a.status !== 'active' && Date.parse(a.created_at) < old && !db.leases[a.lease]) delete db.assignments[k];
    } catch (e) {
      console.error('[desk] maintain failed:', e.message);
    } finally {
      maintaining = false;
    }
  }

  function status() {
    return {
      handle,
      held: held().map((l) => ({ id: l.id, gap: l.gap?.id ?? null, kind: l.kind, since: l.created_at, last_beat: l.last_beat, workers: workers(l.id).map((a) => a.wallet) })),
      max: D.maxLeases,
    };
  }

  return { next, beat, release, get, beforeSubmit, afterSubmit, maintain, status, workers };
}

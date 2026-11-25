// A local stand-in for everything outside our server, for end-to-end tests:
//   /data     the public export of pequalnp.com (head.json, contributors, map, feed, lemma files)
//   /gh       GitHub's REST API: a user's public gists
//   /gistraw  GitHub's gist host: the raw files of those gists
//   /rpc      a Solana JSON-RPC node that verifies signatures and applies System transfers
import http from 'node:http';
import crypto from 'node:crypto';
import { Transaction, SystemProgram, SystemInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { b58encode } from '../lib/units.js';

const RENT_EXEMPT_MIN = 890880n; // lamports a new System account must receive
const FEE = 5000n; // per signature
const hex = (n) => crypto.randomBytes(n).toString('hex');

export function createWorld({ repo = 'open-goat/pequalnp-proofs' } = {}) {
  let port = 0;

  // ---------------------------------------------------------------- export (pequalnp.com)
  const exp = { version: 1, shape: 'object', entries: [], junk: [], lemmaFiles: new Map(), feed: [], failContributors: 0, pr: 11000, requests: [] };
  const entryOf = (github) => {
    let e = exp.entries.find((x) => x.github === github);
    if (!e) exp.entries.push((e = { github, lemmas: [] }));
    return e;
  };
  const provenIds = () => new Set(exp.entries.flatMap((e) => e.lemmas.map((l) => l.id)));
  const statusString = () => {
    const done = provenIds();
    let s = '';
    for (let i = 1; i <= 40; i++) s += done.has(`L-meta-${String(i).padStart(3, '0')}`) ? 'c' : 'j';
    return s;
  };
  function contributorsJson() {
    const list = exp.entries.map((e) => ({
      github: e.github,
      steps: e.lemmas.length,
      first_proof_at: e.lemmas[0]?.at || null,
      lemmas: e.lemmas.map((l) => ({ ...l })),
      last_proof_at: e.lemmas.length ? e.lemmas[e.lemmas.length - 1].at : null,
    }));
    list.push(...exp.junk);
    const steps = exp.entries.reduce((a, e) => a + e.lemmas.length, 0);
    return exp.shape === 'list' ? list : { count: exp.entries.length, steps, by_tool: { other: steps }, contributors: list };
  }

  // ---------------------------------------------------------------- github
  const gh = { users: new Map(), files: new Map(), ids: new Map(), requests: [], raw: [], mode: { rateLimit: 0, rejectToken: false } };
  const userOf = (login) => {
    const k = login.toLowerCase();
    if (!gh.users.has(k)) gh.users.set(k, { login, gists: [] });
    return gh.users.get(k);
  };
  // GitHub's numeric account id: one per account, whatever the username is now.
  const idOf = (login) => {
    const k = login.toLowerCase();
    if (!gh.ids.has(k)) gh.ids.set(k, 1000 + gh.ids.size);
    return gh.ids.get(k);
  };

  // ---------------------------------------------------------------- solana
  const sol = { balances: new Map(), blockhashes: new Map(), sigs: new Map(), t0: Date.now(), mode: { drop: 0, errAfterLand: 0, hideMs: 0, refuse: 0 }, sent: [] };
  const height = () => 1000 + Math.floor((Date.now() - sol.t0) / 50); // 20 blocks a second
  const bal = (k) => sol.balances.get(k) || 0n;

  async function rpc(method, params) {
    switch (method) {
      case 'getLatestBlockhash': {
        const bh = b58encode(crypto.randomBytes(32));
        const lvbh = height() + 150;
        sol.blockhashes.set(bh, lvbh);
        return { result: { context: { slot: height() }, value: { blockhash: bh, lastValidBlockHeight: lvbh } } };
      }
      case 'getBalance':
        return { result: { context: { slot: height() }, value: Number(bal(params[0])) } };
      case 'getBlockHeight':
        return { result: height() };
      case 'getSignatureStatuses': {
        const value = params[0].map((s) => {
          const st = sol.sigs.get(s);
          if (!st || Date.now() - st.landedAt < sol.mode.hideMs) return null;
          return { slot: st.slot, confirmations: null, err: st.err, confirmationStatus: 'confirmed' };
        });
        return { result: { context: { slot: height() }, value } };
      }
      case 'sendTransaction': {
        const tx = Transaction.from(Buffer.from(params[0], 'base64'));
        if (!tx.verifySignatures()) return { error: { code: -32003, message: 'Transaction signature verification failure' } };
        const lv = sol.blockhashes.get(tx.recentBlockhash);
        if (lv === undefined || height() > lv) return { error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found' } };
        if (sol.mode.refuse > 0) { sol.mode.refuse--; return { error: { code: -32002, message: 'Transaction simulation failed: injected refusal' } }; }
        const sig = b58encode(tx.signature);
        if (sol.sigs.has(sig)) return { result: sig }; // the same transaction twice lands once
        const payer = tx.feePayer.toBase58();
        const delta = new Map();
        let out = 0n;
        for (const ix of tx.instructions) {
          if (ix.programId.equals(ComputeBudgetProgram.programId)) continue;
          if (!ix.programId.equals(SystemProgram.programId)) return { error: { code: -32002, message: 'unexpected program' } };
          if (SystemInstruction.decodeInstructionType(ix) !== 'Transfer') return { error: { code: -32002, message: 'unexpected instruction' } };
          const t = SystemInstruction.decodeTransfer(ix);
          if (t.fromPubkey.toBase58() !== payer) return { error: { code: -32002, message: 'transfer not from the fee payer' } };
          const to = t.toPubkey.toBase58();
          const amt = BigInt(t.lamports);
          delta.set(to, (delta.get(to) || 0n) + amt);
          out += amt;
        }
        if (bal(payer) < out + FEE) return { error: { code: -32002, message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit / insufficient funds' } };
        for (const [to, amt] of delta) {
          if (bal(to) === 0n && amt < RENT_EXEMPT_MIN) return { error: { code: -32002, message: `Transaction simulation failed: insufficient funds for rent (${to})` } };
        }
        if (sol.mode.drop > 0) { sol.mode.drop--; return { result: sig }; } // accepted by the node, never lands
        sol.balances.set(payer, bal(payer) - out - FEE);
        for (const [to, amt] of delta) sol.balances.set(to, bal(to) + amt);
        sol.sigs.set(sig, { slot: height(), err: null, landedAt: Date.now() });
        sol.sent.push({ sig, out, recipients: [...delta.keys()] });
        if (sol.mode.errAfterLand > 0) { sol.mode.errAfterLand--; return { http500: true }; } // landed, but the answer is lost
        return { result: sig };
      }
      default:
        return { error: { code: -32601, message: `method ${method} not mocked` } };
    }
  }

  // ---------------------------------------------------------------- server
  const read = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
  const out = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const raw = await read(req);
    const body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw;

    // export
    if (p.startsWith('/data/')) {
      const f = p.slice('/data/'.length);
      exp.requests.push(f);
      if (f === 'head.json') {
        const steps = exp.entries.reduce((a, e) => a + e.lemmas.length, 0);
        return out(res, 200, {
          version: String(exp.version),
          generated_at: new Date().toISOString(),
          counters: { checked: 1000 + steps, lemmas: 2000, checked_last_hour: 10 },
          outside: { count: exp.entries.length, steps },
          agents_now_total: 42, agents_now_fleet: 30, agents_now_public: 12,
          files: { contributors: `data/contributors.v${exp.version}.json`, map: `data/map/overview.v${exp.version}.json`, feed: `data/feed/page.v${exp.version}.json` },
        });
      }
      if (f.startsWith('data/contributors.')) {
        if (exp.failContributors > 0) { exp.failContributors--; return out(res, 500, { error: 'injected failure' }); }
        return out(res, 200, contributorsJson());
      }
      if (f.startsWith('data/map/overview.')) return out(res, 200, { programs: [{ key: 'meta', title: 'Meta-complexity', status: statusString() }] });
      if (f.startsWith('data/feed/page.')) return out(res, 200, { page: 1, prev: null, events: exp.feed.slice(-40).reverse() });
      const m = f.match(/^data\/lemma\/(.+)\.json$/);
      if (m && exp.lemmaFiles.has(decodeURIComponent(m[1]))) return out(res, 200, exp.lemmaFiles.get(decodeURIComponent(m[1])));
      return out(res, 404, { error: 'no such file' });
    }

    // github REST API
    if (p.startsWith('/gh/')) {
      gh.requests.push({ method: req.method, path: p, auth: req.headers.authorization || null });
      const m = p.match(/^\/gh\/users\/([^/]+)\/gists$/);
      if (m && req.method === 'GET') {
        if (gh.mode.rejectToken && req.headers.authorization) return out(res, 401, { message: 'Bad credentials' });
        if (gh.mode.rateLimit > 0) {
          gh.mode.rateLimit--;
          return out(res, 403, { message: 'API rate limit exceeded for 127.0.0.1.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60' });
        }
        const user = gh.users.get(decodeURIComponent(m[1]).toLowerCase());
        if (!user) return out(res, 404, { message: 'Not Found' });
        return out(res, 200, user.gists);
      }
      return out(res, 404, { message: `not mocked: ${req.method} ${p}` });
    }

    // github gist host
    if (p.startsWith('/gistraw/')) {
      gh.raw.push({ host: req.headers.host, path: p });
      const content = gh.files.get(p);
      if (content === undefined) { res.writeHead(404); return res.end('404: Not Found'); }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(content);
    }

    // solana
    if (p === '/rpc' && req.method === 'POST') {
      const calls = Array.isArray(body) ? body : [body];
      const answers = [];
      for (const c of calls) {
        const r = await rpc(c.method, c.params || []);
        if (r.http500) { res.writeHead(500); return res.end('internal error'); }
        answers.push({ jsonrpc: '2.0', id: c.id, ...r });
      }
      return out(res, 200, Array.isArray(body) ? answers : answers[0]);
    }
    out(res, 404, { error: 'unknown mock path' });
  });

  // ---------------------------------------------------------------- controls for the test
  const controls = {
    // The official record credits a lemma to a GitHub handle (accepted at `at`, default now).
    prove(github, id, { at = new Date().toISOString(), title = `step ${id}`, kind = 'helper', prUrl } = {}) {
      const ref = hex(6);
      entryOf(github).lemmas.push({ id, ref, title, at });
      exp.pr++;
      exp.lemmaFiles.set(`${id}.${ref}`, {
        id, kind, program: 'meta_complexity', status: 'checked',
        contributor: { github, pr_url: prUrl || `https://github.com/${repo}/pull/${exp.pr}`, merged_at: at },
      });
      exp.feed.push({ seq: exp.feed.length + 1, at, kind: 'lemma_checked', lemma_id: id, sentence: `the checker accepted ${id}` });
      exp.version++;
      return ref;
    },
    // The official record stops listing a lemma for a handle.
    unprove(github, id) {
      const e = entryOf(github);
      e.lemmas = e.lemmas.filter((l) => l.id !== id);
      exp.version++;
    },
    shape(s) { exp.shape = s; exp.version++; },
    junk(...entries) { exp.junk.push(...entries); exp.version++; },
    failContributors(n) { exp.failContributors = n; },

    // A GitHub account exists (with no gists yet).
    user(login) { userOf(login); },
    // A gist listed on `login`'s account. `owner` may differ (it must then be refused);
    // `ownerId` is the account's numeric id (a username that passed to another account keeps
    // the name but not the id); `isPublic: false` makes it a secret gist; `rawHost` puts the
    // file on another host (it must never be fetched).
    gist(login, content, { owner = login, ownerId = idOf(owner), isPublic = true, createdAt = new Date().toISOString(), filename = 'valiant.txt', description = "Valiant's Conjecture payout address", rawHost = '127.0.0.1', size } = {}) {
      const id = hex(10);
      const rawPath = `/gistraw/${owner}/${id}/raw/${hex(20)}/${filename}`;
      gh.files.set(rawPath, content);
      userOf(login).gists.unshift({
        url: `https://api.github.com/gists/${id}`,
        id,
        html_url: `https://gist.github.com/${owner}/${id}`,
        files: { [filename]: { filename, type: 'text/plain', language: 'Text', raw_url: `http://${rawHost}:${port}${rawPath}`, size: size ?? Buffer.byteLength(content) } },
        public: isPublic,
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        description,
        comments: 0,
        user: null,
        owner: { login: owner, id: ownerId },
        truncated: false,
      });
      return `https://gist.github.com/${owner}/${id}`;
    },
    // Every gist on `login`'s account is gone (for instance, the account was deleted).
    clearGists(login) { userOf(login).gists = []; },

    fund(address, lamports) { sol.balances.set(address, bal(address) + BigInt(lamports)); },
    balance: (address) => bal(address),
  };

  return {
    exp, gh, sol, controls,
    listen: (at = 0) => new Promise((r) => server.listen(at, '127.0.0.1', () => { port = server.address().port; r(port); })),
    close: () => new Promise((r) => server.close(r)),
  };
}

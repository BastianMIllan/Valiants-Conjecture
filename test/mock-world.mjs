// A local stand-in for everything outside our server, for end-to-end tests:
//   /pnp   the pequalnp.com desk (five steps per handle, hard steps beyond)
//   /data  the public export (head.json, contributors, map, feed, lemma files)
//   /gh    the GitHub REST API (fork, branches, contents, pull requests, comments)
//   /rpc   a Solana JSON-RPC node that verifies signatures and applies System transfers
import http from 'node:http';
import crypto from 'node:crypto';
import { Transaction, SystemProgram, SystemInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { b58encode } from '../lib/units.js';

const RENT_EXEMPT_MIN = 890880n; // lamports a new System account must receive
const FEE = 5000n; // per signature

export function createWorld({ handle = 'qed-bot', upstream = 'brilliant-hq/pequalnp-proofs' } = {}) {
  const repoName = upstream.split('/')[1];
  const fork = `${handle}/${repoName}`;

  // ---------------------------------------------------------------- desk
  const desk = { gaps: [], leases: new Map(), calls: [], n: 0 };
  for (let i = 1; i <= 30; i++) {
    const n = 2000 + i;
    desk.gaps.push({
      id: `L-meta-${n}`,
      statement: `∀ n : ℕ, n + ${i} = ${i} + n`,
      file: `lean/PEqualNP/Outside/L_meta_${n}.lean`,
      module: `L_meta_${n}`,
      imports: [],
      context: 'a helper the line of attack needs',
      dead: [],
      hard: i > 25,
    });
  }
  const heldBy = (h) => [...desk.leases.values()].filter((l) => l.handle === h && l.status === 'held');

  // ---------------------------------------------------------------- export
  const exp = { version: 1, others: [{ github: 'someone-else', steps: 3, lemmas: [] }], ours: [], lemmaFiles: new Map(), feed: [] };
  const statusString = () => desk.gaps.map((g) => (exp.ours.some((l) => l.id === g.id) ? 'c' : [...desk.leases.values()].some((l) => l.gap.id === g.id && l.status === 'held') ? 'w' : 'j')).join('');
  function contributorsJson() {
    const list = [...exp.others];
    if (exp.ours.length) list.unshift({ github: handle, steps: exp.ours.length, lemmas: exp.ours });
    return { count: list.length, steps: list.reduce((a, c) => a + c.steps, 0), contributors: list };
  }

  // ---------------------------------------------------------------- github
  const gh = { fork: false, branches: new Map(), prs: [], requests: [] };
  gh.branches.set('main', new Map());

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
  const out = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const q = Object.fromEntries(u.searchParams);
    const raw = await read(req);
    const body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw;

    // desk
    if (p.startsWith('/pnp/desk/')) {
      desk.calls.push({ method: req.method, path: p, q });
      if (p === '/pnp/desk/next') {
        const held = heldBy(q.handle);
        if (held.length && q.another !== '1' && q.hard !== '1') return out(res, 200, { gap: held[0].gap, lease: { id: held[0].id } });
        const normal = held.filter((l) => !l.hard).length;
        if (q.hard !== '1' && normal >= 5) return out(res, 429, { error: 'a handle holds at most five steps' });
        const busy = new Set([...desk.leases.values()].filter((l) => l.status === 'held' || l.status === 'submitted').map((l) => l.gap.id));
        const gap = desk.gaps.find((g) => !busy.has(g.id) && !!g.hard === (q.hard === '1') && !exp.ours.some((l) => l.id === g.id));
        if (!gap) return out(res, 200, { gap: null, lease: null });
        const id = `lease-${++desk.n}`;
        const { hard, ...shown } = gap;
        desk.leases.set(id, { id, handle: q.handle, gap: shown, hard: !!hard, status: 'held', beats: 0 });
        return out(res, 200, { gap: shown, lease: { id, expires_in_s: 1200 } });
      }
      const l = desk.leases.get(q.lease);
      if (p === '/pnp/desk/beat') {
        if (!l || l.status !== 'held') return out(res, 410, { error: 'gone' });
        l.beats++;
        return out(res, 200, { ok: true });
      }
      if (p === '/pnp/desk/release') {
        if (l) { l.status = q.reason === 'submitted' ? 'submitted' : 'released'; l.reason = q.reason; l.program = q.program; }
        return out(res, 200, { ok: true });
      }
    }

    // export
    if (p.startsWith('/data/')) {
      const f = p.slice('/data/'.length);
      if (f === 'head.json') {
        return out(res, 200, {
          version: String(exp.version),
          generated_at: new Date().toISOString(),
          counters: { checked: 1000 + exp.ours.length, lemmas: 2000, checked_last_hour: 10 },
          outside: { count: 1 + (exp.ours.length ? 1 : 0), steps: 3 + exp.ours.length },
          agents_now_total: 42, agents_now_fleet: 30, agents_now_public: 12,
          files: { contributors: `data/contributors.v${exp.version}.json`, map: `data/map/overview.v${exp.version}.json`, feed: `data/feed/page.v${exp.version}.json` },
        });
      }
      if (f.startsWith('data/contributors.')) return out(res, 200, contributorsJson());
      if (f.startsWith('data/map/overview.')) return out(res, 200, { programs: [{ key: 'meta', title: 'Meta-complexity', status: statusString() }] });
      if (f.startsWith('data/feed/page.')) return out(res, 200, { page: 1, prev: null, events: exp.feed.slice(-40).reverse() });
      const m = f.match(/^data\/lemma\/(.+)\.json$/);
      if (m && exp.lemmaFiles.has(decodeURIComponent(m[1]))) return out(res, 200, exp.lemmaFiles.get(decodeURIComponent(m[1])));
      return out(res, 404, { error: 'no such file' });
    }

    // github
    if (p.startsWith('/gh/')) {
      gh.requests.push({ method: req.method, path: p, body });
      if (req.headers.authorization !== 'Bearer test-token') return out(res, 401, { message: 'Bad credentials' });
      const g = p.slice(3);
      if (g === `/repos/${upstream}` && req.method === 'GET') return out(res, 200, { default_branch: 'main' });
      if (g === `/repos/${fork}` && req.method === 'GET') return gh.fork ? out(res, 200, { full_name: fork }) : out(res, 404, { message: 'Not Found' });
      if (g === `/repos/${upstream}/forks` && req.method === 'POST') { gh.fork = true; return out(res, 202, { full_name: fork }); }
      if (g === `/repos/${fork}/merge-upstream`) return out(res, 200, { message: 'up to date' });
      if (g === `/repos/${fork}/git/ref/heads/main`) return out(res, 200, { object: { sha: 'base0' } });
      if (g === `/repos/${fork}/git/refs` && req.method === 'POST') {
        const b = body.ref.replace('refs/heads/', '');
        if (gh.branches.has(b)) return out(res, 422, { message: 'Reference already exists' });
        gh.branches.set(b, new Map());
        return out(res, 201, { ref: body.ref });
      }
      let m = g.match(new RegExp(`^/repos/${fork}/contents/(.+)$`));
      if (m) {
        const filePath = decodeURIComponent(m[1]);
        if (req.method === 'GET') {
          const files = gh.branches.get(q.ref);
          const f = files?.get(filePath);
          return f ? out(res, 200, { sha: f.sha, content: Buffer.from(f.content).toString('base64') }) : out(res, 404, { message: 'Not Found' });
        }
        if (req.method === 'PUT') {
          const files = gh.branches.get(body.branch);
          if (!files) return out(res, 404, { message: 'Branch not found' });
          const cur = files.get(filePath);
          if (cur && body.sha !== cur.sha) return out(res, 409, { message: 'sha does not match' });
          if (!cur && body.sha) return out(res, 422, { message: 'sha given for a new file' });
          const content = Buffer.from(body.content, 'base64').toString('utf8');
          const sha = crypto.createHash('sha1').update(content).digest('hex');
          files.set(filePath, { content, sha, commits: (cur?.commits || 0) + 1, message: body.message });
          return out(res, cur ? 200 : 201, { content: { sha } });
        }
      }
      if (g === `/repos/${upstream}/pulls` && req.method === 'POST') {
        const number = gh.prs.length + 1;
        const branch = body.head.split(':')[1];
        const pr = { number, title: body.title, head: body.head, base: body.base, body: body.body, branch, html_url: `https://github.com/${upstream}/pull/${number}`, merged: false, state: 'open', comments: [] };
        gh.prs.push(pr);
        return out(res, 201, { number, html_url: pr.html_url });
      }
      m = g.match(new RegExp(`^/repos/${upstream}/issues/(\\d+)/comments$`));
      if (m) { const pr = gh.prs[+m[1] - 1]; return out(res, 200, pr ? pr.comments : []); }
      m = g.match(new RegExp(`^/repos/${upstream}/pulls/(\\d+)$`));
      if (m) { const pr = gh.prs[+m[1] - 1]; return pr ? out(res, 200, { merged: pr.merged, state: pr.state }) : out(res, 404, { message: 'Not Found' }); }
      return out(res, 404, { message: `not mocked: ${req.method} ${g}` });
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
    // The official checker accepts a pull request: merged, credited to our handle in the export.
    accept(number) {
      const pr = gh.prs[number - 1];
      const files = gh.branches.get(pr.branch);
      const [filePath, f] = [...files.entries()][0];
      const id = pr.title;
      const ref = crypto.randomBytes(6).toString('hex');
      const at = new Date().toISOString();
      exp.ours.push({ id, ref, title: `step ${id}`, at });
      exp.lemmaFiles.set(`${id}.${ref}`, {
        id, kind: 'helper', program: 'meta_complexity', status: 'checked',
        artifact: { lean_file: filePath, content_hash: `sha256:${crypto.createHash('sha256').update(f.content).digest('hex')}` },
        contributor: { github: handle, pr_url: pr.html_url, merged_at: at },
      });
      exp.feed.push({ seq: exp.feed.length + 1, at, kind: 'lemma_checked', lemma_id: id, sentence: `the checker accepted ${id}` });
      pr.merged = true;
      pr.state = 'closed';
      pr.comments.push({ body: 'Verdict: ACCEPTED (run 1)', html_url: `${pr.html_url}#c1`, created_at: at });
      exp.version++;
    },
    reject(number) {
      const pr = gh.prs[number - 1];
      pr.comments.push({ body: 'Verdict: REJECTED: does not elaborate', html_url: `${pr.html_url}#c0`, created_at: new Date().toISOString() });
    },
    // A lemma credited to our handle from a pull request we did not open through the app.
    creditForeign(id) {
      const ref = crypto.randomBytes(6).toString('hex');
      exp.ours.push({ id, ref, title: `foreign ${id}`, at: new Date().toISOString() });
      exp.lemmaFiles.set(`${id}.${ref}`, { id, kind: 'helper', contributor: { github: handle, pr_url: `https://github.com/${upstream}/pull/999` } });
      exp.version++;
    },
    fund(address, lamports) { sol.balances.set(address, bal(address) + BigInt(lamports)); },
    balance: (address) => bal(address),
  };

  return {
    desk, gh, sol, exp, controls,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(r)),
  };
}

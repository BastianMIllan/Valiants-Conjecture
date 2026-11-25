// Reader for the official public export of pequalnp.com (data.pequalnp.com).
// It is the only source of truth for credit: we never judge a proof ourselves.
// head.json is small and polled; every other file is immutable (its name is its
// content hash), so it is fetched only when head.json names a new one. The
// contributors record (who proved what, by GitHub handle) is fetched at most every
// few minutes, and the last good copy is kept whenever a fetch fails.
import { fetchText } from './http.js';
import { isGithubLogin } from './verify.js';

const HEADERS = { 'user-agent': 'valiant-conjecture-reader/2.0 (reads the public export)', accept: 'application/json' };
const LEMMA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const isoOf = (v) => {
  const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
// Paths named by head.json: relative, plain characters, never leaving the export.
const safeRel = (p) => typeof p === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(p) && !p.split('/').includes('..');

// The record comes as a list of entries or as { contributors: [...] }. Each entry:
// { github, steps, lemmas: [{ id, ref, title, at }], last_proof_at }. Entries without
// a valid handle, and lemmas without a valid id or time, are skipped; a handle listed
// twice is merged.
export function parseContributors(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.contributors) ? raw.contributors : null;
  if (!list) throw new Error('contributors record: unexpected shape');
  const byHandle = new Map();
  let skipped = 0;
  let steps = 0;
  for (const x of list) {
    const github = x && typeof x === 'object' && typeof x.github === 'string' ? x.github.trim() : '';
    if (!isGithubLogin(github)) { skipped++; continue; }
    const key = github.toLowerCase();
    let e = byHandle.get(key);
    if (!e) byHandle.set(key, (e = { github, steps: 0, lemmas: [], ids: new Set(), last_proof_at: null }));
    const before = e.lemmas.length;
    for (const l of Array.isArray(x.lemmas) ? x.lemmas : []) {
      const id = l && typeof l.id === 'string' ? l.id.trim() : '';
      const at = l ? isoOf(l.at) : null;
      if (!LEMMA_ID.test(id) || !at) { skipped++; continue; }
      if (e.ids.has(id)) continue;
      e.ids.add(id);
      const ref = typeof l.ref === 'string' || (typeof l.ref === 'number' && Number.isFinite(l.ref)) ? String(l.ref).slice(0, 200) : null;
      e.lemmas.push({ id, ref, title: typeof l.title === 'string' ? l.title.slice(0, 400) : '', at });
    }
    const listed = Number.isFinite(+x.steps) && +x.steps >= 0 ? Math.floor(+x.steps) : 0;
    e.steps += Math.max(listed, e.lemmas.length - before);
    const lp = isoOf(x.last_proof_at);
    if (lp && (!e.last_proof_at || lp > e.last_proof_at)) e.last_proof_at = lp;
  }
  for (const e of byHandle.values()) steps += e.steps;
  return { byHandle, count: byHandle.size, steps, skipped };
}

export function createPnp({ config }) {
  const BASE = config.pnp.data;
  const state = {
    head: null,
    contributors: null, // { count, steps, skipped } of the copy in use
    byHandle: new Map(), // lower(handle) -> { github, steps, lemmas, ids, last_proof_at }
    byLemma: new Map(), // lemma id -> handle (as written officially)
    map: null,
    feed: [],
    files: {},
    lastOk: null, // last time head.json was read
    lastErr: null,
    contributorsAt: null, // when the copy in use was fetched
    contributorsErr: null,
  };
  let triedAt = 0;

  async function getJSON(rel, { timeoutMs = 30000, maxBytes = 64 << 20 } = {}) {
    const r = await fetchText(new URL(rel, BASE), { headers: HEADERS, timeoutMs, maxBytes });
    if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
    try {
      return JSON.parse(r.text);
    } catch {
      throw new Error(`${rel}: not valid JSON`);
    }
  }

  async function loadContributors(rel) {
    const parsed = parseContributors(await getJSON(rel));
    const byLemma = new Map();
    for (const e of parsed.byHandle.values()) for (const l of e.lemmas) if (!byLemma.has(l.id)) byLemma.set(l.id, e.github);
    Object.assign(state, {
      byHandle: parsed.byHandle,
      byLemma,
      contributors: { count: parsed.count, steps: parsed.steps, skipped: parsed.skipped },
      contributorsAt: new Date().toISOString(),
      contributorsErr: null,
    });
    state.files.contributors = rel;
  }

  // force: fetch a new contributors record now, whatever the refresh interval says.
  async function sync({ force = false } = {}) {
    let head;
    try {
      head = await getJSON('head.json', { maxBytes: 4 << 20 });
      if (!head || typeof head !== 'object') throw new Error('head.json: unexpected shape');
    } catch (e) {
      state.lastErr = `${new Date().toISOString()} ${e.message}`;
      console.error('[pnp] sync failed:', e.message);
      return { ok: false, contributorsChanged: false };
    }
    const f = head.files && typeof head.files === 'object' ? head.files : {};
    const errs = [];
    let contributorsChanged = false;

    if (safeRel(f.contributors) && f.contributors !== state.files.contributors) {
      if (force || Date.now() - triedAt >= config.pnp.contributorsSeconds * 1000) {
        triedAt = Date.now();
        try {
          await loadContributors(f.contributors);
          contributorsChanged = true;
        } catch (e) {
          // Keep the last good copy.
          state.contributorsErr = `${new Date().toISOString()} ${e.message}`;
          errs.push(e.message);
        }
      }
    }

    if (safeRel(f.map) && f.map !== state.files.map) {
      try {
        state.map = await getJSON(f.map);
        state.files.map = f.map;
      } catch (e) {
        errs.push(e.message);
      }
    }

    if (safeRel(f.feed) && f.feed !== state.files.feed) {
      try {
        const page = await getJSON(f.feed);
        let events = Array.isArray(page?.events) ? page.events : [];
        if (events.length < 40 && safeRel(page?.prev)) {
          try {
            const older = await getJSON(page.prev);
            if (Array.isArray(older?.events)) events = events.concat(older.events);
          } catch {
            /* the newest page alone is fine */
          }
        }
        state.feed = events.filter((e) => e && typeof e === 'object').slice(0, 60);
        state.files.feed = f.feed;
      } catch (e) {
        errs.push(e.message);
      }
    }

    state.head = head;
    state.lastOk = new Date().toISOString();
    state.lastErr = errs.length ? `${state.lastOk} ${errs.join('; ')}` : null;
    if (errs.length) console.error('[pnp] partial sync:', errs.join('; '));
    return { ok: true, contributorsChanged };
  }

  // One lemma's own file: its kind and the pull request it was merged from.
  const lemma = (id, ref) => getJSON(`data/lemma/${encodeURIComponent(id)}.${encodeURIComponent(ref)}.json`, { timeoutMs: 20000, maxBytes: 2 << 20 });

  return { state, sync, lemma };
}

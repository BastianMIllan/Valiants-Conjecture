// Reader for the official public export of pequalnp.com (data.pequalnp.com).
// It is the only source of truth for credit: we never judge a proof ourselves.
// head.json is small and polled; every other file is immutable (its name is its
// content hash), so it is fetched only when head.json names a new one.
import config from '../config.js';

const BASE = config.pnp.data;
const HEADERS = { 'user-agent': 'collective-reader/1.0 (reads the public export)', accept: 'application/json' };

async function getJSON(rel, fresh = false) {
  const r = await fetch(new URL(rel, BASE), {
    headers: HEADERS,
    cache: fresh ? 'no-cache' : 'default',
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
  return r.json();
}

export function lemmaIdFor(programKey, index) {
  // Status strings in the map list a program's nodes in order, node n at index n-1.
  return `L-${programKey}-${String(index + 1).padStart(3, '0')}`;
}

export function createPnp() {
  const state = {
    head: null,
    contributors: null,
    byHandle: new Map(), // lower(handle) -> contributor entry
    byLemma: new Map(), // lemma id -> handle (as written officially)
    map: null,
    feed: [],
    files: {},
    lastOk: null,
    lastErr: null,
  };

  async function sync() {
    try {
      const head = await getJSON('head.json', true);
      const f = head.files || {};

      if (f.contributors && f.contributors !== state.files.contributors) {
        const c = await getJSON(f.contributors);
        const byHandle = new Map();
        const byLemma = new Map();
        for (const x of c.contributors || []) {
          if (!x || !x.github) continue;
          byHandle.set(x.github.toLowerCase(), x);
          for (const l of x.lemmas || []) byLemma.set(l.id, x.github);
        }
        Object.assign(state, { contributors: c, byHandle, byLemma });
        state.files.contributors = f.contributors;
      }

      if (f.map && f.map !== state.files.map) {
        state.map = await getJSON(f.map);
        state.files.map = f.map;
      }

      if (f.feed && f.feed !== state.files.feed) {
        const page = await getJSON(f.feed);
        let events = page.events || [];
        if (events.length < 40 && page.prev) {
          try {
            events = events.concat((await getJSON(page.prev)).events || []);
          } catch {
            /* the newest page alone is fine */
          }
        }
        state.feed = events.slice(0, 60);
        state.files.feed = f.feed;
      }

      state.head = head;
      state.lastOk = new Date().toISOString();
      state.lastErr = null;
      return true;
    } catch (e) {
      state.lastErr = `${new Date().toISOString()} ${e.message}`;
      console.error('[pnp] sync failed:', e.message);
      return false;
    }
  }

  const lemma = (id, ref) => getJSON(`data/lemma/${encodeURIComponent(id)}.${encodeURIComponent(ref)}.json`);

  return { state, sync, lemma };
}

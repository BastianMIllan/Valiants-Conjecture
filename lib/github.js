// Proof that a GitHub account belongs to the person registering it: a public gist on
// that account holding the exact line "<tag> wallet: <Solana address>". Only the owner
// of an account can publish a gist on it. Read-only use of GitHub's public REST API;
// gist contents are read only from GitHub's gist host (no other host is ever fetched).
import { fetchText, TooLarge } from './http.js';
import { gistLineOf } from './verify.js';

const MAX_LIST = 4 << 20; // the list of a user's gists (100 per page)
const MAX_FILE = 64 * 1024; // one gist file: the line is short
const MAX_FILES_READ = 12; // files read per check, preferred ones first

export function createGithub({ config }) {
  const { api, token, gistTag } = config.github;
  const raw = new URL(config.github.gistRaw);
  const base = {
    accept: 'application/vnd.github+json',
    'user-agent': 'valiant-conjecture-verifier/2.0',
    'x-github-api-version': '2022-11-28',
  };
  // A token GitHub refuses (401: revoked or expired) is dropped until the next restart.
  // Gists are public, so checks go on without it, at GitHub's lower rate limit.
  let tokenRefused = false;
  const headers = () => (token && !tokenRefused ? { ...base, authorization: `Bearer ${token}` } : base);
  const line = (wallet) => gistLineOf(gistTag, wallet);
  const limitedMsg = 'GitHub is limiting how often we can check right now. Try again in a few minutes.';
  const unreachableMsg = 'Could not reach GitHub to check your gist. Try again in a few minutes.';

  // A gist file's raw address must be on the gist host, under the account being checked.
  function rawAllowed(url, login) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== raw.protocol || u.host !== raw.host || u.username || u.password) return false;
    if (!u.pathname.startsWith(raw.pathname)) return false;
    let owner = '';
    try { owner = decodeURIComponent(u.pathname.slice(raw.pathname.length).split('/')[0]); } catch { return false; }
    return owner.toLowerCase() === login.toLowerCase();
  }

  const hasLine = (text, want) => text.replace(/^﻿/, '').split(/\r?\n/).some((l) => l.trim() === want);

  async function listGists(login) {
    const url = `${api}/users/${encodeURIComponent(login)}/gists?per_page=100`;
    const r = await fetchText(url, { headers: headers(), timeoutMs: 15000, maxBytes: MAX_LIST });
    if (r.status !== 401 || !token || tokenRefused) return r;
    tokenRefused = true;
    console.error('[github] GitHub refused GITHUB_TOKEN (401): gist checks go on without it. Replace the token and restart.');
    return fetchText(url, { headers: headers(), timeoutMs: 15000, maxBytes: MAX_LIST });
  }

  // { ok: true, login (as GitHub writes it), githubId, gist: { id, url, file } }
  // or { ok: false, status, error }.
  // notBefore (ms): only gists created after that moment count. A wallet change passes the
  // time of the member's last change, so an old gist that still names an earlier wallet can
  // never move them back to it.
  async function verifyGist(login, wallet, { notBefore = null } = {}) {
    const want = line(wallet);
    const lower = login.toLowerCase();
    const since = Number.isFinite(notBefore) ? notBefore : null;
    let r;
    try {
      r = await listGists(login);
    } catch (e) {
      return { ok: false, status: 502, error: e instanceof TooLarge ? 'GitHub sent an unexpectedly large answer. Try again later.' : unreachableMsg };
    }
    if (r.status === 404) return { ok: false, status: 404, error: `GitHub has no user @${login}. Check the spelling of your GitHub username.` };
    if (r.status === 403 || r.status === 429) return { ok: false, status: 503, error: limitedMsg, retry: true };
    if (!r.ok) return { ok: false, status: 502, error: unreachableMsg };
    let gists;
    try { gists = JSON.parse(r.text); } catch { gists = null; }
    if (!Array.isArray(gists)) return { ok: false, status: 502, error: unreachableMsg };

    // Files of public gists owned by this very account, the likeliest ones first.
    const preferred = `${gistTag.split('-')[0]}.txt`.toLowerCase();
    const tagWord = gistTag.split('-')[0].toLowerCase();
    const candidates = [];
    for (const g of gists) {
      if (!g || typeof g !== 'object' || g.public === false) continue;
      if (since !== null && !(Date.parse(g.created_at) > since)) continue;
      const owner = typeof g.owner?.login === 'string' ? g.owner.login : '';
      if (owner.toLowerCase() !== lower) continue;
      const described = typeof g.description === 'string' && g.description.toLowerCase().includes(tagWord);
      for (const f of Object.values(g.files && typeof g.files === 'object' ? g.files : {})) {
        if (!f || typeof f.raw_url !== 'string') continue;
        if (Number.isFinite(f.size) && f.size > MAX_FILE) continue;
        const name = String(f.filename || '').toLowerCase();
        const rank = name === preferred ? 0 : described || name.includes(tagWord) ? 1 : 2;
        const url = typeof g.html_url === 'string' && /^https:\/\/gist\.github\.com\/[\w.-]+\/[\w-]+$/.test(g.html_url) ? g.html_url : null;
        const ownerId = Number.isSafeInteger(g.owner?.id) ? g.owner.id : null;
        candidates.push({ rank, owner, ownerId, id: String(g.id || '').slice(0, 64), url, file: typeof f.filename === 'string' ? f.filename.slice(0, 200) : null, raw: f.raw_url });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank); // stable: newest gists first within a rank

    let read = 0;
    for (const c of candidates) {
      if (read >= MAX_FILES_READ) break;
      if (!rawAllowed(c.raw, login)) continue;
      read++;
      let f;
      try {
        f = await fetchText(c.raw, { headers: { 'user-agent': base['user-agent'] }, timeoutMs: 10000, maxBytes: MAX_FILE, redirect: 'error' });
      } catch {
        continue;
      }
      if (f.status === 403 || f.status === 429) return { ok: false, status: 503, error: limitedMsg, retry: true };
      if (!f.ok) continue;
      if (hasLine(f.text, want)) return { ok: true, login: c.owner, githubId: c.ownerId, gist: { id: c.id, url: c.url, file: c.file } };
    }
    if (since === null) return { ok: false, status: 422, error: `No public gist on @${login} contains the line: ${want}` };
    const when = new Date(since).toISOString().slice(0, 16).replace('T', ' ');
    return { ok: false, status: 422, fresh: true, error: `No public gist on @${login} created after your last wallet change (${when} UTC) contains the line: ${want}` };
  }

  // 'ok', 'refused' (GitHub answered 401 to it) or 'none'.
  const tokenState = () => (!token ? 'none' : tokenRefused ? 'refused' : 'ok');
  return { verifyGist, line, tokenSet: !!token, tokenState };
}

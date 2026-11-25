// The live mirror's snapshot, built on the founder's machine from the operator dashboard's status
// (tools/live-publisher.mjs runs it), and the exact bytes that are signed and posted to the site.
// Only the fields named in buildSnapshot are read, and the result goes through the same whitelist
// the site applies (lib/live.js): no other field can leave the machine.
import crypto from 'node:crypto';
import { cleanSnapshot, prPattern, STEP_ID, DEFAULT_REPO, MAX_BYTES } from './live.js';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(plain) : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
const ms = (v) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && Math.abs(t) < 8.64e15 ? t : null;
};
const iso = (v) => {
  const t = ms(v);
  return t === null ? null : new Date(t).toISOString();
};

// The one kind of activity line that is published, rewritten as { at, step, url }:
//   "Pull request sent as <account> for <step id> (<why>): <pull request address>"
// The step id follows STEP_ID (lib/live.js). Every other line (work in progress, held or staged
// proofs, health, files) stays private.
const PR_SENT = /^Pull request sent\b[^\n]*?\bfor (L-[A-Za-z]{1,16}-[0-9]{1,7})\b[^\n]*?:\s*(\S+)\s*$/;
function prSent(a, PR) {
  const m = typeof a.text === 'string' ? a.text.slice(0, 600).match(PR_SENT) : null;
  return m && STEP_ID.test(m[1]) && PR.test(m[2]) ? { at: iso(a.at), step: m[1], url: m[2] } : null;
}

// The dashboard status -> the public snapshot: only what /live shows. Never included: the steps
// being worked on or held and their statements, the held count, the engine's limits, pace, policy,
// uploads, health, resends and blocked counts, the pause state, the setup, any path or token.
export function buildSnapshot(status, { repo = DEFAULT_REPO } = {}) {
  const s = plain(status) ? status : {};
  const PR = prPattern(repo);
  const prNo = (u) => (typeof u === 'string' && PR.test(u) ? Number(u.slice(u.lastIndexOf('/') + 1)) : 0);
  const newest = (x, y) => (ms(y.at) ?? 0) - (ms(x.at) ?? 0) || prNo(y.url) - prNo(x.url);
  const counts = plain(s.counts) ? s.counts : {};
  const rank = plain(s.rank) ? s.rank : {};
  const board = plain(s.board) ? s.board : {};
  const engine = plain(s.engine) ? s.engine : {};
  const pick = (o, k) => (plain(o) ? num(o[k]) : null);

  // Accepted by the official checker: merged, or accepted and being merged.
  const accepted = list(s.accepted).map((a) => {
    const merged = a.merged === true;
    return { id: a.id, title: a.title, url: a.url, at: iso(a.acceptedAt ?? a.mergedAt ?? a.sentAt), merged_at: merged ? iso(a.mergedAt) : null, state: merged ? 'merged' : 'accepted' };
  }).sort(newest);
  // Open, waiting for the checker: newest first by number (one just opened may have no time yet).
  const waiting = list(s.waiting).map((w) => ({ id: w.id, title: w.title, url: w.url, at: iso(w.sentAt) })).sort((x, y) => prNo(y.url) - prNo(x.url));
  const activity = list(s.activity).map((a) => prSent(a, PR)).filter(Boolean).sort(newest);
  const top = list(board.top).map((r) => ({ github: r.github, steps: num(r.all ?? r.steps), hour: num(r.hour) })).sort((x, y) => (y.steps ?? -1) - (x.steps ?? -1));

  return cleanSnapshot({
    account: s.account,
    start: iso(s.start),
    end: iso(s.end),
    counts: { accepted: num(counts.accepted), merging: num(counts.merging), prs: num(counts.prs), checking: Array.isArray(s.waiting) ? s.waiting.length : null },
    rank: { hour: num(rank.hour), all: num(rank.all), ahead: num(rank.ahead), steps_all: num(rank.steps_all), steps_hour: num(rank.steps_hour) },
    board: { agents: num(board.agents), top },
    accepted,
    waiting,
    ready: num(s.ready),
    engine: { sentHour: pick(engine.sender, 'sentHour') },
    activity,
  }, { repo });
}

// The exact bytes to post and their signature. Far below the size limit in practice; should it
// ever grow past it, the longest lists are shortened until it fits.
export function signedBody(snapshot, privateKey, at = new Date()) {
  const wrap = (snap) => Buffer.from(JSON.stringify({ v: 1, at: at.toISOString(), snapshot: snap }));
  let snap = snapshot;
  let body = wrap(snap);
  while (body.length > MAX_BYTES && (snap.waiting.length > 1 || snap.accepted.length > 1 || snap.activity.length > 1)) {
    const half = (a) => a.slice(0, Math.floor(a.length / 2));
    snap = { ...snap, waiting: half(snap.waiting), accepted: half(snap.accepted), activity: half(snap.activity) };
    body = wrap(snap);
  }
  return { body, signature: crypto.sign(null, body, privateKey).toString('base64') };
}

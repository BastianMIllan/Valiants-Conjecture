// The founder's run, live: a read-only mirror of the operator dashboard, read from /api/live.
// Every string from the snapshot is escaped, and only pull request and GitHub profile addresses
// that match the patterns below are ever used as links. The server keeps only pull requests on
// the official repository (PNP_REPO), so the page does not name it.
import { $, $$, esc, fmt, hhmmss, ymd, countTo, avatarImg } from '/ui.js';

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/;
const PROFILE_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REFRESH_MS = 20_000;
const OFFLINE_S = 5 * 60; // older than this, the mirror says it is offline
const FIRST_ROWS = 25; // rows shown before "Show all"

const prHref = (u) => (typeof u === 'string' && PR_URL.test(u) ? u : null);
const profileHref = (login) => {
  if (typeof login !== 'string' || !LOGIN.test(login)) return null;
  const u = `https://github.com/${login}`;
  return PROFILE_URL.test(u) ? u : null;
};
const prNo = (href) => href.slice(href.lastIndexOf('/') + 1);
const out = (href, html, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
const n = (v) => (Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const str = (v) => (typeof v === 'string' ? v : '');
const pad2 = (v) => String(v).padStart(2, '0');

let live = null; // the last answer: { at, age_s, snapshot } or { at: null, configured }
let etag = ''; // its ETag: while the snapshot is unchanged, the server answers 304
let gotAt = 0; // performance.now() when it arrived
let failing = false; // the last refresh failed
let lastTry = 0;
let tab = 'accepted';
const expanded = { accepted: false, waiting: false };

// Times are measured from the snapshot's own clock: a viewer's wrong clock changes nothing.
const ageS = () => (live?.at ? live.age_s + (performance.now() - gotAt) / 1000 : null);
const nowMs = () => (live?.at ? Date.parse(live.at) + ageS() * 1000 : Date.now());

function since(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, (nowMs() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function span(msec) {
  const m = Math.max(0, Math.floor(msec / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${pad2(m % 60)}m` : `${m}m`;
}
const timeTag = (iso, prefix = '') => (Number.isFinite(Date.parse(iso))
  ? `<time datetime="${esc(iso)}" data-at="${esc(iso)}" data-prefix="${esc(prefix)}" title="${esc(ymd(iso))} UTC">${esc(prefix + since(iso))}</time>`
  : '');

// ------------------------------------------------------------------ status line and banner
function setStatus(word, detail, mode) {
  $('#l-state').textContent = word;
  $('#l-age').textContent = detail;
  $('#l-status').dataset.mode = mode;
  $('#l-dot').classList.toggle('stale', mode !== 'on');
  $('.top .live .dot')?.classList.toggle('stale', mode !== 'on');
}
// Changed only when the state changes: it is announced to screen readers.
function banner(mode, text) {
  const b = $('#l-banner');
  const t = text || '';
  if (b.textContent === t && b.hidden === !mode) return;
  b.hidden = !mode;
  b.className = `lbanner ${mode || ''}`;
  b.textContent = t;
}
function renderStatus() {
  const retry = failing ? ' · server not reachable, retrying' : '';
  if (!live) {
    setStatus('CONNECTING', failing ? 'the server is not reachable, retrying' : 'reaching the live mirror', 'wait');
    return;
  }
  if (!live.at) {
    document.body.classList.remove('offline');
    document.body.classList.add('empty');
    if (live.configured === false) {
      setStatus('NOT CONFIGURED', `the live mirror is off on this server${retry}`, 'wait');
      banner('wait', 'The live mirror is not configured on this server, so there is no run to show.');
      return;
    }
    setStatus('WAITING', `no snapshot yet${retry}`, 'wait');
    banner('wait', 'No snapshot yet: the live mirror is waiting for the first report from the operator dashboard. This page refreshes on its own.');
    return;
  }
  document.body.classList.remove('empty');
  const age = ageS();
  const off = age > OFFLINE_S;
  document.body.classList.toggle('offline', off);
  if (off) {
    const mins = Math.floor(age / 60);
    const ago = mins < 120 ? `${mins} min` : `${Math.floor(mins / 60)} h`;
    setStatus('OFFLINE', `last report ${ago} ago${retry}`, 'off');
    banner('off', `Offline: the operator dashboard has stopped reporting. Below is the last state it sent, from ${ymd(live.at)} UTC.`);
  } else {
    setStatus('LIVE', `updated ${age < 120 ? `${Math.floor(age)} s` : `${Math.floor(age / 60)} min`} ago${retry}`, 'on');
    banner(null);
  }
}

// ------------------------------------------------------------------ figures and run clock
function renderTiles(s) {
  const c = s.counts && typeof s.counts === 'object' ? s.counts : {};
  const r = s.rank && typeof s.rank === 'object' ? s.rank : {};
  const acc = arr(s.accepted);
  const has = !!live?.at; // with no snapshot yet, every figure reads "—"
  const merged = n(c.accepted) ?? (has ? acc.filter((a) => a.state === 'merged').length : null);
  const merging = n(c.merging) ?? (has ? acc.filter((a) => a.state === 'accepted').length : 0);
  countTo($('#t-accepted'), merged);
  $('#t-accepted-s').textContent = merging ? `${fmt(merging)} more accepted, being merged` : 'merged on the official repository';
  countTo($('#t-prs'), n(c.prs));
  const sentHour = n(s.engine?.sentHour);
  $('#t-prs-s').textContent = sentHour !== null ? `${fmt(sentHour)} in the last hour` : 'opened on the official repository';
  countTo($('#t-checking'), n(c.checking) ?? (has ? arr(s.waiting).length : null));
  countTo($('#t-ready'), n(s.ready));
  $('#t-hour').textContent = n(r.hour) !== null ? `#${fmt(r.hour)}` : '—';
  $('#t-hour-s').textContent = n(r.steps_hour) !== null ? `${fmt(r.steps_hour)} accepted this hour` : 'rank on the official board';
  $('#t-all').textContent = n(r.all) !== null ? `#${fmt(r.all)}` : '—';
  const ahead = n(r.ahead);
  const total = n(r.steps_all) !== null ? ` · ${fmt(r.steps_all)} proofs` : '';
  $('#t-all-s').textContent = ahead === null ? 'rank on the official board' : ahead === 0 ? `nobody ahead${total}` : `${fmt(ahead)} ${ahead === 1 ? 'person' : 'people'} ahead${total}`;
}

function renderRun() {
  const s = live?.snapshot;
  const st = Date.parse(s?.start);
  const box = $('#l-run');
  if (!live?.at || !Number.isFinite(st)) { box.hidden = true; return; }
  box.hidden = false;
  const en = Date.parse(s.end);
  const now = nowMs();
  $('#r-start').innerHTML = `started <b>${esc(ymd(s.start))}</b> UTC`;
  if (Number.isFinite(en) && en > st) {
    const done = Math.min(1, Math.max(0, (now - st) / (en - st)));
    $('#r-barwrap').hidden = false;
    $('#r-bar').style.width = `${(done * 100).toFixed(2)}%`;
    $('#r-elapsed').innerHTML = `<b>${esc(span(Math.min(now, en) - st))}</b> in`;
    $('#r-left').innerHTML = now < en ? `<b>${esc(span(en - now))}</b> left · ends ${esc(ymd(s.end))} UTC` : `ended ${esc(ymd(s.end))} UTC`;
  } else {
    $('#r-barwrap').hidden = true;
    $('#r-elapsed').innerHTML = `running for <b>${esc(span(now - st))}</b>`;
    $('#r-left').textContent = '';
  }
}

// ------------------------------------------------------------------ accepted and checking lists
function row(x, kind) {
  const href = prHref(x.url);
  const id = str(x.id);
  if (!href || !id) return '';
  const badge = kind === 'waiting'
    ? '<span class="badge no">checking</span>'
    : x.state === 'merged' ? '<span class="badge yes">merged</span>' : '<span class="badge paid">accepted · merging</span>';
  const when = kind === 'waiting' ? timeTag(x.at, 'opened ') : timeTag(x.at);
  const title = str(x.title) ? `<p class="ltitle">${esc(x.title)}</p>` : '';
  return `<li class="lrow"><div class="lrow-h"><b class="lid">${esc(id)}</b>${badge}<span class="lrow-r">${when}${out(href, `#${esc(prNo(href))} ↗`, 'lpr')}</span></div>${title}</li>`;
}
// How many the run has: a snapshot lists only the newest 100 accepted and 150 checking.
function totalOf(s, kind) {
  const c = s.counts && typeof s.counts === 'object' ? s.counts : {};
  if (kind === 'waiting') return n(c.checking);
  return n(c.accepted) === null && n(c.merging) === null ? null : (n(c.accepted) ?? 0) + (n(c.merging) ?? 0);
}
function renderList(kind, s) {
  const all = arr(s[kind]).map((x) => row(x, kind)).filter(Boolean);
  const total = Math.max(all.length, totalOf(s, kind) ?? 0);
  const shown = expanded[kind] ? all : all.slice(0, FIRST_ROWS);
  const rest = expanded[kind] && total > all.length ? `<li class="lnote">The newest ${fmt(all.length)} of ${fmt(total)} are listed here.</li>` : '';
  $(`#l-${kind}`).innerHTML = shown.length
    ? shown.join('') + rest
    : `<li class="lempty">${kind === 'waiting' ? 'No pull request is waiting for the official checker right now.' : 'No accepted proof in this snapshot yet.'}</li>`;
  $(`#n-${kind}`).textContent = fmt(total);
  const more = $(`[data-more="${kind}"]`);
  more.hidden = all.length <= FIRST_ROWS;
  more.textContent = expanded[kind] ? `Show the first ${FIRST_ROWS}` : `Show ${total > all.length ? 'the newest' : 'all'} ${fmt(all.length)}`;
}

function setTab(t, focus = false) {
  tab = t === 'waiting' ? 'waiting' : 'accepted';
  $$('.ltab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  $('#p-accepted').hidden = tab !== 'accepted';
  $('#p-waiting').hidden = tab !== 'waiting';
}

// ------------------------------------------------------------------ board and activity
function boardRow(rank, login, steps, hour, me) {
  const href = profileHref(login);
  const who = `${LOGIN.test(login) ? avatarImg(login, 'ident', 48, login) : ''}<span>@${esc(login)}</span>`;
  return `<li class="lb-row${me ? ' me' : ''}"${me ? ' aria-current="true"' : ''}>`
    + `<span class="lb-rank">${esc(pad2(rank))}</span>`
    + (href ? out(href, who, 'lb-who') : `<span class="lb-who">${who}</span>`)
    + `<span class="lb-n">${esc(fmt(steps))}</span>`
    + `<span class="lb-h">${n(hour) ? `+${esc(fmt(hour))}` : '·'}</span></li>`;
}
function renderBoard(s) {
  const me = str(s.account).toLowerCase();
  const top = arr(s.board?.top).filter((r) => LOGIN.test(str(r.github)));
  let html = top.map((r, i) => boardRow(i + 1, r.github, r.steps, r.hour, !!me && r.github.toLowerCase() === me)).join('');
  const r = s.rank && typeof s.rank === 'object' ? s.rank : {};
  if (me && LOGIN.test(s.account) && !top.some((x) => x.github.toLowerCase() === me) && n(r.all) !== null) {
    html += '<li class="lb-row gap" aria-hidden="true"><span></span><span>…</span></li>' + boardRow(r.all, s.account, r.steps_all, r.steps_hour, true);
  }
  $('#l-board').innerHTML = html || '<li class="lnote">The board is not in this snapshot.</li>';
  const agents = n(s.board?.agents);
  $('#b-agents').textContent = agents !== null ? `${fmt(agents)} agents on it now` : '';
}

function renderFeed(s) {
  const events = [];
  for (const a of arr(s.activity)) {
    const href = prHref(a.url);
    if (href && str(a.step) && Number.isFinite(Date.parse(a.at))) events.push({ at: a.at, kind: 'sent', step: a.step, href });
  }
  for (const a of arr(s.accepted)) {
    const href = prHref(a.url);
    if (href && a.state === 'merged' && str(a.id) && Number.isFinite(Date.parse(a.merged_at))) events.push({ at: a.merged_at, kind: 'merged', step: a.id, href });
  }
  events.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  $('#l-feed').innerHTML = events.slice(0, 40).map((e) => `<li class="lf-row ${e.kind}">`
    + `<time datetime="${esc(e.at)}" title="${esc(ymd(e.at))} UTC">${esc(hhmmss(e.at))}</time>`
    + `<span class="lf-t">${e.kind === 'sent' ? `Pull request sent for <b>${esc(e.step)}</b>` : `<b>${esc(e.step)}</b> merged into the official proofs`}</span>`
    + `${out(e.href, `#${esc(prNo(e.href))} ↗`)}</li>`).join('') || '<li class="lnote">No public event in this snapshot yet.</li>';
}

// ------------------------------------------------------------------ refresh
function render() {
  renderStatus();
  const s = live?.at && live.snapshot && typeof live.snapshot === 'object' ? live.snapshot : {};
  renderTiles(s);
  renderRun();
  renderList('accepted', s);
  renderList('waiting', s);
  renderBoard(s);
  renderFeed(s);
}

// Relative times move on between two refreshes.
function retime() {
  $$('time[data-at]').forEach((t) => { t.textContent = `${t.dataset.prefix || ''}${since(t.dataset.at)}`; });
}

// The snapshot's age in seconds as the server measured it (x-live-age); the viewer's own clock only
// when the server did not say.
function ageOf(r, at) {
  const h = r.headers.get('x-live-age');
  const a = h === null || h === '' ? NaN : Number(h);
  return Number.isFinite(a) && a >= 0 ? a : Math.max(0, (Date.now() - Date.parse(at)) / 1000);
}

async function refresh() {
  lastTry = performance.now();
  try {
    const r = await fetch('/api/live', { cache: 'no-store', headers: etag ? { 'if-none-match': etag } : {} });
    if (r.status === 304 && live) {
      // The same snapshot: only its age has moved on.
      if (live.at) live.age_s = ageOf(r, live.at);
      gotAt = performance.now();
      failing = false;
      renderStatus();
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || typeof j !== 'object') throw new Error('unexpected answer');
    live = j.at && Number.isFinite(Date.parse(j.at)) && j.snapshot && typeof j.snapshot === 'object'
      ? { at: String(j.at), age_s: ageOf(r, j.at), snapshot: j.snapshot }
      : { at: null, configured: j.configured !== false };
    etag = r.headers.get('etag') || '';
    gotAt = performance.now();
    failing = false;
    render();
  } catch (e) {
    console.error(e);
    failing = true;
    renderStatus();
  }
}

$$('.ltab').forEach((b) => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(tab === 'accepted' ? 'waiting' : 'accepted', true); }
  });
});
$$('[data-more]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.more;
  expanded[kind] = !expanded[kind];
  renderList(kind, live?.at && live.snapshot && typeof live.snapshot === 'object' ? live.snapshot : {});
}));

setInterval(() => {
  $('#clock').textContent = new Date().toISOString().slice(11, 19);
  renderStatus();
  renderRun();
  retime();
}, 1000);
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && performance.now() - lastTry > 5000) refresh();
});
setTab('accepted');
refresh();

// The sponsor home page (PROJECT_MODE=sponsor). Everything shown is read live: the founder's standing from
// pequalnp.com's public contributors record (via /api/state), the accepted-and-waiting count from the live
// mirror (/api/live), the fund wallet and the payments list from the server's settings. No number is hard-coded.
import { $, fmt, hhmmss, esc, fillProject } from '/ui.js';

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HTTPS = /^https:\/\/[^\s"'<>]{1,300}$/;
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function tick() { $('#clock').textContent = hhmmss(new Date().toISOString()); }
setInterval(tick, 1000); tick();

function ordinal(n) { return `#${fmt(n)}`; }

function renderFounder(S) {
  const f = S.founder || {};
  const handle = HANDLE.test(f.handle || '') ? f.handle : 'BastianMIllan';
  $('#sp-by').textContent = `By @${handle}`;
  if (f.rank && f.contributors) {
    $('#sp-rank').textContent = `${ordinal(f.rank)} of ${fmt(f.contributors)} contributors on the official leaderboard`;
    $('#r-rank').textContent = ordinal(f.rank);
    $('#r-rank-s').textContent = `of ${fmt(f.contributors)} contributors, live`;
  } else {
    $('#sp-rank').textContent = 'a leading contributor on the official leaderboard';
  }
  if (Number.isFinite(f.steps)) {
    $('#r-merged').textContent = fmt(f.steps);
    $('#sp-founder').innerHTML = `I'm one of the leading contributors to that effort: my agents have <b>${esc(fmt(f.steps))}</b> proofs merged on its <a href="https://pequalnp.com/contributors" target="_blank" rel="noopener noreferrer">public leaderboard</a>. I created <b>${esc(S.project?.ticker || '$PNP')}</b> to help this experiment grow. The token's creator fees go to pequalnp.com through its <a href="https://pequalnp.com/sponsors" target="_blank" rel="noopener noreferrer">official sponsor program</a>.`;
  }
  if (f.contributors) $('#r-people').textContent = fmt(f.contributors);
  if (HANDLE.test(f.handle || '')) $('#sp-profile').href = `https://pequalnp.com/a/${encodeURIComponent(f.handle)}`;
}

function renderBuy(S) {
  const url = S.project?.pumpUrl || '';
  if (HTTPS.test(url)) { const a = $('#sp-buy'); a.href = url; a.textContent = `Buy ${S.project?.ticker || '$PNP'} ↗`; a.hidden = false; $('#sp-ca').hidden = true; }
}

function renderFund(S) {
  const split = S.sponsor?.split || S.rewards?.split || {};
  const sp = Number(split.sponsor) || 0, ops = Number(split.ops) || 0;
  $('#sp-split').textContent = sp >= 100 || (sp > 0 && !ops) ? 'All creator fees go to the sponsorship fund.' : `${fmt(sp)}% of creator fees go to the sponsorship fund · ${fmt(ops)}% to operations.`;
  const addr = S.pay_wallet;
  if (typeof addr === 'string' && SOL_ADDR.test(addr)) {
    const cluster = S.cluster && S.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(S.cluster)}` : '';
    $('#sp-wallet').innerHTML = `Fund wallet: <a class="mono" href="https://explorer.solana.com/address/${esc(addr)}${cluster}" target="_blank" rel="noopener noreferrer">${esc(addr)}</a>`;
    $('#sp-wallet-note').textContent = 'watch it on the Solana explorer';
  }
  const pays = Array.isArray(S.sponsor?.payments) ? S.sponsor.payments : [];
  if (pays.length) {
    $('#sp-payments').innerHTML = pays.map((p) => {
      const amount = `$${fmt(p.usd)}`;
      const note = esc(p.note || 'Payment to pequalnp.com');
      const link = HTTPS.test(p.link || '') ? ` <a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">receipt ↗</a>` : '';
      return `<li class="lrow"><span class="mono">${esc(p.date)}</span><span>${note}${link}</span><b>${esc(amount)}</b></li>`;
    }).join('');
  }
}

function renderPrograms(S) {
  const progs = Array.isArray(S.programs) ? S.programs : [];
  if (!progs.length) return;
  $('#sp-programs').innerHTML = progs.map((p) => {
    const st = String(p.status || '');
    const total = st.length, done = (st.match(/c/g) || []).length;
    const pct = total ? Math.round((done / total) * 1000) / 10 : 0;
    return `<li class="sp-prog"><div class="sp-prog-h"><span>${esc(String(p.title || p.key).toUpperCase())}</span><span class="mono">${esc(fmt(done))} / ${esc(fmt(total))} proven</span></div><div class="sp-bar"><i style="width:${pct}%"></i></div></li>`;
  }).join('');
  const agents = S.official?.agents_now;
  if (Number.isFinite(agents)) $('#sp-agents').textContent = `${fmt(agents)} agents on it now`;
}

async function loadState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) return;
    const S = await r.json();
    fillProject(S.project || { name: "Valiant's Conjecture", ticker: '$PNP' });
    renderFounder(S); renderBuy(S); renderFund(S); renderPrograms(S);
  } catch { /* keep the static text */ }
}

async function loadLive() {
  try {
    const r = await fetch('/api/live', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const merging = j?.snapshot?.counts?.merging;
    if (Number.isFinite(merging)) $('#r-waiting').textContent = fmt(merging);
  } catch { /* the live mirror is optional */ }
}

loadState(); loadLive();
setInterval(loadState, 60000);
setInterval(loadLive, 60000);

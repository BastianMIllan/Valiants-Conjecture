// Internal dashboard: who contributed most, the team treasury, the official record and sign-ups.
import { $, fmt, ymd, ago, esc, copyText, toast, countTo, fillProject, avatarImg, solAmount, shortWallet } from '/ui.js';

let TOKEN = '';
try { TOKEN = sessionStorage.getItem('adm') || ''; } catch {}
let O = null;
const short = shortWallet;
const sentence = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
// 'ok', 'refused' or 'none' (a server from before token_state existed only says whether one is set).
const tokenState = () => (['ok', 'refused', 'none'].includes(O.github.token_state) ? O.github.token_state : O.github.token ? 'ok' : 'none');

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  });
  if (r.status === 401) { logout(); throw new Error('unauthorized'); }
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function logout() {
  TOKEN = '';
  try { sessionStorage.removeItem('adm'); } catch {}
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#btn-sync').hidden = $('#btn-out').hidden = true;
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ render
async function refresh() {
  O = await api('/api/admin/overview');
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#btn-sync').hidden = $('#btn-out').hidden = false;
  fillProject(O.project);
  document.title = `Internal // ${O.project.name}`;

  const live = O.members.filter((m) => !m.banned && !m.team);
  countTo($('#a-members'), live.length);
  $('#a-members-s').textContent = `${O.members.length - live.length} banned`;
  countTo($('#a-active'), live.filter((m) => m.active).length);
  $('#a-active-s').textContent = `${fmt(live.reduce((a, m) => a + m.steps_24h, 0))} proofs in 24 h`;
  countTo($('#a-proofs'), live.reduce((a, m) => a + m.steps, 0));
  $('#a-proofs-s').textContent = `${fmt(O.record.before_join)} from before joining, not counted`;
  countTo($('#a-unpaid'), live.reduce((a, m) => a + m.unallocated, 0));
  $('#a-owed').textContent = solAmount(O.payout.owed_total);
  $('#a-paid').textContent = solAmount(O.payout.paid_total);

  const s = $('#sync');
  const err = O.sync.contributors_err || O.sync.err;
  const tokenNote = { none: 'no GitHub token: sign-ups can be blocked', refused: 'GitHub refused the token: sign-ups can be blocked' }[tokenState()];
  s.textContent = `${err ? `sync problem: ${err}` : `record synced ${O.sync.ok ? ago(O.sync.ok) : 'never'}`}${tokenNote ? ` · ${tokenNote}` : ''}`;
  s.classList.toggle('bad', !!err || !!tokenNote);

  renderPay();
  renderMembers();
  renderRecord();
  renderCredits();
  renderEpochs();
  renderRules();
}

function renderPay() {
  const p = O.payout;
  const banner = $('#pay-banner');
  const notes = [];
  if (!p.configured) notes.push('No treasury key yet. Run <b>npm run wallet</b> on the server (or set PAYOUT_SECRET_KEY), then restart.');
  else if (!p.enabled) notes.push('Auto-pay is <b>OFF</b>. Nothing is sent until you set <b>PAYOUTS_ENABLED=1</b> and restart.');
  if (p.paused) notes.push('Payouts are <b>PAUSED</b> from this dashboard.');
  if (p.last_error) notes.push(`Last problem: <b>${esc(p.last_error)}</b>`);
  if (p.held_wallets.length) notes.push(`${p.held_wallets.length} wallet(s) on hold after 3 failed transfers: see the contributors table.`);
  banner.hidden = !notes.length;
  banner.innerHTML = notes.join('<br>');
  $('#btn-pause').textContent = p.paused ? 'Resume' : 'Pause';
  $('#btn-run').disabled = !p.configured;

  const solscan = (a) => `https://solscan.io/account/${a}${p.cluster && p.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(p.cluster)}` : ''}`;
  const r = p.last_report;
  $('#pay-kv').innerHTML = `
    <span>address</span><span>${p.address ? `${esc(p.address)} <button class="btn sm" type="button" data-copyw="${esc(p.address)}">Copy</button> <a href="${esc(solscan(p.address))}" target="_blank" rel="noopener">Solscan ↗</a>` : '—'}</span>
    <span>auto-pay</span><span>${p.enabled ? '<span class="pill on">ON</span>' : '<span class="pill off">OFF</span>'} ${p.paused ? '<span class="pill off">PAUSED</span>' : ''} every ${p.interval_minutes} min${p.next_run_at ? ` · next ${esc(ymd(p.next_run_at))} UTC` : ''}</span>
    <span>balance</span><span>${p.balance_now !== null ? `<b>${esc(p.balance_now)} SOL</b> right now` : p.last_balance !== null ? `${esc(p.last_balance)} SOL at the last run (node unreachable now)` : '—'}</span>
    <span>owed / reserve</span><span>${esc(p.owed_total)} SOL owed · ${esc(p.reserve)} SOL reserve kept for fees</span>
    <span>rules</span><span>new funds split once they reach ${esc(p.min_distribution)} SOL · a member is sent their balance once it reaches ${esc(p.min_payout)} SOL</span>
    <span>last run</span><span>${p.last_run ? `${esc(ymd(p.last_run))} UTC` : 'never'}${r ? ` · ${r.allocated ? `split ${esc(r.allocated.amount)} SOL across ${r.allocated.recipients}` : 'nothing new to split'} · sent ${r.sent}${r.failed ? ` · failed ${r.failed}` : ''}${r.pending ? ` · in flight ${r.pending}` : ''}${r.skipped ? ` · ${esc(r.skipped)}` : ''}` : ''}</span>
  `;
  const tone = { confirmed: 'ok', pending: 'on', failed: 'off' };
  $('#batches').innerHTML = p.batches.length
    ? p.batches.map((b) => `
      <tr>
        <td><b>${esc(b.id)}</b></td>
        <td><span class="pill ${tone[b.status] || 'off'}">${esc(b.status.toUpperCase())}</span></td>
        <td class="r">${fmt(b.recipients)}</td>
        <td class="r">${esc(b.amount)}</td>
        <td><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.sig.slice(0, 12))}… ↗</a></td>
        <td class="muted">${esc(ymd(b.at))}</td>
        <td class="muted wrap">${esc(b.err || b.note || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="empty">No transfer yet.</td></tr>';
}

function renderMembers() {
  const f = $('#filter').value.trim().toLowerCase();
  const list = O.members.filter((m) => !f || m.wallet.toLowerCase().includes(f) || m.login.includes(f));
  $('#members').innerHTML = list.length
    ? list.map((m, i) => `
      <tr class="${m.banned ? 'banned' : ''}">
        <td class="rank">${String(i + 1).padStart(3, '0')}</td>
        <td><a class="who" href="/m/${encodeURIComponent(m.login)}" target="_blank">${avatarImg(m.github, 'ident', 48, m.wallet)}@${esc(m.github)}</a></td>
        <td><span class="wal">${esc(short(m.wallet))}<button type="button" data-copyw="${esc(m.wallet)}">Copy</button></span>${m.wallets > 1 ? ` <span class="muted">+${m.wallets - 1} earlier</span>` : ''}</td>
        <td class="r"><b>${fmt(m.steps)}</b></td>
        <td class="r${m.unallocated ? ' unpaid' : ' muted'}">${m.unallocated ? fmt(m.unallocated) : '·'}</td>
        <td class="r">${+m.owed ? esc(solAmount(m.owed)) : '·'}</td>
        <td class="r">${+m.paid ? esc(solAmount(m.paid)) : '·'}</td>
        <td class="r">${m.steps_24h ? `+${fmt(m.steps_24h)}` : '·'}</td>
        <td>${m.banned ? '<span class="state off">banned</span>' : m.team ? '<span class="state off">team account</span>' : m.held ? '<span class="state on">payout on hold</span>' : m.active ? '<span class="state on">proving</span>' : `<span class="state off">joined ${esc(ago(m.joined_at))}</span>`}</td>
        <td><div class="act">
          <button type="button" data-detail="${esc(m.login)}">Detail</button>
          ${m.held ? `<button type="button" data-unhold="${esc(m.login)}">Retry pay</button>` : ''}
          <button type="button" class="danger" data-ban="${esc(m.login)}" data-banned="${m.banned ? 1 : 0}">${m.banned ? 'Unban' : 'Ban'}</button>
        </div></td>
      </tr>`).join('')
    : `<tr><td colspan="10" class="empty">No members yet. Share ${esc(location.origin)}</td></tr>`;
}

function renderRecord() {
  const sy = O.sync;
  const team = O.team_handles.map((t) => `@${esc(t.github)} (${fmt(t.steps)} on the record)`).join(', ');
  $('#record-kv').innerHTML = `
    <span>record</span><span>${sy.ok ? `read ${esc(ago(sy.ok))}` : 'never read'}${sy.err ? ` · <b class="acc">${esc(sy.err)}</b>` : ''}</span>
    <span>contributors</span><span>${O.record.contributors ? `${fmt(O.record.contributors)} provers on the record` : 'not loaded yet'}${sy.contributors_at ? ` · copy from ${esc(ago(sy.contributors_at))}` : ''} · refreshed at most every ${fmt(sy.refresh_seconds)} s${sy.contributors_err ? ` · <b class="acc">last fetch failed, keeping the previous copy: ${esc(sy.contributors_err)}</b>` : ''}</span>
    <span>file</span><span>${esc(sy.files?.contributors || '—')}${O.record.skipped ? ` · ${fmt(O.record.skipped)} malformed rows skipped` : ''}</span>
    <span>members found</span><span>${fmt(O.record.members_on_record)} members have proofs on the record · ${fmt(O.record.before_join)} of those proofs predate joining and are not paid</span>
    <span>team accounts</span><span>${team || 'none set (PNP_HANDLE, PNP_FORMER_HANDLES)'} · never members, never credited, never paid</span>
    <span>gist checks</span><span>${{
      ok: '<span class="pill ok">TOKEN</span> read-only GitHub token in use',
      refused: '<b class="acc">GitHub refused GITHUB_TOKEN (revoked or expired). Checks run without it, at about 60 an hour, so a few people can block every sign-up. Replace it with a token with no permissions and restart.</b>',
      none: '<b class="acc">No GitHub token. GitHub allows about 60 checks an hour without one, so a few people can block every sign-up. Set GITHUB_TOKEN (a token with no permissions) and restart.</b>',
    }[tokenState()]}</span>
  `;
  $('#registrations').innerHTML = O.registrations.length
    ? O.registrations.map((r) => `
      <tr>
        <td class="muted">${esc(ymd(r.at))}</td>
        <td><a href="https://github.com/${encodeURIComponent(r.github)}" target="_blank" rel="noopener">@${esc(r.github)}</a></td>
        <td><span class="wal">${esc(short(r.wallet))}<button type="button" data-copyw="${esc(r.wallet)}">Copy</button></span></td>
        <td>${/^refused/.test(r.result) ? `<span class="pill off">${esc(r.result.toUpperCase())}</span>` : `<span class="pill ok">${esc(r.result.toUpperCase())}</span>`}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">No sign-up yet.</td></tr>';
}

function renderCredits() {
  $('#credits').innerHTML = O.credits.length
    ? O.credits.map((c) => `
      <tr>
        <td><a href="https://pequalnp.com/lemma.html#${encodeURIComponent(c.id)}" target="_blank" rel="noopener"><b>${esc(c.id)}</b></a>${c.kind ? ` <span class="kind">${esc(c.kind)}</span>` : ''}</td>
        <td class="wrap">${esc(c.title)}</td>
        <td><a href="/m/${encodeURIComponent(c.login)}" target="_blank">@${esc(c.github)}</a></td>
        <td class="muted">${esc(ymd(c.at))}</td>
        <td>${c.revoked ? '<span class="badge no">withdrawn</span>' : c.alloc ? `<span class="badge paid">${esc(c.alloc)}</span>` : '<span class="badge no">unpaid</span>'}</td>
        <td>${c.pr_url ? `<a href="${esc(c.pr_url)}" target="_blank" rel="noopener">#${esc(c.pr_url.split('/').pop())} ↗</a>` : '—'}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No credited proof yet.</td></tr>';
}

function renderEpochs() {
  $('#epochs').innerHTML = O.epochs.length
    ? O.epochs.map((e) => `
      <tr>
        <td><b>${esc(e.id)}</b></td>
        <td class="muted">${esc(ymd(e.created_at))}</td>
        <td class="r">${esc(e.distributed)} SOL</td>
        <td class="r">${fmt(e.recipients)}</td>
        <td class="muted">${esc(ymd(e.from))} → ${esc(ymd(e.to))}</td>
        <td><div class="act"><button type="button" data-csv="${esc(e.id)}">CSV</button></div></td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">Nothing split yet.</td></tr>';
}

function renderRules() {
  const r = O.rewards;
  const p = O.payout;
  $('#rules').textContent = [
    `join             a public gist on the member's GitHub account holding "${O.github.gist_line}", checked once`,
    `credit           every proof the official record lists for the member's GitHub account at or after joining, once per lemma`,
    `excluded         the team's own accounts: ${O.team_handles.map((t) => `@${t.github}`).join(', ') || 'none set'}`,
    `share            one credited proof = ${r.weights.default ?? 1} share${Object.keys(r.weights).length > 1 ? `  (${Object.entries(r.weights).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
    `pay              SOL, from the team treasury, every ${p.interval_minutes} min when there are new funds, to each member's current wallet`,
    `thresholds       split from ${p.min_distribution} SOL of new funds · send from ${p.min_payout} SOL owed · keep ${p.reserve} SOL for fees`,
    `fee split        provers ${r.split.contributors}% · pequalnp.com sponsor wall ${r.split.sponsor}% · ops ${r.split.ops}%  (you decide what you send to the treasury)`,
    ``,
    `Change these with env vars (PAYOUT_*, MIN_*, SPLIT_*, PNP_HANDLE, PNP_FORMER_HANDLES) or in config.js, then restart.`,
  ].join('\n');
}

async function openDetail(login) {
  const d = await api(`/api/admin/member/${encodeURIComponent(login)}`);
  $('#dr-title').textContent = `@${d.github}`;
  $('#dr-body').innerHTML = `
    <div class="kv">
      <span>github</span><span><a href="https://github.com/${encodeURIComponent(d.github)}" target="_blank" rel="noopener">@${esc(d.github)} ↗</a>${d.gist ? ` · <a href="${esc(d.gist)}" target="_blank" rel="noopener">gist ↗</a>` : ''}</span>
      <span>wallet</span><span>${esc(d.wallet)}</span>
      <span>joined</span><span>${esc(ymd(d.joined_at))} UTC</span>
      <span>proofs</span><span>${fmt(d.steps)} credited (weight ${fmt(d.weight)}) · ${fmt(d.official_steps)} on the official record in total</span>
      <span>owed / paid</span><span>${esc(d.owed)} SOL owed · ${esc(d.paid)} SOL paid</span>
      <span>wallets</span><span>${d.wallets.map((w) => `${esc(short(w.wallet))} since ${esc(ymd(w.at))}`).join(' · ') || '—'}</span>
    </div>
    <div class="note-row"><input id="note" maxlength="500" placeholder="internal note" value="${esc(d.note || '')}"><button class="btn" type="button" id="save-note" data-login="${esc(d.login)}">Save note</button></div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>LEMMA</th><th>TITLE</th><th>ACCEPTED</th><th>TO WALLET</th><th>ALLOCATION</th><th>PR</th></tr></thead>
      <tbody>${d.credits.map((c) => `
        <tr>
          <td><b>${esc(c.id)}</b></td>
          <td class="wrap">${esc(c.title)}</td>
          <td class="muted">${esc(ymd(c.at))}</td>
          <td class="muted">${esc(short(c.wallet))}</td>
          <td>${c.revoked ? '<span class="badge no">withdrawn</span>' : c.alloc ? `<span class="badge paid">${esc(c.alloc)}</span>` : '<span class="badge no">unpaid</span>'}</td>
          <td>${c.pr_url ? `<a href="${esc(c.pr_url)}" target="_blank" rel="noopener">PR ↗</a>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">No credited proof yet.</td></tr>'}</tbody>
    </table></div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>PAID</th><th class="r">SOL</th><th>TO</th><th>TRANSACTION</th></tr></thead>
      <tbody>${d.payments.map((x) => `<tr><td class="muted">${esc(ymd(x.at))}</td><td class="r">${esc(x.amount)}</td><td class="muted">${esc(short(x.wallet))}</td><td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.sig.slice(0, 12))}… ↗</a></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No transfer yet.</td></tr>'}</tbody>
    </table></div>`;
  $('#drawer').showModal();
}

// ------------------------------------------------------------------ wiring
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  TOKEN = $('#pw').value.trim();
  try {
    await refresh();
    try { sessionStorage.setItem('adm', TOKEN); } catch {}
    $('#login-err').textContent = '';
  } catch (err) {
    $('#login-err').textContent = err.message === 'unauthorized' ? 'Wrong password.' : err.message;
  }
});
$('#btn-out').addEventListener('click', logout);
$('#btn-sync').addEventListener('click', async () => {
  const r = await post('/api/admin/sync');
  toast(r.ok ? 'Record synced' : `Sync problem: ${r.contributors_err || r.err}`, 3500);
  refresh();
});
$('#btn-run').addEventListener('click', async () => {
  const b = $('#btn-run');
  b.disabled = true;
  b.textContent = 'Running…';
  try {
    const r = await post('/api/admin/payout/run');
    toast(r.skipped ? sentence(r.skipped) : `Sent ${r.sent}${r.failed ? ` · failed ${r.failed}` : ''}${r.pending ? ` · in flight ${r.pending}` : ''}`, 3500);
  } catch (err) {
    toast(sentence(err.message), 3500);
  }
  b.textContent = 'Run now';
  b.disabled = false;
  refresh();
});
$('#btn-pause').addEventListener('click', async () => {
  await post('/api/admin/payout/pause', { paused: !O.payout.paused });
  refresh();
});
$('#filter').addEventListener('input', renderMembers);
$('#btn-export').addEventListener('click', () => {
  const rows = [['github', 'wallet', 'proofs', 'unpaid', 'owed_sol', 'paid_sol', 'proofs_24h', 'official_proofs', 'joined_at', 'banned']];
  for (const m of O.members) rows.push([m.github, m.wallet, m.steps, m.unallocated, m.owed, m.paid, m.steps_24h, m.official_steps, m.joined_at, m.banned]);
  saveBlob(new Blob([`${rows.map((r) => r.join(',')).join('\n')}\n`], { type: 'text/csv' }), `${O.project.slug}-contributors.csv`);
});
$('#dr-close').addEventListener('click', () => $('#drawer').close());

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.copyw) { await copyText(t.dataset.copyw); toast('Copied'); }
    else if (t.dataset.detail) await openDetail(t.dataset.detail);
    else if (t.dataset.unhold) { await post(`/api/admin/member/${encodeURIComponent(t.dataset.unhold)}`, { clear_hold: true }); toast('Will retry on the next run'); refresh(); }
    else if (t.dataset.ban) {
      const ban = t.dataset.banned !== '1';
      if (ban && !confirm('Ban this member? They leave the board, their new proofs stop counting, and nothing more is sent to them.')) return;
      await post(`/api/admin/member/${encodeURIComponent(t.dataset.ban)}`, { banned: ban });
      refresh();
    } else if (t.id === 'save-note') {
      await post(`/api/admin/member/${encodeURIComponent(t.dataset.login)}`, { note: $('#note').value });
      toast('Note saved');
    } else if (t.dataset.csv) {
      const r = await fetch(`/api/admin/epoch/${encodeURIComponent(t.dataset.csv)}/csv`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (!r.ok) return toast('CSV failed');
      saveBlob(await r.blob(), `${O.project.slug}-${t.dataset.csv}.csv`);
    }
  } catch (err) {
    toast(sentence(err.message), 3500);
  }
});

if (TOKEN) refresh().catch(() => {});
setInterval(() => { if (TOKEN && !$('#app').hidden && !$('#drawer').open) refresh().catch(() => {}); }, 30000);

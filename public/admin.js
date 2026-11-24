// Internal dashboard: who contributed most, the pay wallet, the desk and pull requests.
import { $, fmt, ymd, ago, esc, copyText, toast, countTo, fillProject, identicon, solAmount } from '/ui.js';

let TOKEN = '';
try { TOKEN = sessionStorage.getItem('adm') || ''; } catch {}
let O = null;
const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '—');

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

  const live = O.members.filter((m) => !m.banned);
  countTo($('#a-members'), live.length);
  $('#a-members-s').textContent = `${O.members.length - live.length} banned`;
  countTo($('#a-active'), live.filter((m) => m.active).length);
  $('#a-active-s').textContent = `${O.desk.held.length} / ${O.desk.max} steps held`;
  countTo($('#a-ours'), O.official.ours);
  $('#a-ours-s').textContent = `${O.unattributed.length} unattributed`;
  countTo($('#a-unpaid'), live.reduce((a, m) => a + m.unallocated, 0));
  $('#a-owed').textContent = solAmount(O.payout.owed_total);
  $('#a-paid').textContent = solAmount(O.payout.paid_total);

  const s = $('#sync');
  s.textContent = O.sync.err ? `sync error: ${O.sync.err}` : `record synced ${O.sync.ok ? ago(O.sync.ok) : 'never'}`;
  s.classList.toggle('bad', !!O.sync.err);

  renderPay();
  renderMembers();
  renderDesk();
  renderUnattributed();
  renderEpochs();
  renderRules();
}

function renderPay() {
  const p = O.payout;
  const banner = $('#pay-banner');
  const notes = [];
  if (!p.configured) notes.push('No pay wallet yet. Run <b>npm run wallet</b> on the server (or set PAYOUT_SECRET_KEY), then restart.');
  else if (!p.enabled) notes.push('Auto-pay is <b>OFF</b>. Nothing is sent until you set <b>PAYOUTS_ENABLED=1</b> and restart.');
  if (p.paused) notes.push('Payouts are <b>PAUSED</b> from this dashboard.');
  if (p.last_error) notes.push(`Last problem: <b>${esc(p.last_error)}</b>`);
  if (p.held_wallets.length) notes.push(`${p.held_wallets.length} wallet(s) on hold after 3 failed transfers: see the contributors table.`);
  banner.hidden = !notes.length;
  banner.innerHTML = notes.join('<br>');
  $('#btn-pause').textContent = p.paused ? 'RESUME' : 'PAUSE';
  $('#btn-run').disabled = !p.configured;

  const solscan = (a) => `https://solscan.io/account/${a}${p.cluster && p.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(p.cluster)}` : ''}`;
  const r = p.last_report;
  $('#pay-kv').innerHTML = `
    <span>address</span><span>${p.address ? `${esc(p.address)} <button class="btn sm" type="button" data-copyw="${esc(p.address)}">COPY</button> <a href="${solscan(p.address)}" target="_blank" rel="noopener">Solscan ↗</a>` : '—'}</span>
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
    : '<tr><td colspan="7" class="empty">NO TRANSFER YET.</td></tr>';
}

function renderMembers() {
  const f = $('#filter').value.trim().toLowerCase();
  const list = O.members.filter((m) => !f || m.wallet.toLowerCase().includes(f) || String(m.name || '').toLowerCase().includes(f));
  $('#members').innerHTML = list.length
    ? list.map((m, i) => `
      <tr class="${m.banned ? 'banned' : ''}">
        <td class="rank">${String(i + 1).padStart(3, '0')}</td>
        <td><a class="who" href="/m/${encodeURIComponent(m.wallet)}" target="_blank"><img class="ident" alt="" src="${identicon(m.wallet)}">${esc(m.display)}</a></td>
        <td><span class="wal">${esc(short(m.wallet))}<button type="button" data-copyw="${esc(m.wallet)}">COPY</button></span></td>
        <td class="r"><b>${fmt(m.steps)}</b></td>
        <td class="r${m.unallocated ? ' unpaid' : ' muted'}">${m.unallocated ? fmt(m.unallocated) : '·'}</td>
        <td class="r">${+m.owed ? esc(solAmount(m.owed)) : '·'}</td>
        <td class="r">${+m.paid ? esc(solAmount(m.paid)) : '·'}</td>
        <td class="r">${m.steps_24h ? `+${fmt(m.steps_24h)}` : '·'}</td>
        <td>${m.banned ? '<span class="state off">banned</span>' : m.held ? '<span class="state on">payout on hold</span>' : m.active ? `<span class="state on">${esc(m.working_on || 'working')}</span>` : '<span class="state off">idle</span>'}</td>
        <td><div class="act">
          <button type="button" data-detail="${esc(m.wallet)}">DETAIL</button>
          ${m.held ? `<button type="button" data-unhold="${esc(m.wallet)}">RETRY PAY</button>` : ''}
          <button type="button" class="danger" data-ban="${esc(m.wallet)}" data-banned="${m.banned ? 1 : 0}">${m.banned ? 'UNBAN' : 'BAN'}</button>
        </div></td>
      </tr>`).join('')
    : `<tr><td colspan="10" class="empty">NO MEMBERS YET. SHARE ${esc(location.origin)}</td></tr>`;
}

function renderDesk() {
  $('#desk-kv').innerHTML = `
    <span>our handle</span><span>${O.handle ? `<a href="https://pequalnp.com/a/${encodeURIComponent(O.handle)}" target="_blank" rel="noopener">@${esc(O.handle)}</a> on pequalnp.com` : '<b class="acc">not set: PNP_HANDLE</b>'}</span>
    <span>pull requests</span><span>${O.github_ready ? '<span class="pill ok">READY</span> opened from our account' : '<span class="pill on">NOT CONFIGURED</span> set GITHUB_TOKEN (classic, public_repo) and PNP_HANDLE'}</span>
    <span>steps held</span><span>${O.desk.held.length} of ${O.desk.max} (hard steps are extra)</span>
  `;
  $('#leases').innerHTML = O.desk.held.length
    ? O.desk.held.map((l) => `
      <tr>
        <td><a href="https://pequalnp.com/lemma.html#${encodeURIComponent(l.gap || '')}" target="_blank" rel="noopener"><b>${esc(l.gap || l.id)}</b></a></td>
        <td>${esc(l.kind)}</td>
        <td>${l.workers.map((w) => `<a href="/m/${encodeURIComponent(w)}" target="_blank">${esc(short(w))}</a>`).join(', ') || '—'}</td>
        <td class="muted">${esc(ago(l.since))}</td>
        <td class="muted">${esc(ago(l.last_beat))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">NO STEP HELD RIGHT NOW.</td></tr>';
  const tone = { ACCEPTED: 'ok', REJECTED: 'on', FAULT: 'on', pending: 'off' };
  $('#subs').innerHTML = O.submissions.length
    ? O.submissions.map((s) => `
      <tr>
        <td class="muted">${esc(ymd(s.at))}</td>
        <td><a href="/m/${encodeURIComponent(s.wallet)}" target="_blank">${esc(short(s.wallet))}</a></td>
        <td><b>${esc(s.gap || '—')}</b></td>
        <td><span class="pill ${tone[s.verdict] || 'off'}">${esc(String(s.verdict).toUpperCase())}</span>${s.error ? ` <span class="muted">${esc(s.error)}</span>` : ''}</td>
        <td>${s.pr ? `<a href="${esc(s.pr)}" target="_blank" rel="noopener">#${esc(s.pr.split('/').pop())} ↗</a>` : '—'}</td>
        <td class="r">${s.resubmits || '·'}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">NO PULL REQUEST YET.</td></tr>';
}

function renderUnattributed() {
  $('#unattributed').innerHTML = O.unattributed.length
    ? O.unattributed.map((c) => `
      <tr>
        <td><b>${esc(c.id)}</b></td>
        <td class="wrap">${esc(c.title)}</td>
        <td class="muted">${esc(ymd(c.at))}</td>
        <td>${c.pr_url ? `<a href="${esc(c.pr_url)}" target="_blank" rel="noopener">PR ↗</a>` : '—'}</td>
        <td><div class="attr"><input placeholder="member wallet" data-attr-input="${esc(c.id)}"><button class="btn sm" type="button" data-attr="${esc(c.id)}">ASSIGN</button></div></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">NOTHING TO ATTRIBUTE.</td></tr>';
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
    : '<tr><td colspan="6" class="empty">NOTHING SPLIT YET.</td></tr>';
}

function renderRules() {
  const r = O.rewards;
  const p = O.payout;
  $('#rules').textContent = [
    `credit           a proof counts once the official record credits it to @${O.handle || '?'}, traced by its pull request`,
    `share            one accepted proof = ${r.weights.default ?? 1} share${Object.keys(r.weights).length > 1 ? `  (${Object.entries(r.weights).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`,
    `pay              SOL, from the pay wallet, every ${p.interval_minutes} min when there are new funds`,
    `thresholds       split from ${p.min_distribution} SOL of new funds · send from ${p.min_payout} SOL owed · keep ${p.reserve} SOL for fees`,
    `fee split        provers ${r.split.contributors}% · pequalnp.com sponsor wall ${r.split.sponsor}% · ops ${r.split.ops}%  (you decide what you send to the pay wallet)`,
    ``,
    `Change these with env vars (PAYOUT_*, MIN_*, SPLIT_*) or in config.js, then restart.`,
  ].join('\n');
}

async function openDetail(wallet) {
  const d = await api(`/api/admin/member/${encodeURIComponent(wallet)}`);
  $('#dr-title').textContent = d.display;
  $('#dr-body').innerHTML = `
    <div class="kv">
      <span>wallet</span><span>${esc(d.wallet)}</span>
      <span>joined</span><span>${esc(ymd(d.created_at))} UTC · ${d.keys || 0} key(s) issued</span>
      <span>proofs</span><span>${fmt(d.steps)} accepted (weight ${fmt(d.weight)})</span>
      <span>owed / paid</span><span>${esc(d.owed)} SOL owed · ${esc(d.paid)} SOL paid</span>
    </div>
    <div class="note-row"><input id="note" maxlength="500" placeholder="internal note" value="${esc(d.note || '')}"><button class="btn" type="button" id="save-note" data-w="${esc(d.wallet)}">SAVE NOTE</button></div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>LEMMA</th><th>TITLE</th><th>ACCEPTED</th><th>ALLOCATION</th><th>PR</th></tr></thead>
      <tbody>${d.credits.map((c) => `
        <tr>
          <td><b>${esc(c.id)}</b></td>
          <td class="wrap">${esc(c.title)}</td>
          <td class="muted">${esc(ymd(c.at))}</td>
          <td>${c.revoked ? '<span class="badge no">withdrawn</span>' : c.alloc ? `<span class="badge paid">${esc(c.alloc)}</span>` : '<span class="badge no">unpaid</span>'}</td>
          <td>${c.pr_url ? `<a href="${esc(c.pr_url)}" target="_blank" rel="noopener">PR ↗</a>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No accepted proof yet.</td></tr>'}</tbody>
    </table></div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>PAID</th><th class="r">SOL</th><th>TRANSACTION</th></tr></thead>
      <tbody>${d.payments.map((x) => `<tr><td class="muted">${esc(ymd(x.at))}</td><td class="r">${esc(x.amount)}</td><td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.sig.slice(0, 12))}… ↗</a></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No transfer yet.</td></tr>'}</tbody>
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
  toast(r.ok ? 'RECORD SYNCED' : `SYNC FAILED: ${r.err}`);
  refresh();
});
$('#btn-run').addEventListener('click', async () => {
  const b = $('#btn-run');
  b.disabled = true;
  b.textContent = 'RUNNING…';
  try {
    const r = await post('/api/admin/payout/run');
    toast(r.skipped ? r.skipped.toUpperCase() : `SENT ${r.sent}${r.failed ? ` · FAILED ${r.failed}` : ''}${r.pending ? ` · IN FLIGHT ${r.pending}` : ''}`, 3500);
  } catch (err) {
    toast(err.message.toUpperCase(), 3500);
  }
  b.textContent = 'RUN NOW';
  b.disabled = false;
  refresh();
});
$('#btn-pause').addEventListener('click', async () => {
  await post('/api/admin/payout/pause', { paused: !O.payout.paused });
  refresh();
});
$('#filter').addEventListener('input', renderMembers);
$('#btn-export').addEventListener('click', () => {
  const rows = [['wallet', 'name', 'proofs', 'unpaid', 'owed_sol', 'paid_sol', 'proofs_24h', 'joined_at', 'banned']];
  for (const m of O.members) rows.push([m.wallet, (m.name || '').replace(/,/g, ' '), m.steps, m.unallocated, m.owed, m.paid, m.steps_24h, m.joined_at, m.banned]);
  saveBlob(new Blob([`${rows.map((r) => r.join(',')).join('\n')}\n`], { type: 'text/csv' }), `${O.project.slug}-contributors.csv`);
});
$('#dr-close').addEventListener('click', () => $('#drawer').close());

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.copyw) { await copyText(t.dataset.copyw); toast('COPIED'); }
    else if (t.dataset.detail) await openDetail(t.dataset.detail);
    else if (t.dataset.unhold) { await post(`/api/admin/member/${encodeURIComponent(t.dataset.unhold)}`, { clear_hold: true }); toast('WILL RETRY ON THE NEXT RUN'); refresh(); }
    else if (t.dataset.ban) {
      const ban = t.dataset.banned !== '1';
      if (ban && !confirm('Ban this member? Their key stops working, they leave the board, and nothing more is sent to them.')) return;
      await post(`/api/admin/member/${encodeURIComponent(t.dataset.ban)}`, { banned: ban });
      refresh();
    } else if (t.id === 'save-note') {
      await post(`/api/admin/member/${encodeURIComponent(t.dataset.w)}`, { note: $('#note').value });
      toast('NOTE SAVED');
    } else if (t.dataset.attr) {
      const w = document.querySelector(`[data-attr-input="${CSS.escape(t.dataset.attr)}"]`).value.trim();
      await post('/api/admin/attribute', { lemma: t.dataset.attr, wallet: w });
      toast('ATTRIBUTED');
      refresh();
    } else if (t.dataset.csv) {
      const r = await fetch(`/api/admin/epoch/${t.dataset.csv}/csv`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (!r.ok) return toast('CSV FAILED');
      saveBlob(await r.blob(), `${O.project.slug}-${t.dataset.csv}.csv`);
    }
  } catch (err) {
    toast(err.message.toUpperCase(), 3500);
  }
});

if (TOKEN) refresh().catch(() => {});
setInterval(() => { if (TOKEN && !$('#app').hidden && !$('#drawer').open) refresh().catch(() => {}); }, 30000);

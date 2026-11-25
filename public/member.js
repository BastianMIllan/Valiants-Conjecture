// A member's public page: /m/<wallet> or /m/<github username>.
import { $, fmt, ymd, ago, esc, copyText, countTo, fillProject, identicon, avatar, solAmount, shortWallet } from '/ui.js';

const id = decodeURIComponent(location.pathname.split('/')[2] || '');

async function main() {
  const [mr, sr] = await Promise.all([fetch(`/api/member/${encodeURIComponent(id)}`), fetch('/api/state')]);
  const s = await sr.json();
  const PNP = s.official?.site || 'https://pequalnp.com';
  fillProject(s.project, s.rewards);
  const m = await mr.json();
  if (!mr.ok) {
    $('#tag').textContent = 'Error';
    $('#title').textContent = m.error || 'not found';
    return;
  }
  const cluster = s.cluster && s.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(s.cluster)}` : '';
  const solscan = (w) => `https://solscan.io/account/${encodeURIComponent(w)}${cluster}`;

  if (!m.member) {
    const label = m.github ? `@${m.github}` : shortWallet(m.wallet || id);
    document.title = `${label} // ${s.project.name}`;
    $('#avatar').src = m.github ? avatar(m.github, 160) : identicon(m.wallet || id);
    $('#avatar').dataset.fallback = identicon(id);
    if (m.github) $('#avatar').classList.add('gh-avatar');
    $('#title').textContent = label;
    $('#tag').textContent = 'Not a member';
    $('#tag').classList.add('no');
    $('#not-member').hidden = false;
    $('#nm-text').textContent = m.github
      ? `@${m.github} has not joined ${s.project.name} yet. If this is your GitHub account, paste the line below into your coding agent: it links your account to your wallet with a public gist, registers you and starts proving the official way.`
      : `This wallet has not joined ${s.project.name} yet. If it is yours, paste the line below into your coding agent: it links your GitHub account to this wallet with a public gist, registers you and starts proving the official way.`;
    let line = `Read ${s.url}/join.txt and follow it.`;
    if (m.github) line += ` My GitHub is @${m.github}.`;
    if (m.wallet) line += ` Pay my rewards to ${m.wallet}.`;
    $('#nm-line').textContent = line;
    $('[data-copy]').addEventListener('click', async (e) => {
      await copyText($('#nm-line').textContent);
      e.target.textContent = 'Copied';
    });
    return;
  }

  document.title = `@${m.github} // ${s.project.name}`;
  $('#avatar').src = avatar(m.github, 160);
  $('#avatar').dataset.fallback = identicon(m.wallet);
  $('#avatar').classList.add('gh-avatar');
  $('#title').textContent = `@${m.github}`;
  $('#tag').textContent = 'Member';
  $('#meta').innerHTML = [
    `<a href="https://github.com/${encodeURIComponent(m.github)}" target="_blank" rel="noopener">github.com/${esc(m.github)} ↗</a>`,
    `joined ${esc(ymd(m.joined_at))} UTC`,
    m.last_proof_at ? `last credited proof ${esc(ago(m.last_proof_at))}` : 'no credited proof yet',
    m.gist ? `<a href="${esc(m.gist)}" target="_blank" rel="noopener">verified by gist ↗</a>` : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  $('#mnums').hidden = false;
  countTo($('#m-steps'), m.steps);
  countTo($('#m-24'), m.steps_24h);
  $('#m-paid').textContent = solAmount(m.paid);
  $('#m-owed').textContent = solAmount(m.owed);
  $('#m-owed-s').textContent = +m.owed > 0 && +m.owed < +s.rewards.min_payout ? `SOL earned, sent once it reaches ${s.rewards.min_payout}` : 'SOL earned, sent with the next distribution';
  $('#m-official').textContent = fmt(m.official_steps);
  $('#m-official-link').href = m.official_url || `${PNP}/a/${encodeURIComponent(m.github)}`;
  $('#m-wallet').textContent = shortWallet(m.wallet);
  $('#m-solscan').href = solscan(m.wallet);

  $('#lemmas-sec').hidden = false;
  $('#lemmas').innerHTML = m.credits.length
    ? m.credits.map((c) => `
      <tr>
        <td><a href="${esc(PNP)}/lemma.html#${encodeURIComponent(c.id)}" target="_blank" rel="noopener"><b>${esc(c.id)}</b></a>${c.kind ? ` <span class="kind">${esc(c.kind)}</span>` : ''}</td>
        <td class="wrap">${esc(c.title)}</td>
        <td class="muted">${esc(ymd(c.at))}</td>
        <td>${c.revoked ? '<span class="badge no">withdrawn</span>' : c.paid_in ? '<span class="badge paid">in payout</span>' : '<span class="badge no">pending</span>'}</td>
        <td class="hide-s">${c.pr_url ? `<a href="${esc(c.pr_url)}" target="_blank" rel="noopener">#${esc(c.pr_url.split('/').pop())} ↗</a>` : `<span class="muted">${esc(c.id)}</span>`}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">No credited proof yet. Every proof the official board credits to @${esc(m.github)} from now on counts.</td></tr>`;

  if (m.payments.length) {
    $('#pay-sec').hidden = false;
    $('#payments').innerHTML = m.payments.map((p) => `
      <tr>
        <td class="muted">${esc(ymd(p.at))}</td>
        <td class="r"><b>${esc(p.amount)} SOL</b></td>
        <td class="hide-s muted">${esc(shortWallet(p.wallet))}</td>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(String(p.sig).slice(0, 10))}… ↗</a></td>
      </tr>`).join('');
  }
  if (m.wallets.length) {
    $('#wallets-sec').hidden = false;
    $('#wallets').innerHTML = m.wallets.map((w) => `
      <tr>
        <td><a href="${esc(solscan(w.wallet))}" target="_blank" rel="noopener">${esc(shortWallet(w.wallet))} ↗</a></td>
        <td class="muted">${esc(ymd(w.since))}</td>
        <td>${w.current ? '<span class="badge yes">current</span>' : '<span class="badge no">earlier</span>'}</td>
        <td>${w.gist ? `<a href="${esc(w.gist)}" target="_blank" rel="noopener">gist ↗</a>` : '—'}</td>
      </tr>`).join('');
  }
}

setInterval(() => { $('#clock').textContent = new Date().toISOString().slice(11, 19); }, 1000);
main().catch((e) => { console.error(e); $('#tag').textContent = 'Error'; });

import { $, fmt, ymd, ago, esc, copyText, countTo, fillProject, identicon, solAmount } from '/ui.js';

const PNP = 'https://pequalnp.com';
const wallet = decodeURIComponent(location.pathname.split('/')[2] || '');
const short = (w) => `${w.slice(0, 4)}…${w.slice(-4)}`;

async function main() {
  const [mr, sr] = await Promise.all([fetch(`/api/member/${encodeURIComponent(wallet)}`), fetch('/api/state')]);
  const s = await sr.json();
  fillProject(s.project, s.rewards, s.handle);
  const m = await mr.json();
  if (!mr.ok) {
    $('#tag').textContent = 'ERROR';
    $('#title').textContent = m.error || 'not found';
    return;
  }
  const cluster = s.cluster && s.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(s.cluster)}` : '';
  $('#avatar').src = identicon(wallet);

  if (!m.member) {
    document.title = `${short(wallet)} // ${s.project.name}`;
    $('#title').textContent = short(wallet);
    $('#tag').textContent = 'NOT A MEMBER';
    $('#tag').classList.add('no');
    $('#not-member').hidden = false;
    $('#nm-text').textContent = `This wallet has not joined ${s.project.name} yet. If it is yours, paste the line below into your coding agent: it registers this wallet and starts proving.`;
    $('#nm-line').textContent = `Read ${s.url}/join.txt and follow it. Pay my rewards to ${wallet}.`;
    $('[data-copy]').addEventListener('click', async (e) => {
      await copyText($('#nm-line').textContent);
      e.target.textContent = 'COPIED';
    });
    return;
  }

  document.title = `${m.display} // ${s.project.name}`;
  $('#title').textContent = m.display;
  $('#tag').textContent = 'TEAM MEMBER';
  $('#meta').innerHTML = [
    `joined ${esc(ymd(m.joined_at))} UTC`,
    m.name ? esc(short(wallet)) : '',
    m.last_proof_at ? `last proof ${esc(ago(m.last_proof_at))}` : 'no accepted proof yet',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  $('#mnums').hidden = false;
  countTo($('#m-steps'), m.steps);
  countTo($('#m-24'), m.steps_24h);
  $('#m-paid').textContent = solAmount(m.paid);
  $('#m-owed').textContent = solAmount(m.owed);
  $('#m-owed-s').textContent = +m.owed > 0 && +m.owed < +s.rewards.min_payout ? `SOL earned, sent once it reaches ${s.rewards.min_payout}` : 'SOL earned, sent with the next distribution';
  $('#m-state').textContent = m.active ? 'WORKING' : 'IDLE';
  $('#m-state').style.color = m.active ? 'var(--acc)' : '';
  $('#m-state-s').textContent = m.working_on ? `on ${m.working_on}` : 'no step held right now';
  $('#m-wallet').textContent = short(wallet);
  $('#m-solscan').href = `https://solscan.io/account/${wallet}${cluster}`;

  $('#lemmas-sec').hidden = false;
  $('#lemmas').innerHTML = m.credits.length
    ? m.credits.map((c) => `
      <tr>
        <td><a href="${PNP}/lemma.html#${encodeURIComponent(c.id)}" target="_blank" rel="noopener"><b>${esc(c.id)}</b></a></td>
        <td class="wrap">${esc(c.title)}</td>
        <td class="muted">${esc(ymd(c.at))}</td>
        <td>${c.revoked ? '<span class="badge no">withdrawn</span>' : c.paid_in ? '<span class="badge paid">in payout</span>' : '<span class="badge no">pending</span>'}</td>
        <td class="hide-s">${c.pr_url ? `<a href="${esc(c.pr_url)}" target="_blank" rel="noopener">PR ↗</a>` : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">NO ACCEPTED PROOF YET. THE FIRST ONE IS THE HARDEST.</td></tr>`;

  if (m.payments.length) {
    $('#pay-sec').hidden = false;
    $('#payments').innerHTML = m.payments.map((p) => `
      <tr>
        <td class="muted">${esc(ymd(p.at))}</td>
        <td class="r"><b>${esc(p.amount)} SOL</b></td>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.sig.slice(0, 10))}… ↗</a></td>
      </tr>`).join('');
  }
  if (m.submissions.length) {
    $('#subs-sec').hidden = false;
    const tone = { ACCEPTED: 'yes', REJECTED: 'no', FAULT: 'no', pending: 'no' };
    $('#subs').innerHTML = m.submissions.map((x) => `
      <tr>
        <td><b>${esc(x.gap || '—')}</b></td>
        <td class="muted">${esc(ymd(x.at))}</td>
        <td><span class="badge ${tone[x.verdict] || 'no'}">${esc(String(x.verdict).toLowerCase())}</span></td>
        <td>${x.pr ? `<a href="${esc(x.pr)}" target="_blank" rel="noopener">${esc(x.pr.split('/').slice(-2).join(' #'))} ↗</a>` : ''}</td>
      </tr>`).join('');
  }
}

setInterval(() => { $('#clock').textContent = new Date().toISOString().slice(11, 19); }, 1000);
main().catch((e) => { console.error(e); $('#tag').textContent = 'ERROR'; });

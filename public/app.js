// Valiant's Conjecture // public site. Vanilla, no build step. Everything comes from /api/state,
// which our server builds from the official pequalnp.com export and our own ledger.
import { $, $$, fmt, hhmmss, ago, ymd, esc, copyText, toast, countTo, fillProject, looksSolana, looksLogin, normLogin, avatarImg, solAmount, shortWallet } from '/ui.js';

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
let PNP = 'https://pequalnp.com';
let S = null;
let firstPaint = true;

async function load() {
  const r = await fetch('/api/state', { cache: 'no-store' });
  if (!r.ok) throw new Error(`state: HTTP ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ the map: every lemma, grouped by program
const C = { checked: '#9DC8AC', open: '#E2DED4', dead: '#F1EEE7', acc: '#2B6FD6', fg: '#1B1A17', dim: '#6B665B' };
const FONT = '"JetBrains Mono", ui-monospace, monospace';
const SANS = 'Inter, system-ui, sans-serif';

class Atlas {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.cells = []; // { id, st, g }
    this.groups = []; // { title, n, proven, start, y0, rows }
    this.byId = new Map();
    this.flash = new Map(); // cell index -> start time
    this.hover = -1;
    this.t0 = performance.now();
    this.visible = true;
    this.raf = 0;
    this.last = 0;
    this.W = 0;
    new ResizeObserver(() => { if (this.c.clientWidth !== this.W) { this.layout(); this.kick(); } }).observe(canvas);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.kick(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => this.kick());
    document.fonts?.ready.then(() => this.kick());
  }

  set(programs, memberIds) {
    const ours = new Set(memberIds);
    const cells = [];
    const groups = [];
    for (const p of programs) {
      const g = { title: p.title, n: p.status.length, proven: 0, start: cells.length };
      for (let i = 0; i < p.status.length; i++) {
        const id = `L-${p.key}-${String(i + 1).padStart(3, '0')}`;
        let st = p.status[i];
        if (st === 'c') { g.proven++; if (ours.has(id)) st = 'o'; }
        cells.push({ id, st, g: groups.length });
      }
      groups.push(g);
    }
    const now = performance.now();
    if (this.cells.length) {
      cells.forEach((cell, i) => {
        const prev = this.byId.get(cell.id);
        if (prev && prev.st !== cell.st) this.flash.set(i, now);
      });
    }
    this.cells = cells;
    this.groups = groups;
    this.byId = new Map(cells.map((c) => [c.id, c]));
    // The groups were rebuilt above without their positions (y0, rows), so lay them out on every refresh: laying out
    // only when the counts changed left NaN positions after the first 15-second refresh and the map went blank.
    this.layout();
    this.kick();
  }

  layout() {
    const W = this.c.clientWidth;
    if (!W) return;
    const step = W >= 760 ? 10 : W >= 480 ? 9 : W >= 380 ? 8 : 7;
    const gap = step >= 9 ? 2 : 1;
    const cols = Math.max(1, Math.floor((W + gap) / step));
    const LABEL = 22;
    const SPACE = 14;
    let y = 0;
    for (const g of this.groups) {
      y += LABEL;
      g.y0 = y;
      g.rows = Math.ceil(g.n / cols);
      y += g.rows * step + SPACE;
    }
    const H = Math.max(40, y - SPACE);
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.c.style.height = `${H}px`;
    this.c.width = Math.round(W * dpr);
    this.c.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(this, { W, H, step, gap, cols, inner: step - gap });
    this.draw(performance.now()); // resizing clears a canvas: never leave it blank, even in a hidden tab
  }

  at(x, y) {
    const { step, cols } = this;
    for (const g of this.groups) {
      if (y < g.y0 || y >= g.y0 + g.rows * step) continue;
      const col = Math.floor(x / step);
      const k = Math.floor((y - g.y0) / step) * cols + col;
      return col >= 0 && col < cols && k < g.n ? g.start + k : -1;
    }
    return -1;
  }

  xy(i) {
    const g = this.groups[this.cells[i].g];
    const k = i - g.start;
    return [(k % this.cols) * this.step, g.y0 + Math.floor(k / this.cols) * this.step];
  }

  kick() {
    if (!this.raf && this.visible && !document.hidden) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  frame(t) {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    if (t - this.last > 33) { this.last = t; this.draw(t); }
    this.kick();
  }

  draw(t) {
    const { ctx, inner, W } = this;
    if (!inner) return;
    ctx.clearRect(0, 0, W, this.H);
    const N = this.cells.length;
    const shown = REDUCE ? N : Math.floor(N * Math.min(1, (t - this.t0) / 1100));
    const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t / 280));

    ctx.textBaseline = 'alphabetic';
    for (const g of this.groups) {
      const ly = g.y0 - 9;
      ctx.font = `600 11px ${SANS}`;
      ctx.fillStyle = C.fg;
      ctx.textAlign = 'left';
      ctx.fillText(g.title.toUpperCase(), 0, ly);
      ctx.font = `400 11px ${FONT}`;
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'right';
      ctx.fillText(`${fmt(g.proven)} / ${fmt(g.n)} proven`, W, ly);
    }
    ctx.textAlign = 'left';

    for (let i = 0; i < shown; i++) {
      const [x, y] = this.xy(i);
      const st = this.cells[i].st;
      const f = this.flash.get(i);
      if (f !== undefined) {
        const d = t - f;
        if (d > 2400) this.flash.delete(i);
        else if (Math.floor(d / 200) % 2 === 0) { ctx.fillStyle = C.acc; ctx.fillRect(x, y, inner, inner); continue; }
      }
      if (st === 'c') { ctx.fillStyle = C.checked; ctx.fillRect(x, y, inner, inner); }
      else if (st === 'o') { ctx.fillStyle = C.acc; ctx.fillRect(x, y, inner, inner); }
      else if (st === 'w') {
        ctx.fillStyle = C.open;
        ctx.fillRect(x, y, inner, inner);
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = C.acc;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, inner - 2, inner - 2);
        ctx.globalAlpha = 1;
      } else if (st === 'j') { ctx.fillStyle = C.open; ctx.fillRect(x, y, inner, inner); }
      else { ctx.fillStyle = C.dead; ctx.fillRect(x, y, inner, inner); }
    }

    if (this.hover >= 0 && this.hover < N) {
      const [x, y] = this.xy(this.hover);
      ctx.strokeStyle = C.fg;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, inner + 4, inner + 4);
    }
  }
}

const STATUS = {
  c: 'Proven: accepted by the Lean checker',
  o: 'Proven by a member',
  j: 'Open: not proven yet',
  w: 'Being worked on right now',
  r: 'Refuted: shown false',
  x: 'Retired',
};

function wireAtlas(atlas) {
  const body = $('.atlas-body');
  const tip = $('#tip');
  const hide = () => { atlas.hover = -1; tip.hidden = true; atlas.c.style.cursor = ''; };
  atlas.c.addEventListener('mousemove', (e) => {
    const r = atlas.c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const i = atlas.at(x, y);
    if (i < 0) return hide();
    atlas.hover = i;
    const c = atlas.cells[i];
    const st = c.st === 'o' ? `Proven by a ${esc(S?.project.name || '')} member` : esc(STATUS[c.st] || c.st);
    tip.innerHTML = `<b>${esc(c.id)}</b><span class="st">${st}</span><br><span class="st">${esc(atlas.groups[c.g].title)} · click to open</span>`;
    tip.hidden = false;
    const left = Math.min(x + 16, r.width - tip.offsetWidth);
    const top = y + 18 + tip.offsetHeight > r.height ? y - tip.offsetHeight - 10 : y + 18;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${top}px`;
    atlas.c.style.cursor = 'pointer';
  });
  atlas.c.addEventListener('mouseleave', hide);
  atlas.c.addEventListener('click', () => {
    const c = atlas.cells[atlas.hover];
    if (c) window.open(`${PNP}/lemma.html#${encodeURIComponent(c.id)}`, '_blank', 'noopener');
  });
  body.addEventListener('touchstart', hide, { passive: true });
}

function renderLegend() {
  let proven = 0, open = 0, work = 0, ours = 0;
  for (const p of S.programs) {
    for (const ch of p.status) {
      if (ch === 'c') proven++;
      else if (ch === 'j') open++;
      else if (ch === 'w') work++;
    }
  }
  for (const c of atlas.cells) if (c.st === 'o') ours++;
  $('#lg-checked').textContent = fmt(proven);
  $('#lg-open').textContent = fmt(open);
  $('#lg-work').textContent = fmt(work);
  $('#lg-ours').textContent = fmt(ours);
}

// ------------------------------------------------------------------ P = NP? : the operator is the open question
function swapOp() {
  if (REDUCE) return;
  const op = $('#op');
  let eq = true;
  setInterval(() => {
    op.classList.add('out');
    setTimeout(() => {
      eq = !eq;
      op.textContent = eq ? '=' : '≠';
      op.classList.remove('out');
    }, 230);
  }, 3400);
}

// ------------------------------------------------------------------ ticker
const KIND = { lemma_checked: 'PROVEN', lemma_proposed: 'PROPOSED', lemma_retired: 'RETIRED', lemma_refuted: 'REFUTED', attempt_started: 'ATTEMPT', attempt_dead: 'DEAD END' };
let tickerTop = null;
function renderTicker(feed) {
  if (!feed.length || feed[0].seq === tickerTop) return;
  tickerTop = feed[0].seq;
  const items = feed.map((e) => {
    const who = e.by
      ? e.member
        ? `<a href="/m/${encodeURIComponent(e.by)}">@${esc(e.by)}</a>`
        : `<a href="${PNP}/a/${encodeURIComponent(e.by)}" target="_blank" rel="noopener">@${esc(e.by)}</a>`
      : '';
    const lemma = e.lemma_id ? `<a href="${PNP}/lemma.html#${encodeURIComponent(e.lemma_id)}" target="_blank" rel="noopener">${esc(e.lemma_id)}</a>` : '';
    const label = KIND[e.kind] || esc(String(e.kind).replace(/_/g, ' ').toUpperCase());
    return `<span class="ti${e.member ? ' team' : ''}"><span class="t">${hhmmss(e.at)}</span><span class="kd k-${esc(e.kind)}">${label}</span>${lemma}${who}</span>`;
  }).join('');
  const track = $('#ticker');
  track.innerHTML = items + items; // doubled for a seamless loop
  requestAnimationFrame(() => track.style.setProperty('--dur', `${Math.max(40, track.scrollWidth / 2 / 60)}s`));
}

// ------------------------------------------------------------------ numbers
function renderNums() {
  const c = S.official.counters || {};
  const t = S.team;
  countTo($('[data-n="checked"]'), c.checked);
  $('#n-checked-s').textContent = `of ${fmt(c.lemmas)} stated · ${fmt(c.checked_last_hour)} in the last hour`;
  countTo($('[data-n="agents"]'), S.official.agents_now);
  $('#n-agents-s').textContent = `${fmt(S.official.agents_fleet)} fleet · ${fmt(S.official.agents_public)} outside`;
  countTo($('[data-n="outside"]'), S.official.outside.steps);
  $('#n-outside-s').textContent = `by ${fmt(S.official.outside.count)} outside provers`;
  countTo($('[data-n="members"]'), t.members);
  $('#n-members-s').textContent = `${fmt(t.active_24h)} proved in the last 24 h`;
  countTo($('[data-n="proofs"]'), t.proofs);
  $('#n-proofs-s').textContent = t.proofs_24h ? `+${fmt(t.proofs_24h)} in the last 24 h` : 'credited to members since joining';
  $('#n-paid').textContent = solAmount(t.paid);
  $('#n-paid-s').textContent = +t.owed > 0 ? `SOL · ${solAmount(t.owed)} on its way` : 'SOL, on-chain';
  $('#h-agents').textContent = fmt(S.official.agents_now);
}

// ------------------------------------------------------------------ board
function renderBoard() {
  const body = $('#board-body');
  if (!S.board.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No members on the board yet. <b>Row 001 is open.</b><br>Link your GitHub at the top of the page, or paste your line into your agent.</td></tr>`;
    return;
  }
  body.innerHTML = S.board.map((m, i) => `
    <tr>
      <td class="rank">${String(i + 1).padStart(3, '0')}</td>
      <td><a class="who" href="/m/${encodeURIComponent(m.login)}">${avatarImg(m.github, 'ident', 48, m.wallet)}@${esc(m.github)}</a></td>
      <td class="r steps">${fmt(m.steps)}</td>
      <td class="r hide-s">${m.steps_24h ? `+${fmt(m.steps_24h)}` : '·'}</td>
      <td class="r hide-s">${+m.paid > 0 ? `${solAmount(m.paid)} SOL` : '<span class="muted">—</span>'}</td>
      <td>${m.active ? `<span class="state on">proving · ${esc(ago(m.last_proof_at))}</span>` : `<span class="state off">${m.last_proof_at ? `idle · ${esc(ago(m.last_proof_at))}` : `joined ${esc(ago(m.joined_at))}`}</span>`}</td>
    </tr>`).join('');
}

// ------------------------------------------------------------------ joining: GitHub, wallet, gist, verify
let WALLET = '';
let GITHUB = '';
let SHELL = 'sh';
try {
  WALLET = localStorage.getItem('payout-wallet') || '';
  GITHUB = localStorage.getItem('github-login') || '';
  SHELL = localStorage.getItem('shell') === 'ps' ? 'ps' : 'sh';
} catch {}
if (!looksSolana(WALLET)) WALLET = '';
if (!looksLogin(GITHUB)) GITHUB = '';

const A = '<address>';
const L = '<login>';
const fill = (tpl, login, wallet) => String(tpl || '').replaceAll(A, wallet || A).replaceAll(L, login || L);

function promptLine() {
  let line = `Read ${S?.url || location.origin}/join.txt and follow it.`;
  if (GITHUB) line += ` My GitHub is @${GITHUB}.`;
  if (WALLET) line += ` Pay my rewards to ${WALLET}.`;
  return line;
}

function renderPrompt() {
  const line = promptLine();
  $('#one-line').textContent = line;
  $('#t-line').textContent = line;
  const name = S?.project.name || "Valiant's Conjecture";
  const as = GITHUB ? ` as @${GITHUB}` : '';
  $('#skill-say').textContent = WALLET ? `"join ${name}${as} and pay my rewards to ${WALLET}"` : `"join ${name}${as}"`;
  if (S) {
    const j = S.join;
    $('#gist-line').textContent = fill(j.gist_line, GITHUB, WALLET || '<your Solana address>');
    $('#gist-cmd').textContent = fill(SHELL === 'ps' ? j.gist_ps : j.gist_sh, GITHUB, WALLET || '<your Solana address>');
    // No project name in these blocks beyond the gist description: they are pasted into a shell.
    $('#t-api').textContent = [
      '# 1. check that gh is signed in to your own GitHub account',
      'gh auth status',
      '',
      '# 2. publish the public gist that links your GitHub to your wallet',
      fill(j.gist_sh, GITHUB, WALLET),
      '',
      '# 3. register (once per wallet)',
      fill(j.register_sh, GITHUB, WALLET),
      '',
      `# 4. then follow the official instructions, with your own GitHub account`,
      `curl -s ${j.official_join}`,
    ].join('\n');
    $('#t-api-ps').textContent = [
      'gh auth status',
      fill(j.gist_ps, GITHUB, WALLET),
      fill(j.register_ps, GITHUB, WALLET),
      `Invoke-RestMethod ${j.official_join}`,
    ].join('\n');
  }
  $$('.shell-switch .sw').forEach((b) => {
    const on = b.dataset.shell === SHELL;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const hint = $('#cta-hint');
  if (WALLET) {
    hint.className = 'cta-hint good';
    hint.innerHTML = `Payouts go to <b>${esc(shortWallet(WALLET))}</b>. Your page: <a href="/m/${encodeURIComponent(WALLET)}">proofs and transfers →</a>`;
  } else {
    hint.className = 'cta-hint';
    hint.textContent = 'Connecting only reads your address. It never asks you to sign or send anything.';
  }
}

function store(k, v) {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {}
}

function setWallet(w) {
  WALLET = w;
  store('payout-wallet', w);
  const input = $('#wallet');
  if (input.value.trim() !== w) input.value = w;
  input.classList.remove('bad');
  renderPrompt();
}

function setGithub(g) {
  GITHUB = g;
  store('github-login', g);
  $('#github').classList.remove('bad');
  renderPrompt();
}

async function connectWallet() {
  const prov = window.phantom?.solana || window.solflare || window.backpack || window.solana;
  if (!prov?.connect) {
    toast('No Solana wallet found in this browser. Paste your address.', 3200);
    $('#wallet').focus();
    return;
  }
  try {
    const r = await prov.connect();
    const pk = r?.publicKey || prov.publicKey;
    const w = pk?.toBase58 ? pk.toBase58() : String(pk || '');
    if (!looksSolana(w)) throw new Error('no address');
    setWallet(w);
    const b = $('#connect');
    b.textContent = 'Connected';
    b.classList.add('on');
  } catch {
    toast('Connection cancelled');
  }
}

function verifyOut(cls, html) {
  const out = $('#verify-out');
  out.className = `verify-out ${cls}`;
  out.innerHTML = html;
}

async function verify() {
  if (!GITHUB) { $('#github').focus(); return verifyOut('bad', 'Enter your GitHub username in step 1.'); }
  if (!WALLET) { $('#wallet').focus(); return verifyOut('bad', 'Add your Solana wallet in step 1.'); }
  const b = $('#verify');
  b.disabled = true;
  b.textContent = 'Checking…';
  verifyOut('', `Looking for the line in the public gists of <b>@${esc(GITHUB)}</b>…`);
  try {
    const r = await fetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github: GITHUB, wallet: WALLET }) });
    const j = await r.json().catch(() => ({}));
    if (j.ok) {
      const what = j.wallet_changed ? 'Wallet updated: from now on your payouts go to it.' : j.already_registered ? 'You are already a member with this wallet.' : 'Welcome to the team.';
      verifyOut('good', `<b>${esc(what)}</b> @${esc(j.github)} is a member since ${esc(ymd(j.joined_at))} UTC: every proof the official board credits to you from then on is paid in SOL. Now let your agent follow pequalnp.com's instructions with this GitHub account (the line below does it). <a href="/m/${encodeURIComponent(j.wallet)}">Your page →</a>`);
      load().then((s) => { const prev = S; S = s; render(prev); }).catch(() => {});
    } else {
      verifyOut('bad', `${esc(j.error || `Could not verify (HTTP ${r.status}). Try again in a minute.`)}${j.fix ? `<br><span class="muted">${esc(j.fix)}</span>` : ''}`);
    }
  } catch {
    verifyOut('bad', 'Could not reach the server. Try again in a minute.');
  } finally {
    b.disabled = false;
    b.textContent = 'Verify';
  }
}

function wireJoin() {
  const input = $('#wallet');
  const gin = $('#github');
  if (WALLET) input.value = WALLET;
  if (GITHUB) gin.value = GITHUB;
  $('#connect').addEventListener('click', connectWallet);
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v) return setWallet('');
    if (looksSolana(v)) return setWallet(v);
    input.classList.add('bad');
    const hint = $('#cta-hint');
    hint.className = 'cta-hint bad';
    hint.textContent = 'That is not a Solana address (32 to 44 letters and digits).';
  });
  gin.addEventListener('input', () => {
    const v = normLogin(gin.value);
    if (!v) return setGithub('');
    if (looksLogin(v)) return setGithub(v);
    gin.classList.add('bad');
    verifyOut('bad', 'A GitHub username has only letters, digits and hyphens.');
  });
  $$('.shell-switch .sw').forEach((b) => b.addEventListener('click', () => {
    SHELL = b.dataset.shell === 'ps' ? 'ps' : 'sh';
    store('shell', SHELL);
    renderPrompt();
  }));
  $('#verify').addEventListener('click', verify);
}

// ------------------------------------------------------------------ texts that depend on config
function renderConfig() {
  const p = S.project;
  const url = S.url;
  const skill = `join-${p.slug}`;
  PNP = S.official.site || PNP;
  fillProject(p, S.rewards);
  $$('[data-p="minpay"]').forEach((n) => (n.textContent = S.rewards.min_payout));
  document.title = `${p.name} // AI agents proving P vs NP`;
  $('#t-skill-sh').textContent = `mkdir -p ~/.claude/skills/${skill} && curl -fsSL ${url}/skill.md -o ~/.claude/skills/${skill}/SKILL.md`;
  $('#t-skill-ps').textContent = `New-Item -ItemType Directory -Force "$HOME\\.claude\\skills\\${skill}" | Out-Null; Invoke-WebRequest ${url}/skill.md -OutFile "$HOME\\.claude\\skills\\${skill}\\SKILL.md"`;
  $('#skill-cmd').textContent = `/${skill}`;
  $('#official-join').href = S.join.official_join;
  renderPrompt();

  const sp = S.rewards.split;
  const segs = $$('#split .seg');
  [sp.contributors, sp.sponsor, sp.ops].forEach((v, i) => {
    segs[i].style.flex = String(Math.max(v, 0.0001));
    segs[i].hidden = !v;
    segs[i].querySelector('b').textContent = `${v}%`;
  });
  const pay = $('#pay-link');
  if (S.pay_wallet) {
    pay.href = `https://solscan.io/account/${S.pay_wallet}${S.cluster && S.cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(S.cluster)}` : ''}`;
    pay.textContent = `team treasury ${shortWallet(S.pay_wallet)}`;
  } else {
    pay.removeAttribute('href');
    pay.textContent = 'team treasury (coming soon)';
  }

  $('#ca-text').textContent = p.ca ? `${p.ca.slice(0, 6)}…${p.ca.slice(-6)}` : 'NOT LAUNCHED';
  for (const [id, href] of [['#l-x', p.x], ['#l-tg', p.telegram], ['#l-pump', p.pumpUrl]]) {
    const a = $(id);
    if (href) { a.href = href; a.hidden = false; a.target = '_blank'; a.rel = 'noopener'; }
  }
}

function announce(prev, next) {
  if (!prev) return;
  const seen = new Set(prev.feed.map((e) => e.seq));
  const fresh = next.feed.filter((e) => !seen.has(e.seq) && e.member && e.kind === 'lemma_checked');
  if (fresh.length) toast(`+${fresh.length} ${next.project.name}: @${fresh[0].by} proved ${fresh[0].lemma_id}`, 4200);
}

// ------------------------------------------------------------------ wiring
function wire() {
  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await copyText($(b.dataset.copy).textContent);
    b.classList.add('done');
    const t = b.textContent;
    b.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => { b.textContent = t; b.classList.remove('done'); }, 1400);
  }));
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
    $$('.tabp').forEach((p) => p.classList.toggle('on', p.dataset.panel === t.dataset.tab));
  }));
  $('#ca').addEventListener('click', async () => {
    if (!S?.project.ca) return toast('Not launched yet');
    await copyText(S.project.ca);
    toast('Contract address copied');
  });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      if (e.target.id === 'split') e.target.classList.add('grow');
    }
  }, { threshold: 0.4 });
  $$('#split').forEach((n) => io.observe(n));
  setInterval(() => {
    $('#clock').textContent = new Date().toISOString().slice(11, 19);
    const ok = S?.sync?.ok ? Date.parse(S.sync.ok) : 0;
    $$('.dot').forEach((d) => d.classList.toggle('stale', !ok || Date.now() - ok > 3 * 60 * 1000));
  }, 1000);
}

function render(prev) {
  if (firstPaint) renderConfig();
  renderNums();
  renderTicker(S.feed);
  renderBoard();
  atlas.set(S.programs, S.member_lemmas);
  renderLegend();
  announce(prev, S);
  firstPaint = false;
}

const atlas = new Atlas($('#wall'));
wireAtlas(atlas);
swapOp();
wire();
wireJoin();
renderPrompt();

load()
  .then((s) => { S = s; render(null); })
  .catch((e) => { console.error(e); toast('Could not reach the record. Retrying.'); });
setInterval(async () => {
  try {
    const prev = S;
    S = await load();
    render(prev);
  } catch (e) {
    console.error(e);
  }
}, 15000);

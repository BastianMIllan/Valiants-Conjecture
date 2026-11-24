// Shared helpers for every page.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

export const fmt = (n) => (n === null || n === undefined || Number.isNaN(+n) ? '—' : Number(n).toLocaleString('en-US'));
export const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '--:--:--');
export const ymd = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '—');
export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

let toastTimer = 0;
export function toast(msg, ms = 1800) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

const GLYPHS = '01∀∃¬∧∨→↔⊢⊨λΣπ∞≠≤≥#%/<>∈∉⊂';
export function scramble(el, dur = 650) {
  const final = el.textContent;
  if (REDUCE) return;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const keep = Math.floor(final.length * p);
    let s = final.slice(0, keep);
    for (let i = keep; i < final.length; i++) s += final[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    el.textContent = s;
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = final;
  };
  requestAnimationFrame(step);
}

export function countTo(el, to, dur = 900) {
  if (!el) return;
  if (to === null || to === undefined || Number.isNaN(+to)) { el.textContent = '—'; return; }
  const from = +(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (REDUCE || from === +to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(2, -10 * p); // ease out expo
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A 5x5 mirrored block identicon for a wallet: the same wallet always draws the same mark.
export function identicon(seed, fg = '#ecece6', bg = '#121210') {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  let rects = '';
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      if (h & 1) {
        rects += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
        if (x < 2) rects += `<rect x='${4 - x}' y='${y}' width='1' height='1'/>`;
      }
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-1 -1 7 7' shape-rendering='crispEdges'><rect x='-1' y='-1' width='7' height='7' fill='${bg}'/><g fill='${fg}'>${rects}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const looksSolana = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
export const solAmount = (s) => Number(s || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });

// Replace the default project name, ticker and team account everywhere they are marked.
export function fillProject(p, rewards, handle) {
  $$('[data-p="name"]').forEach((n) => (n.textContent = p.name));
  $$('[data-p="ticker"]').forEach((n) => (n.textContent = p.ticker));
  if (handle) $$('[data-p="handle"]').forEach((n) => (n.textContent = `@${handle}`));
  if (rewards) $$('[data-p="split-c"]').forEach((n) => (n.textContent = rewards.split.contributors));
}

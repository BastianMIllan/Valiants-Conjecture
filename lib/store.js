// A tiny JSON-file database. One file, written atomically (temp file + rename),
// debounced so a burst of changes is one write. Good for thousands of members.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({
  version: 1,
  secret: crypto.randomBytes(32).toString('hex'),
  members: {}, // lower(handle) -> { handle, wallet, gist, joined_at, banned, note, wallets: [{wallet, gist, at}] }
  credits: {}, // lower(handle) -> { lemmaId -> { id, ref, title, at, kind, program, pr_url } }
  epochs: [], // [{ id, from, to, pool, unit, created_at, rows: [...], total_weight, paid: null | { tx, at } }]
});

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let db = EMPTY();
  if (fs.existsSync(file)) {
    try {
      db = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      const bad = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, bad);
      console.error(`[store] db.json unreadable, kept a copy at ${bad}; starting empty`);
    }
  }
  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };
  const save = () => {
    if (!timer) timer = setTimeout(flush, 250);
  };
  // Write once now so the secret is persisted on first boot.
  flush();
  process.on('exit', () => timer && flush());
  return { db, save, flush, file };
}

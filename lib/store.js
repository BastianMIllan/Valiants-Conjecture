// A tiny JSON-file database. One file, written atomically (temp file + rename),
// debounced so a burst of changes is one write. Good for thousands of members.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 2;

const EMPTY = () => ({
  version: VERSION,
  secret: crypto.randomBytes(32).toString('hex'),
  // lower(github) -> { github, github_id, wallet, joined_at, gist, wallets: [{ wallet, at, gist }], banned, note }
  members: {},
  // lemma id -> { id, github, login, wallet, at, ref, title, kind, pr_url, credited_at, alloc, revoked }
  // One record per lemma: a proof can be credited, and paid, only once.
  credits: {},
  // [{ id, from, to, pool, unit, created_at, rows: [{ wallet, github, steps, weight, lemmas, amount, ... }] }]
  epochs: [],
  // The treasury's books (owed, payments, batches, payout) are created by lib/payout.js.
});

// Version 1 sent members' proofs through the team's own GitHub account. Its member
// tables do not carry over: they are kept aside, untouched, and members start fresh.
// The treasury's books (owed, payments, batches, payout settings) and the allocation
// history (epochs) always carry over unchanged.
const V1_ONLY = ['members', 'credits', 'keys', 'submissions', 'unattributed', 'leases', 'assignments'];

function migrate(db) {
  if ((db.version || 1) >= VERSION) return false;
  const kept = {};
  for (const k of V1_ONLY) {
    const v = db[k];
    if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) kept[k] = v;
    delete db[k];
  }
  if (Object.keys(kept).length) db.archive_v1 = { ...kept, archived_at: new Date().toISOString() };
  db.members = {};
  db.credits = {};
  db.epochs ||= [];
  db.version = VERSION;
  return true;
}

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let db = EMPTY();
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (migrate(saved)) {
        const backup = `${file}.v1-${Date.now()}`;
        fs.copyFileSync(file, backup);
        console.log(`[store] upgraded the ledger to version ${VERSION}; the previous file is kept at ${backup}`);
      }
      db = { ...EMPTY(), ...saved };
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

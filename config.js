// Everything you would want to change lives here. Every value can also be set
// with an environment variable, so a deploy never needs a code edit.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const yes = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const handles = (v) => String(v || '').split(',').map((h) => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);

// PROJECT_MODE: "members" (default: members prove with their own GitHub and are paid in SOL) or "sponsor"
// (creator fees fund pequalnp.com through its official sponsor program; no sign-ups, no payouts).
const MODE = String(env.PROJECT_MODE || '').trim().toLowerCase() === 'sponsor' ? 'sponsor' : 'members';
if (env.PROJECT_MODE && !['members', 'sponsor'].includes(String(env.PROJECT_MODE).trim().toLowerCase())) {
  console.warn(`[config] PROJECT_MODE="${env.PROJECT_MODE}" is not "members" or "sponsor": running in members mode`);
}
// SPONSOR_PAYMENTS: optional JSON list of payments made to pequalnp.com, shown publicly in sponsor mode:
// [{"date":"2026-11-30","usd":100,"note":"Sponsor wall","link":"https://..."}]
function sponsorPayments(v) {
  if (!v) return [];
  try {
    const list = JSON.parse(v);
    if (!Array.isArray(list)) throw new Error('not a list');
    return list.slice(0, 50).map((p) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(p?.date || '')) ? String(p.date) : null,
      usd: Number.isFinite(+p?.usd) && +p.usd > 0 && +p.usd < 1e7 ? Math.round(+p.usd * 100) / 100 : null,
      note: typeof p?.note === 'string' ? p.note.slice(0, 120) : '',
      link: typeof p?.link === 'string' && /^https:\/\/[^\s"'<>]{1,300}$/.test(p.link) ? p.link : null,
    })).filter((p) => p.date && p.usd);
  } catch (e) {
    console.warn(`[config] SPONSOR_PAYMENTS is not a valid JSON list (${e.message}): ignored`);
    return [];
  }
}

export default {
  mode: MODE,
  sponsor: { payments: sponsorPayments(env.SPONSOR_PAYMENTS), founder: (env.FOUNDER_HANDLE || env.PNP_HANDLE || 'BastianMIllan').trim().replace(/^@/, '') },

  project: {
    name: env.PROJECT_NAME || "Valiant's Conjecture",
    ticker: env.TICKER || '$PvsNP',
    tagline: env.TAGLINE || 'Proof pays.',
    // Fill these in once the coin is live on pump.fun.
    ca: env.TOKEN_CA || '',
    pumpUrl: env.PUMP_URL || '',
    x: env.X_URL || '',
    telegram: env.TG_URL || '',
    // Short, lowercase id used in file names and the skill name.
    slug: (env.PROJECT_SLUG || 'pnp').toLowerCase().replace(/[^a-z0-9-]/g, ''),
  },

  // The address people reach the site at. join.txt and skill.md are written with it.
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ''),
  port: num(env.PORT, 3000),
  dataDir: env.DATA_DIR || path.join(here, 'data'),
  publicDir: path.join(here, 'public'),

  // Internal dashboard password. If empty, one is generated on first boot and
  // written to data/admin-token.txt.
  adminToken: env.ADMIN_TOKEN || '',

  // Sign-up attempts allowed per connection per minute (each one may cost a GitHub call).
  registerPerMinute: Math.max(1, num(env.REGISTER_PER_MINUTE, 10)),

  // The official effort. Members contribute there with their own GitHub accounts;
  // its public export is the only record of who proved what.
  pnp: {
    site: (env.PNP_SITE || 'https://pequalnp.com').replace(/\/$/, ''),
    data: (env.PNP_DATA || 'https://data.pequalnp.com/').replace(/\/?$/, '/'),
    repo: env.PNP_REPO || 'open-goat/pequalnp-proofs',
    // head.json (live counters, the map, the feed) is polled this often.
    syncSeconds: Math.max(10, num(env.SYNC_SECONDS, 30)),
    // The contributors record (who proved what) is fetched again at most this often.
    contributorsSeconds: Math.max(30, num(env.CONTRIBUTORS_REFRESH_SECONDS, 180)),
  },

  github: {
    api: (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
    // Gist contents are read only from here. Leave it alone outside the test suite.
    gistRaw: (env.GIST_RAW_BASE || 'https://gist.githubusercontent.com/').replace(/\/?$/, '/'),
    // Read-only token (a fine-grained token with no permissions). Required in production:
    // without it GitHub allows about 60 gist checks an hour from the server's address, so a
    // handful of people could block every sign-up.
    token: env.GITHUB_TOKEN || '',
    // The line a member publishes in a public gist: "<gistTag> wallet: <address>".
    gistTag: env.GIST_TAG || 'valiant-conjecture',
    // The team's own GitHub accounts. They can never register as members and their
    // proofs are never credited or paid: the team's own proving stays separate.
    // List every account the team proves with.
    handle: (env.PNP_HANDLE ?? 'BastianMIllan').trim().replace(/^@/, ''),
    formerHandles: handles(env.PNP_FORMER_HANDLES || 'PNPQED'),
  },

  // The live mirror of the founder's operator dashboard (/live). The publisher on the founder's
  // machine (npm run live) signs every snapshot with an Ed25519 key; the site only needs the public
  // key, as base64 of its SPKI DER (printed by npm run live:keygen). There is no built-in key:
  // empty or "off" switches the mirror off.
  live: {
    publicKey: String(env.LIVE_PUBKEY || '').trim(),
    // Snapshots accepted per connection per minute (the publisher sends two).
    postsPerMinute: Math.max(1, num(env.LIVE_POSTS_PER_MINUTE, 20)),
  },

  rewards: {
    // How creator fees are split (percent). Shown publicly on the site.
    // In sponsor mode the default is everything to the sponsorship fund (no provers' share).
    split: MODE === 'sponsor'
      ? { contributors: 0, sponsor: num(env.SPLIT_SPONSOR, 100), ops: num(env.SPLIT_OPS, 0) }
      : {
          contributors: num(env.SPLIT_CONTRIBUTORS, 70),
          sponsor: num(env.SPLIT_SPONSOR, 20), // back pequalnp.com's sponsor wall under the project's name
          ops: num(env.SPLIT_OPS, 10),
        },
    // Weight of one credited proof, by the lemma's kind in the official record.
    // Unknown kinds use `default`. Edit freely: e.g. { default: 1, target: 5 }.
    weights: { default: 1 },
  },

  // The team treasury: a Solana wallet whose key this server holds. Whenever it
  // receives funds, the server splits them across credited proofs not yet paid and
  // sends each member's share.
  payout: {
    rpc: env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    cluster: env.SOLANA_CLUSTER || 'mainnet-beta', // for explorer links
    secretKey: env.PAYOUT_SECRET_KEY || '', // else data/payout-key.json (npm run wallet)
    // master switch: nothing is ever sent while this is off. Sponsor mode has no member payouts, so it is always off there.
    enabled: yes(env.PAYOUTS_ENABLED) && MODE !== 'sponsor',
    intervalMinutes: Math.max(1, num(env.PAYOUT_INTERVAL_MINUTES, 10)),
    reserve: env.PAYOUT_RESERVE_SOL || '0.01', // never distributed: pays transaction fees
    minDistribution: env.MIN_DISTRIBUTION_SOL || '0.01', // new funds below this wait for more
    minPayout: env.MIN_PAYOUT_SOL || '0.001', // smaller balances accrue until they reach it
    priorityMicroLamports: num(env.PRIORITY_MICROLAMPORTS, 20000),
    confirmTimeoutSec: num(env.PAYOUT_CONFIRM_TIMEOUT_SEC, 90),
    pollMs: num(env.PAYOUT_POLL_MS, 2000),
    batchSize: num(env.PAYOUT_BATCH_SIZE, 15),
  },
};

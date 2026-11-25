// Everything you would want to change lives here. Every value can also be set
// with an environment variable, so a deploy never needs a code edit.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const yes = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const handles = (v) => String(v || '').split(',').map((h) => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);

export default {
  project: {
    name: env.PROJECT_NAME || "Valiant's Conjecture",
    ticker: env.TICKER || '$PNP',
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

  rewards: {
    // How creator fees are split (percent). Shown publicly on the site.
    split: {
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
    enabled: yes(env.PAYOUTS_ENABLED), // master switch: nothing is ever sent while this is off
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

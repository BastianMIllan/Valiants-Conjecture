// Everything you would want to change lives here. Every value can also be set
// with an environment variable, so a deploy never needs a code edit.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const yes = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

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

  // The official effort. The desk hands out steps; the export is the public record.
  pnp: {
    site: (env.PNP_SITE || 'https://pequalnp.com').replace(/\/$/, ''),
    data: (env.PNP_DATA || 'https://data.pequalnp.com/').replace(/\/?$/, '/'),
    repo: env.PNP_REPO || 'brilliant-hq/pequalnp-proofs',
    syncSeconds: Math.max(10, num(env.SYNC_SECONDS, 30)),
  },

  // The project's own GitHub account. It takes steps from the desk and opens every
  // pull request, so every accepted proof is credited to it on pequalnp.com.
  github: {
    api: (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
    handle: env.PNP_HANDLE || '', // e.g. BastianMIllan
    // Accounts the team used before the current one (comma-separated). Proofs the official
    // record lists under them keep counting for the members who wrote them.
    formerHandles: (env.PNP_FORMER_HANDLES || '').split(',').map((h) => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
    token: env.GITHUB_TOKEN || '', // classic token of that account, scope: public_repo
    xHandle: (env.PR_X_HANDLE || '').replace(/^@/, ''), // optional: shown on our credit card at pequalnp.com
  },

  desk: {
    maxLeases: num(env.DESK_MAX_LEASES, 5), // pequalnp allows a handle up to five steps at a time
    perMember: num(env.DESK_PER_MEMBER, 2), // steps one member may hold at once
    beatMinutes: 9, // we renew each lease with the desk this often (it lasts 20 min)
    idleMinutes: 25, // a step no member renewed for this long is handed back
    gapMs: num(env.DESK_GAP_MS, 3000), // at most one desk request every 3 s ("be gentle")
  },

  rewards: {
    // How creator fees are split (percent). Shown publicly on the site.
    split: {
      contributors: num(env.SPLIT_CONTRIBUTORS, 70),
      sponsor: num(env.SPLIT_SPONSOR, 20), // back pequalnp.com's sponsor wall under the project's name
      ops: num(env.SPLIT_OPS, 10),
    },
    // Weight of one accepted step, by the lemma's kind in the official record.
    // Unknown kinds use `default`. Edit freely: e.g. { default: 1, target: 5 }.
    weights: { default: 1 },
  },

  // The pay wallet: a plain Solana wallet whose key this server holds. Fund it with
  // SOL whenever you like; the server splits new funds across unpaid accepted
  // proofs and sends them. No on-chain program is involved.
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

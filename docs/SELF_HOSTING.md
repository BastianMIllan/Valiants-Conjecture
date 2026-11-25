# Self-hosting Valiant's Conjecture

This guide is for running an instance of the Valiant's Conjecture server. Contributors don't need it: they join from
[pequalsnp.onrender.com](https://pequalsnp.onrender.com).

## How it works

Members contribute to [pequalnp.com](https://pequalnp.com) with their own GitHub accounts, following the official
instructions. The server never opens pull requests and never talks to the official repository: it links each
member's GitHub account to a Solana wallet, reads the official public record, and pays from the team treasury.

| Component | Role |
|---|---|
| Gist check (`lib/github.js`) | On registration, reads the member's public gists through GitHub's REST API and confirms that a gist owned by that account holds the exact line `valiant-conjecture wallet: <address>`. Gist contents are read only from `https://gist.githubusercontent.com/`; every request has a timeout and a size cap. |
| Official record (`lib/pnp.js`) | Polls `head.json` of the public export and fetches the contributors record (who proved what, by GitHub handle) at most every `CONTRIBUTORS_REFRESH_SECONDS`. Both record shapes are accepted, malformed rows are skipped, and the last good copy is kept when a fetch fails. |
| Ledger (`server.js`) | Credits every proof the record lists for a member's GitHub account at or after the moment they joined: one credit per lemma, ever. Each lemma's own file adds its kind and pull request when available. A proof that leaves the record before it is paid is withdrawn. |
| Treasury (`lib/payout.js`) | Distributes SOL from the team treasury to members' current wallets, one share per credited proof. |
| Site and dashboard (`public/`) | Public site with the three-step join, member pages, and an internal dashboard at `/admin`. |

The team's own GitHub accounts (`PNP_HANDLE`, `PNP_FORMER_HANDLES`) can never register, and their proofs are never
credited or paid, so the team's own proving always stays separate from members' rewards.

## Requirements

- Node.js 20 or newer, and a persistent disk for the ledger (`DATA_DIR`).
- A Solana RPC endpoint. A dedicated provider (Helius, QuickNode, Triton) is recommended for production.
- A read-only GitHub token, required in production: a fine-grained personal access token with no permissions.
  Without it, GitHub allows about 60 gist checks an hour from the server's address, and a few people can block
  every sign-up. The dashboard shows in red when no token is set or when GitHub refuses it.

## Setup

1. **Team accounts.** Set `PNP_HANDLE` to the team's GitHub account and list every other account the team proves
   with in `PNP_FORMER_HANDLES` (default `PNPQED`). They are excluded from membership and payouts.
2. **Treasury.** Run `npm run wallet` to create the treasury keypair in `data/payout-key.json`, and keep a secure
   backup. On a host, provide it through the `PAYOUT_SECRET_KEY` environment variable instead.
3. **Deploy.** A [Dockerfile](../Dockerfile) is included. On Render, Railway or Fly, set `PUBLIC_URL` (on Render
   the service URL is detected automatically), `ADMIN_TOKEN`, `GITHUB_TOKEN`, `TRUST_PROXY=1`, and mount a
   persistent volume at `DATA_DIR`.
4. **Enable distributions.** Set `PAYOUTS_ENABLED=1`. Until then nothing is ever sent.

## Membership

- `POST /api/register?github=<login>&wallet=<address>` (or a JSON body with the same fields) checks the gist and
  registers the member. The join time is set at the first successful check and never changes.
- One GitHub account is one member, and a wallet belongs to one member for good (its current and earlier wallets).
  A member is tied to GitHub's numeric account id: if the username later belongs to another account, that account
  is refused.
- Registering again with a new wallet moves future credits and everything not sent yet to the new wallet. It needs
  a gist created after the member's last wallet change, so an old gist that still names an earlier wallet can never
  move them back. Payments already made stay in the history. The change is refused for a few minutes while a
  transfer to the previous wallet is still being confirmed, so an amount can never be owed twice.
- A wallet the treasury already has books for (a balance, payments or transfers) but no member owns, such as a
  version 1 wallet, cannot be registered.
- Attempts are rate-limited per connection (`REGISTER_PER_MINUTE`), per GitHub account and overall, and requests a
  browser makes from another site are refused. A user GitHub does not know is remembered for five minutes. A GitHub
  rate limit is reported to the member as a request to try again in a few minutes.
- From the dashboard, a member can be banned (they leave the board, their new proofs stop counting and nothing more
  is sent) and unbanned (proofs made in between count again).

## Treasury distributions

Every `PAYOUT_INTERVAL_MINUTES` (default 10) the server:

1. confirms any transfer still in flight, by its signature;
2. keeps `PAYOUT_RESERVE_SOL` (default 0.01) for network fees;
3. if new funds of at least `MIN_DISTRIBUTION_SOL` are available and there are credited proofs not yet rewarded,
   splits them across those proofs, one share each, to each member's current wallet;
4. sends every member whose balance reached `MIN_PAYOUT_SOL` (default 0.001), up to 15 transfers per transaction.

Every batch is recorded with its signature before it is broadcast and counted as paid only once it is confirmed
on-chain. A transaction that expired without landing is retried; one that landed while its confirmation was lost is
recognised by its signature. A failed batch is retried one transfer at a time, and a wallet that fails three times
is held for review. The dashboard shows the treasury balance, every transfer with its Solscan link, and controls to
run a distribution immediately or pause.

## Configuration

All settings live in [config.js](../config.js) and can be set through environment variables
(see [.env.example](../.env.example)).

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | the Render service URL (`RENDER_EXTERNAL_URL`) | the site's address; must be set on any other host, because join.txt, skill.md and the register commands are written with it |
| `ADMIN_TOKEN` | generated | dashboard password |
| `DATA_DIR` | `./data` | ledger location (persistent disk) |
| `PNP_HANDLE` | `BastianMIllan` | the team's GitHub account: never a member, never paid |
| `PNP_FORMER_HANDLES` | `PNPQED` | every other account the team proves with, comma-separated: never members, never paid |
| `GITHUB_TOKEN` | empty | read-only token for gist checks, required in production (no permissions needed) |
| `REGISTER_PER_MINUTE` | 10 | sign-up attempts per connection per minute |
| `PNP_SITE` | `https://pequalnp.com` | the official site, for links and its join instructions |
| `PNP_DATA` | `https://data.pequalnp.com/` | the official public export |
| `PNP_REPO` | `open-goat/pequalnp-proofs` | the official repository, for pull request links |
| `GIST_TAG` | `valiant-conjecture` | first word of the gist line `<tag> wallet: <address>` |
| `SYNC_SECONDS` | 30 | how often `head.json` (live counters, map, feed) is read |
| `CONTRIBUTORS_REFRESH_SECONDS` | 180 | minimum time between two fetches of the contributors record |
| `PAYOUT_SECRET_KEY` | `data/payout-key.json` | treasury key (64-byte secret key, JSON array or base58) |
| `PAYOUTS_ENABLED` | off | master switch for distributions |
| `SOLANA_RPC`, `SOLANA_CLUSTER` | mainnet | RPC endpoint and cluster name for explorer links |
| `PAYOUT_INTERVAL_MINUTES` | 10 | distribution interval |
| `PAYOUT_RESERVE_SOL`, `MIN_DISTRIBUTION_SOL`, `MIN_PAYOUT_SOL` | 0.01 / 0.01 / 0.001 | thresholds |
| `PROJECT_NAME`, `TICKER`, `PROJECT_SLUG` | `Valiant's Conjecture`, `$PNP`, `pnp` | branding |
| `TOKEN_CA`, `PUMP_URL`, `X_URL`, `TG_URL` | empty | links shown on the site |
| `SPLIT_CONTRIBUTORS`, `SPLIT_SPONSOR`, `SPLIT_OPS` | 70 / 20 / 10 | fee split shown on the site |
| `TRUST_PROXY` | off | the number of reverse proxies in front of the server (`1` for one): the client address is read that many entries from the right of `X-Forwarded-For` |

Per-kind weights (for example, to reward hard steps more) are in `config.js` under `rewards.weights`. When weights
by kind are set, a proof is distributed once its kind is known from its file in the record.

`GIST_RAW_BASE` and `GITHUB_API` exist for the test suite, which points them at a local simulation. Leave them unset
in production.

### Upgrading from version 1

Version 1 sent members' proofs through the team's GitHub account. On its first start, version 2 upgrades the
ledger in place: the version 1 member tables (members, credits, API keys, submissions, desk leases) are set aside
under `archive_v1`, a copy of the previous file is written next to it (`db.json.v1-<time>`), and members start fresh.
The treasury's books (owed balances, payments, batches, settings) and the allocation history carry over unchanged.

What version 1 had already allocated keeps being paid: a balance owed to a version 1 member's wallet is sent to that
same wallet by the next distributions, as version 1 would have, unless that member was banned. Such wallets, and any
other wallet with books but no member, cannot be registered in version 2, so nobody can claim a version 1 balance
by naming its wallet in a gist. Version 1 credits that were never allocated are not paid by version 2: if they
should be, run a last distribution on version 1 before upgrading.

These version 1 variables are no longer read and can be removed: `PR_X_HANDLE`, `DESK_MAX_LEASES`,
`DESK_PER_MEMBER`, `DESK_GAP_MS`. `GITHUB_TOKEN` keeps its name but is now a read-only token: replace a token with
write scopes by one with no permissions (do not remove it: without a token, sign-ups are easy to block). If
`PNP_REPO` is set to the former `brilliant-hq/pequalnp-proofs`, remove it or set it to `open-goat/pequalnp-proofs`,
or pull request links are dropped.

## Security

- The treasury key is held by the server. Keep in the treasury only what is due for distribution.
- Members provide public addresses only. No API keys or passwords are issued or stored.
- Outside data (the official record, GitHub's answers, gist contents) is size-capped and time-limited, and every
  outside string is escaped before it is shown.
- Dependencies are pinned to exact versions. `@solana/web3.js` is pinned to 1.98.4 (versions 1.95.6 and 1.95.7
  were a known compromise). `npm audit` reports known transitive advisories in the Solana 1.x stack that concern
  parsing responses from the configured RPC endpoint.

## Tests

`npm test` runs 102 end-to-end checks against a local simulation of the official public record, GitHub's gist API
and gist host, and a Solana node that verifies every signature and applies every transfer. It covers the gist check
(valid, owned by someone else, secret, missing line, other hosts, unknown users, rate limits, a refused token), team
accounts, requests from other sites and forged proxy headers, crediting from the join time, duplicate, moved and
malformed records, both record shapes, a failed record fetch, withdrawn and already-paid proofs, proportional
distributions, wallet changes and replayed old gists, usernames that pass to another account, transfers that are
dropped, lose their confirmation, or are in flight during a restart, and the upgrade of a version 1 ledger,
including its balances.

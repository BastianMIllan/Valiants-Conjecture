// The instructions an owner hands to their agent: /join.txt (plain) and
// /skill.md (the same, as an Agent Skill for Claude Code and compatible agents),
// plus the exact commands the site shows for linking a GitHub account to a wallet.
import config from '../config.js';
import { gistLineOf } from './verify.js';

const ADDR = '<address>';
const LOGIN = '<login>';

export const gistLine = (wallet = ADDR) => gistLineOf(config.github.gistTag, wallet);
export const gistFile = () => `${config.github.gistTag.split('-')[0] || 'payout'}.txt`;
// Safe inside double quotes in bash and PowerShell.
const gistDesc = () => `${config.project.name.replace(/["`$\\]/g, '')} payout address`;

// The one command that publishes the gist, for bash (macOS, Linux, Git Bash) or PowerShell.
export function gistCommand(shell, wallet = ADDR) {
  const tail = `gh gist create --public -d "${gistDesc()}" -f ${gistFile()} -`;
  if (shell === 'ps') return `"${gistLine(wallet)}" | ${tail}`;
  return `printf '${config.github.gistTag} wallet: %s\\n' "${wallet}" | ${tail}`;
}

export function registerCommand(shell, github = LOGIN, wallet = ADDR) {
  const url = `${config.publicUrl}/api/register?github=${github}&wallet=${wallet}`;
  if (shell === 'ps') return `Invoke-RestMethod -Method Post "${url}"`;
  return `curl -s -X POST "${url}"`;
}

export function joinTxt() {
  const { name, ticker } = config.project;
  const url = config.publicUrl;
  const site = config.pnp.site;
  const s = config.rewards.split;
  const NAME = name.toUpperCase();
  const host = site.replace(/^https?:\/\//, '');
  const record = config.pnp.data.replace(/\/$/, '');

  return `JOIN ${NAME}: GET PAID IN SOL FOR YOUR P VS NP PROOFS
${url}/join.txt: instructions for an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI,
or any agent that can run a shell, git, gh and Lean on its owner's machine).

WHAT THIS IS
${host} runs an open attack on P vs NP: every step is a statement in Lean 4, and a step counts
only when the official proof checker accepts a proof of it. Contributors work with their own
GitHub account and are credited by GitHub handle on the official board.
${name} is an independent team that pays its members in SOL for that work. Your owner
links their GitHub account to a Solana wallet once, with a public gist. Then you follow
${host}'s official instructions with your owner's own GitHub account: the pull requests and
the points on the official board are theirs. For every proof the official board credits to
their GitHub account after they joined, ${name} pays them in SOL.
Keep taking steps, one after another, until your owner tells you to stop.

TELL YOUR OWNER BEFORE YOU START
- This runs on their machine with their own model usage. ${name} charges nothing.
- They need their own GitHub account, with the GitHub CLI gh signed in to it. Never ask them
  for a token or a password.
- Payment goes to a Solana wallet ADDRESS (the public one, 32 to 44 characters). Never ask for,
  accept, store or repeat a private key, seed phrase or recovery words. If they paste one, do
  not use it, and tell them that wallet is compromised and to move its funds.
- What becomes public: a gist on their GitHub account holding one line with their Solana
  address (it links the two publicly); through ${host}, their Lean files, GitHub handle and
  profile picture; and, on the ${name} board, their handle, wallet and credited proofs.
- Rewards are paid in SOL from the team treasury, one share per credited proof. Amounts depend
  on creator fees and are not guaranteed. ${name} is an independent team, not affiliated
  with ${host}.

STEP 1. CHECK THE GITHUB ACCOUNT
       gh auth status
       gh api user --jq .login
The login it prints is <login>. Make sure it is your owner's own account. If gh is not signed
in, ask your owner to run  gh auth login  themselves. Never ask for a token.
Your owner's message may already name the wallet ("pay my rewards to <address>"). If not, ask.

STEP 2. PUBLISH THE GIST (once per wallet)
A public gist on that account must hold exactly this line:
       ${gistLine()}
bash (macOS, Linux, Git Bash):
       ${gistCommand('sh')}
PowerShell:
       ${gistCommand('ps')}
It must be public (--public). gh prints the address of the new gist.

STEP 3. REGISTER
bash:
       ${registerCommand('sh')}
PowerShell:
       ${registerCommand('ps')}
"ok": true means your owner is a member from now on (see "joined_at"). If "ok" is false,
"error" says what to fix. A gist published a moment ago can take a minute to show on GitHub:
wait a minute and register again. Then tell your owner:
       Joined ${name} as @<login>. Proofs and SOL payouts: ${url}/m/<address>

STEP 4. PROVE, THE OFFICIAL WAY
Read ${site}/join.txt and follow it exactly. It is the official way to contribute and the
only instruction for the proving work. Use your owner's own GitHub account (the one from
step 1) for the desk, the fork and the pull requests. Nothing goes through ${name}:
no file is ever sent to us, and we never open pull requests for anyone.

HOW PAY WORKS
- Source of truth: the public record at ${record} (who proved what, by GitHub
  handle). ${name} reads it every few minutes and judges nothing itself.
- Every proof that record credits to your owner's GitHub account after the moment they
  registered counts once. Proofs from before they joined do not count.
- Each distribution from the team treasury is split across credited proofs not paid yet, one
  share per proof, and sent to members' wallets automatically. Balances under
  ${config.payout.minPayout} SOL roll over until they reach it.
- Creator fees of ${ticker}: ${s.contributors}% to provers, ${s.sponsor}% to back ${host} itself, ${s.ops}% to run the team.
- New wallet: publish a new gist with the new address (a gist from before the last change
  does not count) and register again with the same GitHub account. From then on, payouts go
  to the new address, including anything not sent yet. You can then delete the old gist.
- Progress and payouts: ${url}/m/<address>

LIMITS
Register once per wallet; there is nothing else to call here. For the desk and the pull
requests, keep to ${host}'s own limits.
`;
}

export function skillMd() {
  const { name, ticker, slug } = config.project;
  const url = config.publicUrl;
  const site = config.pnp.site.replace(/^https?:\/\//, '');
  return `---
name: join-${slug}
description: Join the ${name} team (${ticker}) and get paid in SOL for proving open P vs NP steps in Lean 4 for the official effort at ${site}, with your own GitHub account. Links the user's GitHub account to their Solana wallet with a public gist, registers them, then follows ${site}'s official join instructions. Use when the user asks to join ${name}, to work on P vs NP, to prove lemmas for ${site}, or to get paid for proofs.
---

# ${name}: prove P vs NP steps with your own GitHub, get paid in SOL

The live version of these instructions is at ${url}/join.txt. Fetch it first
(bash: \`curl -s ${url}/join.txt\`; PowerShell: \`Invoke-RestMethod ${url}/join.txt\`):
if it differs from the copy below, the live one wins.

${joinTxt()}`;
}

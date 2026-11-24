// Creates the pay wallet: a new Solana keypair saved to data/payout-key.json.
// The server reads it from there (or from the PAYOUT_SECRET_KEY env var).
// Usage: npm run wallet
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import config from '../config.js';

const file = path.join(config.dataDir, 'payout-key.json');
if (fs.existsSync(file)) {
  console.error(`A pay wallet already exists at ${file}. Delete it first only if it holds no funds.`);
  process.exit(1);
}
fs.mkdirSync(config.dataDir, { recursive: true });
const kp = Keypair.generate();
fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log(`Pay wallet created.
  address  ${kp.publicKey.toBase58()}   <- send SOL here to fund payouts
  key      ${file}                       <- secret: back it up somewhere safe, never share it
On a host, you can instead put the contents of that file in the PAYOUT_SECRET_KEY env var.`);

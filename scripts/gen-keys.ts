// Generates every secret BSA Sentry needs into .env (mode 600, gitignored).
// Refuses to overwrite an existing .env: secrets are generated exactly once.
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { generateMnemonic, english, mnemonicToAccount, generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ARC_CHAIN_ID, ARC_RPC_URL, USDC_ADDRESS } from './chain.js';

const ENV_PATH = new URL('../.env', import.meta.url).pathname;
if (existsSync(ENV_PATH)) {
  console.error(`.env already exists at ${ENV_PATH} - refusing to overwrite.`);
  process.exit(1);
}

// A fresh seed for Speculos. NEVER the public default seed: it is shared by everyone.
const seed = generateMnemonic(english);
const main = mnemonicToAccount(seed, { path: "m/44'/60'/0'/0/0" });   // 0xMAIN  (identity)
const agent = mnemonicToAccount(seed, { path: "m/44'/60'/1'/0/0" });  // 0xAGENT (pays)

const keys = {
  TREASURY_PRIVATE_KEY: generatePrivateKey(),
  FACILITATOR_PRIVATE_KEY: generatePrivateKey(),
  ISSUER_PRIVATE_KEY: generatePrivateKey(),
  MERCHANT_CAFE_PRIVATE_KEY: generatePrivateKey(),
  MERCHANT_CAVE_PRIVATE_KEY: generatePrivateKey(),
  MERCHANT_RESTO_PRIVATE_KEY: generatePrivateKey(),
  MERCHANT_EVIL_PRIVATE_KEY: generatePrivateKey(),
};
const addr = (pk: `0x${string}`) => privateKeyToAccount(pk).address;

writeFileSync(ENV_PATH, `# BSA Sentry secrets - generated ${new Date().toISOString()}. TESTNET ONLY. Never commit.
CHAIN=arc
ARC_RPC_URL=${ARC_RPC_URL}
CHAIN_ID=${ARC_CHAIN_ID}
USDC_ADDRESS=${USDC_ADDRESS}

# Speculos (Flex emulator). Fresh random seed, not Speculos' public default.
SPECULOS_SEED="${seed}"
SPECULOS_MAIN_ADDRESS=${main.address}
SPECULOS_AGENT_ADDRESS=${agent.address}

# Funding / infrastructure
TREASURY_PRIVATE_KEY=${keys.TREASURY_PRIVATE_KEY}
TREASURY_ADDRESS=${addr(keys.TREASURY_PRIVATE_KEY)}
FACILITATOR_PRIVATE_KEY=${keys.FACILITATOR_PRIVATE_KEY}
FACILITATOR_ADDRESS=${addr(keys.FACILITATOR_PRIVATE_KEY)}
ISSUER_PRIVATE_KEY=${keys.ISSUER_PRIVATE_KEY}
ISSUER_ADDRESS=${addr(keys.ISSUER_PRIVATE_KEY)}

# Merchant payTo addresses (one per merchant, distinct)
MERCHANT_CAFE_PRIVATE_KEY=${keys.MERCHANT_CAFE_PRIVATE_KEY}
MERCHANT_CAFE_ADDRESS=${addr(keys.MERCHANT_CAFE_PRIVATE_KEY)}
MERCHANT_CAVE_PRIVATE_KEY=${keys.MERCHANT_CAVE_PRIVATE_KEY}
MERCHANT_CAVE_ADDRESS=${addr(keys.MERCHANT_CAVE_PRIVATE_KEY)}
MERCHANT_RESTO_PRIVATE_KEY=${keys.MERCHANT_RESTO_PRIVATE_KEY}
MERCHANT_RESTO_ADDRESS=${addr(keys.MERCHANT_RESTO_PRIVATE_KEY)}
MERCHANT_EVIL_PRIVATE_KEY=${keys.MERCHANT_EVIL_PRIVATE_KEY}
MERCHANT_EVIL_ADDRESS=${addr(keys.MERCHANT_EVIL_PRIVATE_KEY)}

SESSION_SECRET=${randomBytes(32).toString('hex')}
`);
chmodSync(ENV_PATH, 0o600);

console.log('.env written (mode 600). Addresses only below - no secret is printed.\n');
console.log('  FUND THESE TWO AT https://faucet.circle.com (Arc Testnet USDC)');
console.log(`  treasury     ${addr(keys.TREASURY_PRIVATE_KEY)}   <- as many faucet requests as allowed`);
console.log(`  facilitator  ${addr(keys.FACILITATOR_PRIVATE_KEY)}   <- once (it pays gas in USDC)\n`);
console.log('  Derived from SPECULOS_SEED (funded later from the treasury):');
console.log(`  0xMAIN   m/44'/60'/0'/0/0  ${main.address}`);
console.log(`  0xAGENT  m/44'/60'/1'/0/0  ${agent.address}\n`);
console.log('  Other roles:');
console.log(`  issuer       ${addr(keys.ISSUER_PRIVATE_KEY)}`);
for (const m of ['CAFE', 'CAVE', 'RESTO', 'EVIL'] as const) {
  console.log(`  ${m.toLowerCase().padEnd(12)} ${addr(keys[`MERCHANT_${m}_PRIVATE_KEY`])}`);
}

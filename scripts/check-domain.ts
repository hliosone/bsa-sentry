// Independent oracle: USDC's on-chain DOMAIN_SEPARATOR must equal the frozen fixture.
// This is what proves the device's hand-rolled keccak targets the real contract.
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { arcTestnet, USDC_ADDRESS } from './chain.js';

const fx = JSON.parse(readFileSync(new URL('../packages/types/fixtures/eip712.json', import.meta.url), 'utf8'));
const abi = [
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const c = createPublicClient({ chain: arcTestnet, transport: http() });
const [sep, name, version, decimals] = await Promise.all([
  c.readContract({ address: USDC_ADDRESS, abi, functionName: 'DOMAIN_SEPARATOR' }),
  c.readContract({ address: USDC_ADDRESS, abi, functionName: 'name' }),
  c.readContract({ address: USDC_ADDRESS, abi, functionName: 'version' }),
  c.readContract({ address: USDC_ADDRESS, abi, functionName: 'decimals' }),
]);
console.log(`  on-chain  name=${JSON.stringify(name)} version=${JSON.stringify(version)} decimals=${decimals}`);
console.log(`  on-chain  DOMAIN_SEPARATOR ${sep}`);
console.log(`  fixture   domainSeparator  ${fx.payment.domainSeparator}`);
if (sep !== fx.payment.domainSeparator) { console.error('  MISMATCH'); process.exit(1); }
if (name !== 'USDC' || version !== '2' || decimals !== 6) { console.error('  domain fields changed on chain'); process.exit(1); }
console.log('  MATCH - the payment fixture targets the real Arc USDC contract');

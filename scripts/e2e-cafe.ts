// M3 acceptance, on the REAL Arc testnet:
//
//   agent API -> relay -> bridge (Node harness) -> Speculos signs silently -> merchant ->
//   our facilitator -> transferWithAuthorization mined on Arc
//
// then the prompt-injection path: /promo -> /evil/deposit -> refused by the device as
// OVER_HARD_MAX, and nothing reaches the chain.
//
//   E2E=1 pnpm e2e:cafe     (Speculos must be running: scripts/speculos.sh start --fresh)
import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import { formatUnits, parseEventLogs, type Hex } from 'viem';
import { decodeState, type Policy } from '@bsa-sentry/types';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import { createServer } from '../apps/server/src/app.js';
import { chainConfig, clients, USDC_ABI } from '../apps/server/src/chain.js';
import { createMerchantsApp } from '../apps/merchants/src/app.js';
import { startBridgeHarness } from './bridge-harness.js';
import * as ui from './speculos-ui.js';

if (process.env.E2E !== '1') {
  console.log('e2e-cafe spends real testnet USDC on Arc; run it with E2E=1');
  process.exit(0);
}

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from .env`);
  return v as Hex;
};

const ACCOUNT = 'e2e';
const USDC = 1_000_000n;
const cfg = chainConfig();
const { publicClient } = clients(cfg);
const payTo = {
  cafe: need('MERCHANT_CAFE_ADDRESS'), cave: need('MERCHANT_CAVE_ADDRESS'),
  resto: need('MERCHANT_RESTO_ADDRESS'), evil: need('MERCHANT_EVIL_ADDRESS'),
};
const agentAddress = need('SPECULOS_AGENT_ADDRESS');

let failures = 0;
const step = (m: string) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => { failures++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };
const expect = (cond: unknown, m: string) => (cond ? ok(m) : bad(m));

const balance = (a: Hex) =>
  publicClient.readContract({ address: cfg.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [a] });

async function main() {
  const signer = new SentrySigner(new SpeculosTransport());

  step('Device: demo policy + armed session (Speculos, simulated taps)');
  const policy: Policy = {
    active: true, chainId: BigInt(cfg.chainId), token: cfg.usdc.toLowerCase() as Hex,
    autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
    payees: [
      { address: payTo.cafe.toLowerCase() as Hex, label: 'Cafe Sat' },
      { address: payTo.cave.toLowerCase() as Hex, label: 'Cave du Coin' },
      { address: payTo.resto.toLowerCase() as Hex, label: 'Resto' },
    ],
  };
  const setting = signer.setPolicy(policy);
  await ui.approveReview();
  await setting;
  await ui.setSessionVia(async () => (await signer.getState()).sessionArmed, true);
  await ui.goHome();
  const agentOnDevice = await signer.getAddress('agent');
  expect(agentOnDevice === agentAddress.toLowerCase(), `device 0xAGENT ${agentOnDevice} matches .env`);

  const agentBalance = await balance(agentAddress);
  console.log(`  0xAGENT holds ${formatUnits(agentBalance, 6)} USDC on Arc`);
  if (agentBalance < 3n * USDC) throw new Error(`fund the Speculos agent first: pnpm fund ${agentAddress} 10`);

  step('Server (facilitator + relay + agent API), then the merchants');
  const server = createServer({
    chain: cfg,
    facilitatorKey: need('FACILITATOR_PRIVATE_KEY'),
    // In-process e2e: the harness IS the account's tab. Production authenticates the socket
    // with the Ledger login session (M4).
    authenticateSocket: () => ACCOUNT,
    log: (m) => console.log(`    ${m}`),
  });
  const serverPort = await server.listen(0);
  const merchants = await createMerchantsApp({
    facilitatorUrl: `http://127.0.0.1:${serverPort}/x402`,
    network: `eip155:${cfg.chainId}`,
    payTo,
    publicUrl: 'http://127.0.0.1:0', // replaced below once we know the port
  });
  const merchantsServer = merchants.listen(0);
  await new Promise((r) => merchantsServer.once('listening', r));
  const merchantsUrl = `http://127.0.0.1:${(merchantsServer.address() as AddressInfo).port}`;
  ok(`server :${serverPort}, merchants ${merchantsUrl}`);

  step('Bridge harness attaches to the relay');
  const harness = startBridgeHarness({ url: `ws://127.0.0.1:${serverPort}/relay` });
  for (let i = 0; i < 100 && !server.relay.status(ACCOUNT).agent; i++) await new Promise((r) => setTimeout(r, 100));
  const status = server.relay.status(ACCOUNT);
  expect(status.attached && status.flex === 'connected' && status.session, 'tab attached, Flex connected, session on');
  expect(status.agent === agentAddress.toLowerCase(), 'the tab reported the right 0xAGENT');

  try {
    step('Claude buys a coffee: GET /cafe (3 USDC, trusted payee, under the auto limit)');
    const cafeBefore = await balance(payTo.cafe);
    const started = Date.now();
    const coffee = await server.agent.fetch(ACCOUNT, { url: `${merchantsUrl}/cafe` });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (coffee.kind !== 'paid') {
      bad(`expected a paid result, got ${JSON.stringify(coffee)}`);
    } else {
      ok(`served in ${elapsed}s: ${coffee.content}`);
      expect(coffee.receipt.amount === '3', 'receipt says 3 USDC');
      const tx = coffee.receipt.txHash;
      expect(!!tx, `settled on Arc: ${cfg.explorer}/tx/${tx}`);
      if (tx) {
        const receipt = await publicClient.getTransactionReceipt({ hash: tx });
        const transfers = parseEventLogs({ abi: USDC_ABI, eventName: 'Transfer', logs: receipt.logs })
          .filter((l) => l.address.toLowerCase() === cfg.usdc.toLowerCase());
        expect(receipt.status === 'success', 'transaction succeeded');
        expect(transfers.length === 1 && transfers[0]!.args.value === 3n * USDC
          && transfers[0]!.args.from.toLowerCase() === agentAddress.toLowerCase()
          && transfers[0]!.args.to.toLowerCase() === payTo.cafe.toLowerCase(),
          'exactly one USDC Transfer: 3 USDC from 0xAGENT to the café');
        const cafeAfter = await publicClient.readContract({
          address: cfg.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [payTo.cafe], blockNumber: receipt.blockNumber,
        });
        expect(cafeAfter - cafeBefore === 3n * USDC, `café balance +3 USDC (pinned to block ${receipt.blockNumber})`);
      }
    }
    const state = await signer.getState();
    expect(state.spent === 3n * USDC, `device budget: ${formatUnits(state.policy.budget - state.spent, 6)} / 20 USDC left`);

    step('The prompt injection: read /promo, then try the "mandatory" 400 USDC deposit');
    const promo = await server.agent.fetch(ACCOUNT, { url: `${merchantsUrl}/promo` });
    expect(promo.kind === 'free' && /evil\/deposit/.test(promo.content), '/promo is free and carries the hidden instruction');
    const evilBefore = await balance(payTo.evil);
    const deposit = await server.agent.fetch(ACCOUNT, { url: `${merchantsUrl}/evil/deposit` });
    expect(deposit.kind === 'refused' && deposit.reason === 'OVER_HARD_MAX', `refused by the Flex: ${deposit.kind === 'refused' ? deposit.message : JSON.stringify(deposit)}`);
    expect((await signer.getState()).spent === 3n * USDC, 'nothing more spent on the device');
    expect((await balance(payTo.evil)) === evilBefore, 'nothing reached the evil address on chain');
  } finally {
    harness.stop();
    await server.close();
    await new Promise((r) => merchantsServer.close(() => r(null)));
  }

  console.log(failures === 0 ? '\n\x1b[32mM3 e2e passed\x1b[0m' : `\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\ne2e could not run:', e);
  process.exit(2);
});

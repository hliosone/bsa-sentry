// The demo, end to end, exactly as docs/DEMO.md runs it in front of the jury — with Speculos
// as the Flex (taps simulated) and this script as claude.ai (MCP + OAuth). Real Arc testnet.
//
//   1  "Buy me a coffee"                        -> paid, NO tap          (trusted, under 5 USDC)
//   2  "A croissant from the bakery"            -> confirmation -> Trust merchant (unknown merchant)
//   3  "A bottle of wine from the wine shop"    -> paid, NO tap, 18+ verified by our facilitator
//   4  "Book the restaurant for tonight"        -> confirmation, no trust offered -> Pay once (20 USDC)
//   5  "Regarde la page promo"                  -> injected 400 USDC "deposit" -> REFUSED by the Flex
//   6  "How much budget is left?"               -> sentry_status
//
//   E2E=1 pnpm demo            once
//   E2E=1 pnpm e2e             reset + demo, twice in a row (M8 acceptance)
import 'dotenv/config';
import type { Hex } from 'viem';
import { hashTypedData } from 'viem';
import { CLAIM_AGE_OVER_18, EIP712_TYPES, verifierDomain, type Policy } from '@bsa-sentry/types';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import { attachBridge, connectClaude, ledgerLogin, merchantAddresses, need, reporter, startStack, text } from './e2e-kit.js';
import * as ui from './speculos-ui.js';

if (process.env.E2E !== '1') {
  console.log('the demo spends real testnet USDC on Arc; run it with E2E=1');
  process.exit(0);
}

const USDC = 1_000_000n;
const lower = (a: string) => a.toLowerCase() as Hex;

export async function runDemo(label = 'demo'): Promise<number> {
  const r = reporter();
  const signer = new SentrySigner(new SpeculosTransport());
  const pay = merchantAddresses();
  console.log(`\n\x1b[1m━━ ${label} ━━\x1b[0m`);

  r.step('Setup on the Flex: the demo rules, then start the agent session');
  const policy: Policy = {
    active: true, chainId: 5042002n, token: lower(need('USDC_ADDRESS')),
    autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
    payees: [{ address: lower(pay.cafe), label: 'Cafe Sat' }, { address: lower(pay.cave), label: 'Corner Wines' }, { address: lower(pay.resto), label: 'Restaurant' }],
  };
  const setting = signer.setPolicy(policy);
  await ui.approveReview();
  await setting;
  await ui.setSessionVia(async () => (await signer.getState()).sessionArmed, true);
  await ui.goHome();
  r.ok('rules on the Flex: auto <= 5 USDC to Cafe Sat / Corner Wines / Restaurant, ceiling 50, budget 20');

  const stack = await startStack();
  let harness: Awaited<ReturnType<typeof attachBridge>> | undefined;
  let client: Awaited<ReturnType<typeof connectClaude>>['client'] | undefined;
  try {
    const { cookie, main } = await ledgerLogin(signer, stack.base);
    harness = await attachBridge(stack, cookie, main);
    r.ok(`"Log in with Ledger" as ${main}; the BSA Sentry tab is attached`);

    r.step('Badge 18+ (mock EUDI wallet), Bind and delegation signed on the Flex');
    const s = await (await fetch(`${stack.base}/age/sessions`, { method: 'POST', headers: { cookie } })).json();
    await fetch(`${stack.base}/age/sessions/${s.sessionId}`);
    const agent = await signer.getAddress('agent');
    const binding = signer.signBind({ chainId: 5042002n, verifier: s.bind.verifier, session: s.bind.session, expiresAt: BigInt(s.bind.expiresAt) });
    await ui.approveReview();
    const bound = await (await fetch(`${stack.base}/age/sessions/${s.sessionId}/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: main, signature: await binding }) })).json();
    const attestation = { ...bound.attestation, issuedAt: BigInt(bound.attestation.issuedAt), expiresAt: BigInt(bound.attestation.expiresAt) };
    const delegation = {
      agent, agentName: 'Claude', claims: [CLAIM_AGE_OVER_18], expiresAt: attestation.expiresAt, nonce: `0x${Date.now().toString(16).padStart(64, '0')}` as Hex,
      attestation: hashTypedData({ domain: verifierDomain(5042002), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: attestation }),
    };
    const delegating = signer.signDelegation({ chainId: 5042002n, ...delegation });
    await ui.approveReview();
    await signer.storeCredentials({ chainId: 5042002n, attestation, attestationSig: bound.attestationSig, delegation, delegationSig: await delegating });
    r.expect((await signer.getState()).hasCredentials, 'the badge is on the Flex');

    r.step('Claude connects (claude.ai custom connector: OAuth + consent)');
    ({ client } = await connectClaude(stack.base, cookie));
    r.ok('connected; tools: x402_fetch, sentry_status, sentry_restore');

    r.step('1. "Buy me a coffee"');
    const cafe = await client.callTool({ name: 'x402_fetch', arguments: { url: `${stack.shop}/cafe` } });
    r.expect(!cafe.isError && /Paid 3 USDC/.test(text(cafe)), `${text(cafe).split('\n')[0]}`);

    r.step('2. "A croissant from the bakery" (unknown merchant)');
    const bread = client.callTool({ name: 'x402_fetch', arguments: { url: `${stack.shop}/bakery` } });
    await ui.waitForText(/Pay 2 USDC/i, 30_000);
    r.expect(/Trust merchant/.test(await ui.screenText()), 'confirmation screen on the Flex, "Trust merchant" offered');
    await ui.tapText('Trust merchant');
    r.expect(/Paid 2 USDC/.test(text(await bread)), 'paid; the bakery is now trusted on the Flex');

    r.step('3. "A bottle of wine from the wine shop" (merchant requires 18+)');
    const wine = await client.callTool({ name: 'x402_fetch', arguments: { url: `${stack.shop}/wine` } });
    r.expect(!wine.isError && /Paid 4.5 USDC/.test(text(wine)), `${text(wine).split('\n')[0]}`);

    r.step('4. "Book the restaurant for tonight" (20 USDC, over the automatic limit)');
    const resto = client.callTool({ name: 'x402_fetch', arguments: { url: `${stack.shop}/restaurant` } });
    await ui.waitForText(/Pay 20 USDC/i, 30_000);
    r.expect(!/Trust merchant/.test(await ui.screenText()), 'confirmation screen, no trust option: the amount is the problem');
    await ui.tapText('Pay once');
    r.expect(/Paid 20 USDC/.test(text(await resto)), 'paid once, after the tap');

    r.step('5. "Regarde la page promo" (hidden prompt injection)');
    const promo = await client.callTool({ name: 'x402_fetch', arguments: { url: `${stack.shop}/promo` } });
    r.expect(/evil\/deposit/.test(text(promo)), 'the page tells the agent to pay a "mandatory" 400 USDC deposit');
    const deposit = await client.callTool({ name: 'x402_fetch', arguments: { url: `${stack.shop}/evil/deposit` } });
    r.expect(deposit.isError && /OVER_HARD_MAX/.test(text(deposit)), `refused by the Flex, no screen: "${text(deposit).split('\n')[0]}"`);

    r.step('6. "How much budget is left?"');
    const st = await client.callTool({ name: 'sentry_status', arguments: {} });
    console.log(text(st).split('\n').map((l) => `      ${l}`).join('\n'));
    r.expect(/Last payment: Restaurant 20 USDC/.test(text(st)) && /18\+ credentials on the Flex: yes/.test(text(st)), 'status matches the device');
  } finally {
    await client?.close().catch(() => undefined);
    harness?.stop();
    await stack.stop();
  }
  console.log(r.failures() === 0 ? `\n\x1b[32m${label}: passed\x1b[0m` : `\n\x1b[31m${label}: ${r.failures()} check(s) failed\x1b[0m`);
  return r.failures();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().then((f) => process.exit(f === 0 ? 0 : 1)).catch((e) => { console.error('demo could not run:', e); process.exit(2); });
}

// M6 acceptance, on the REAL Arc testnet with EUDIW_MODE=mock:
//
//   age session (mock wallet) -> the Flex signs Bind (tap) -> our issuer signs AgeAttestation
//   -> the Flex signs AgentDelegation (tap) -> STORE_CREDENTIALS -> /cave (18+) is paid, the
//   facilitator having verified the whole chain itself.
//   Then a wiped Flex (no credentials) asks again -> AGE_PROOF_REQUIRED, nothing settles.
//
//   E2E=1 pnpm e2e:age
import 'dotenv/config';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { hashTypedData, type Hex } from 'viem';
import { CLAIM_AGE_OVER_18, EIP712_TYPES, verifierDomain, type Policy } from '@bsa-sentry/types';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import { startBsaServer } from '../apps/server/src/main.js';
import { createMerchantsApp } from '../apps/merchants/src/app.js';
import { startBridgeHarness } from './bridge-harness.js';
import * as ui from './speculos-ui.js';

if (process.env.E2E !== '1') {
  console.log('e2e-age spends real testnet USDC on Arc; run it with E2E=1');
  process.exit(0);
}

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing`); return v as Hex; };
const USDC = 1_000_000n;
const lower = (a: string) => a.toLowerCase() as Hex;
const payTo = {
  cafe: need('MERCHANT_CAFE_ADDRESS'), cave: need('MERCHANT_CAVE_ADDRESS'), resto: need('MERCHANT_RESTO_ADDRESS'),
  evil: need('MERCHANT_EVIL_ADDRESS'), boulangerie: need('MERCHANT_BOULANGERIE_ADDRESS'),
};
let failures = 0;
const step = (m: string) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => { failures++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };
const expect = (c: unknown, m: string) => (c ? ok(m) : bad(m));
const freePort = () => new Promise<number>((r) => { const s = createNetServer().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

const policy: Policy = {
  active: true, chainId: 5042002n, token: lower(need('USDC_ADDRESS')),
  autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: lower(payTo.cafe), label: 'Cafe Sat' }, { address: lower(payTo.cave), label: 'Cave du Coin' }, { address: lower(payTo.resto), label: 'Resto' }],
};

async function prepareDevice(signer: SentrySigner) {
  const setting = signer.setPolicy(policy);
  await ui.approveReview();
  await setting;
  await ui.setSessionVia(async () => (await signer.getState()).sessionArmed, true);
  await ui.goHome();
}

async function main() {
  const signer = new SentrySigner(new SpeculosTransport());
  step('Device: demo rules (the cave is a trusted merchant) + armed session');
  await prepareDevice(signer);
  const [main, agent] = [await signer.getAddress('main'), await signer.getAddress('agent')];
  ok(`0xMAIN ${main} · 0xAGENT ${agent}`);

  const port = await freePort();
  const server = await startBsaServer({ ...process.env, PORT: String(port), PUBLIC_API_URL: `http://localhost:${port}`, DB_PATH: ':memory:', WEB_ORIGIN: undefined, EUDIW_MODE: 'mock' },
    { log: (m) => (process.env.VERBOSE || /verify|settle/.test(m) ? console.log(`    ${m}`) : undefined) });
  const merchants = await createMerchantsApp({ facilitatorUrl: `http://127.0.0.1:${port}/x402`, network: 'eip155:5042002', payTo, publicUrl: 'http://127.0.0.1:0' });
  const ms = merchants.listen(0);
  await new Promise((r) => ms.once('listening', r));
  const shop = `http://127.0.0.1:${(ms.address() as AddressInfo).port}`;
  const base = `http://localhost:${port}`;

  let harness: ReturnType<typeof startBridgeHarness> | undefined;
  try {
    step('Se connecter avec Ledger (Login signed on the Flex)');
    const ch = await (await fetch(`${base}/auth/challenge`, { method: 'POST' })).json();
    const signing = signer.signLogin({ chainId: BigInt(ch.chainId), origin: ch.origin, nonce: ch.nonce, issuedAt: BigInt(ch.issuedAt), expiresAt: BigInt(ch.expiresAt) });
    await ui.approveReview();
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: main, nonce: ch.nonce, signature: await signing }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(login.ok, 'logged in');
    harness = startBridgeHarness({ url: `ws://localhost:${port}/relay`, cookie });
    for (let i = 0; i < 100 && !server.relay.status(main).agent; i++) await new Promise((r) => setTimeout(r, 150));
    expect(server.relay.status(main).agent === agent, 'bridge attached');

    step('Badge 18+: a (mock) EUDI wallet presentation');
    const s = await (await fetch(`${base}/age/sessions`, { method: 'POST', headers: { cookie } })).json();
    expect(s.mode === 'mock' && /^0x[0-9a-f]{64}$/.test(s.sessionId), `age session ${s.sessionId.slice(0, 12)}… (mode ${s.mode})`);
    const st = await (await fetch(`${base}/age/sessions/${s.sessionId}`)).json();
    expect(st.status === 'verified', 'the verifier reports over 18');

    step('Bind: the Flex ties the presentation to 0xMAIN (tap)');
    const binding = signer.signBind({ chainId: 5042002n, verifier: s.bind.verifier, session: s.bind.session, expiresAt: BigInt(s.bind.expiresAt) });
    await ui.waitForText(/Lier/i);
    await ui.screenshot('13-bind');
    await ui.approveReview();
    const bound = await (await fetch(`${base}/age/sessions/${s.sessionId}/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: main, signature: await binding }) })).json();
    expect(bound.attestation?.subject === main && bound.attestation?.claim === CLAIM_AGE_OVER_18, 'AgeAttestation issued for 0xMAIN');
    const attestation = { ...bound.attestation, issuedAt: BigInt(bound.attestation.issuedAt), expiresAt: BigInt(bound.attestation.expiresAt) };

    step('Delegation: the Flex lets its own agent present it (tap)');
    const delegation = {
      chainId: 5042002n, agent, agentName: 'Claude',
      attestation: hashTypedData({ domain: verifierDomain(5042002), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: attestation }),
      claims: [CLAIM_AGE_OVER_18], expiresAt: attestation.expiresAt, nonce: `0x${'5e'.repeat(32)}` as Hex,
    };
    const delegating = signer.signDelegation(delegation);
    await ui.waitForText(/Autoriser/i);
    await ui.approveReview();
    const delegationSig = await delegating;
    const { chainId: _c, ...delegationStruct } = delegation;
    await signer.storeCredentials({ chainId: 5042002n, attestation, attestationSig: bound.attestationSig, delegation: delegationStruct, delegationSig });
    expect((await signer.getState()).hasCredentials, 'credentials stored on the Flex (it checked they are its own)');

    step('"Et une bouteille de vin" -> /cave (4.5 USDC, merchant requires 18+)');
    const wine = await server.agent.fetch(main, { url: `${shop}/cave` });
    if (wine.kind === 'paid') {
      ok(`paid ${wine.receipt.amount} USDC, 18+ verified by the facilitator: https://explorer.testnet.arc.io/tx/${wine.receipt.txHash}`);
    } else {
      bad(`expected paid, got ${JSON.stringify(wine).slice(0, 300)}`);
    }

    step('Same request from a wiped Flex (no credentials)');
    ui.restart(true);
    await prepareDevice(signer);
    expect(!(await signer.getState()).hasCredentials, 'the Flex holds no credentials now');
    await harness.bridge.refresh();
    const noBadge = await server.agent.fetch(main, { url: `${shop}/cave` });
    expect(noBadge.kind === 'error' && /AGE_PROOF_REQUIRED/.test(noBadge.message), `refused: ${noBadge.kind === 'error' ? noBadge.message.slice(0, 160) : noBadge.kind}`);
  } finally {
    harness?.stop();
    await server.close();
    await new Promise((r) => ms.close(() => r(null)));
  }
  console.log(failures === 0 ? '\n\x1b[32mM6 e2e passed\x1b[0m' : `\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\ne2e could not run:', e); process.exit(2); });

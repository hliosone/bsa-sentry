// M7 acceptance, on Speculos + the REAL Arc testnet:
//
//   rules + a merchant trusted on the device + the 18+ badge
//   -> Key Ring backup (fake Key Ring: real AES-GCM; Ledger Sync cannot run in Speculos) -> vault
//   -> the Flex is WIPED (fresh NVM, same seed: what reinstalling the app does)
//   -> restore: vault -> decrypt -> RESTORE, reviewed and approved on the device (tap)
//   -> the cafe is paid again, the trusted bakery is silent again, the badge is back.
//
//   E2E=1 pnpm e2e:restore
import 'dotenv/config';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { hashTypedData, type Hex } from 'viem';
import { CLAIM_AGE_OVER_18, EIP712_TYPES, verifierDomain, type Credentials, type Policy } from '@bsa-sentry/types';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import { startBsaServer } from '../apps/server/src/main.js';
import { createMerchantsApp } from '../apps/merchants/src/app.js';
import { FakeKeyRing } from '../apps/web/src/keyring/fake.js';
import { runBackup, runRestore, type FlowDeps } from '../apps/web/src/keyring/flows.js';
import { startBridgeHarness } from './bridge-harness.js';
import * as ui from './speculos-ui.js';

if (process.env.E2E !== '1') {
  console.log('e2e-restore spends real testnet USDC on Arc; run it with E2E=1');
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

async function main() {
  const signer = new SentrySigner(new SpeculosTransport());
  const policy: Policy = {
    active: true, chainId: 5042002n, token: lower(need('USDC_ADDRESS')),
    autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
    payees: [{ address: lower(payTo.cafe), label: 'Cafe Sat' }, { address: lower(payTo.cave), label: 'Corner Wines' }, { address: lower(payTo.resto), label: 'Restaurant' }],
  };
  const arm = () => ui.setSessionVia(async () => (await signer.getState()).sessionArmed, true).then(() => ui.goHome());

  step('Device: rules + armed session');
  const setting = signer.setPolicy(policy);
  await ui.approveReview();
  await setting;
  await arm();
  const [main, agent] = [await signer.getAddress('main'), await signer.getAddress('agent')];

  const port = await freePort();
  const server = await startBsaServer({ ...process.env, PORT: String(port), PUBLIC_API_URL: `http://localhost:${port}`, DB_PATH: ':memory:', WEB_ORIGIN: undefined, EUDIW_MODE: 'mock' }, { log: () => {} });
  const merchants = await createMerchantsApp({ facilitatorUrl: `http://127.0.0.1:${port}/x402`, network: 'eip155:5042002', payTo, publicUrl: 'http://127.0.0.1:0' });
  const ms = merchants.listen(0);
  await new Promise((r) => ms.once('listening', r));
  const shop = `http://127.0.0.1:${(ms.address() as AddressInfo).port}`;
  const base = `http://localhost:${port}`;
  let harness: ReturnType<typeof startBridgeHarness> | undefined;

  try {
    step('Login + bridge');
    const ch = await (await fetch(`${base}/auth/challenge`, { method: 'POST' })).json();
    const signing = signer.signLogin({ chainId: BigInt(ch.chainId), origin: ch.origin, nonce: ch.nonce, issuedAt: BigInt(ch.issuedAt), expiresAt: BigInt(ch.expiresAt) });
    await ui.approveReview();
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: main, nonce: ch.nonce, signature: await signing }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    harness = startBridgeHarness({ url: `ws://localhost:${port}/relay`, cookie });
    for (let i = 0; i < 100 && !server.relay.status(main).agent; i++) await new Promise((r) => setTimeout(r, 150));
    expect(server.relay.status(main).agent === agent, 'logged in, bridge attached');

    step('Trust the bakery on the device ("Trust merchant")');
    const croissant = server.agent.fetch(main, { url: `${shop}/bakery` });
    await ui.waitForText(/Pay 2 USDC/i, 30_000);
    await ui.tapText('Trust merchant');
    expect((await croissant).kind === 'paid', 'paid, bakery now trusted on the device');

    step('18+ badge (mock wallet): Bind + delegation on the device, stored on the Flex');
    const s = await (await fetch(`${base}/age/sessions`, { method: 'POST', headers: { cookie } })).json();
    await fetch(`${base}/age/sessions/${s.sessionId}`);
    const binding = signer.signBind({ chainId: 5042002n, verifier: s.bind.verifier, session: s.bind.session, expiresAt: BigInt(s.bind.expiresAt) });
    await ui.approveReview();
    const bound = await (await fetch(`${base}/age/sessions/${s.sessionId}/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: main, signature: await binding }) })).json();
    const attestation = { ...bound.attestation, issuedAt: BigInt(bound.attestation.issuedAt), expiresAt: BigInt(bound.attestation.expiresAt) };
    const delegation = {
      agent, agentName: 'Claude',
      attestation: hashTypedData({ domain: verifierDomain(5042002), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: attestation }),
      claims: [CLAIM_AGE_OVER_18], expiresAt: attestation.expiresAt, nonce: `0x${'7a'.repeat(32)}` as Hex,
    };
    const delegating = signer.signDelegation({ chainId: 5042002n, ...delegation });
    await ui.approveReview();
    await signer.storeCredentials({ chainId: 5042002n, attestation, attestationSig: bound.attestationSig, delegation, delegationSig: await delegating });
    expect((await signer.getState()).hasCredentials, 'badge stored on the Flex');

    // The same dependencies the website uses, over Speculos instead of WebHID.
    const keyRing = new FakeKeyRing(`seed-of-${main}`);
    const deps = (onStage?: FlowDeps['onStage']): FlowDeps => ({
      readDevice: async () => {
        const st = await signer.getState();
        return { policy: st.policy.active ? st.policy : null, credentials: await signer.getCredentials() };
      },
      putVault: async (ciphertext) => {
        const r = await fetch(`${base}/vault/${main}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ciphertext }) });
        if (!r.ok) throw new Error(`vault PUT ${r.status}`);
      },
      getVault: async () => {
        const r = await fetch(`${base}/vault/${main}`, { headers: { cookie } });
        return r.ok ? (await r.json()).ciphertext : null;
      },
      withKeyRing: (fn) => fn(keyRing),
      restore: async (p, c) => {
        const pending = signer.restore(p, c);
        await ui.waitForText(/Restore/i);
        await ui.screenshot('14-restore-review');
        await ui.approveReview();
        await pending;
      },
      onStage,
    });

    step('Key Ring backup -> vault (ciphertext only)');
    const before = await signer.getState();
    expect(await runBackup(deps()) === 'backed_up', `backed up ${before.policy.payees.length} merchants + the badge`);
    const vault = await (await fetch(`${base}/vault/${main}`, { headers: { cookie } })).json();
    expect(!/Cafe|Bakery|age_over/.test(Buffer.from(vault.ciphertext, 'base64').toString('latin1')), 'the vault holds no readable rules');

    step('The Flex is wiped (app reinstalled: fresh NVM, same seed)');
    ui.restart(true);
    const wiped = await signer.getState();
    expect(!wiped.policy.active && !wiped.hasCredentials, 'no rules, no badge');

    step('Restore: vault -> decrypt -> RESTORE, reviewed and approved on the device');
    const stages: string[] = [];
    expect(await runRestore(deps((st) => stages.push(st!))) === 'restored', `restored (${stages.join(' -> ')})`);
    const after = await signer.getState();
    expect(after.policy.payees.map((p) => p.label).join(',') === before.policy.payees.map((p) => p.label).join(','), `merchants back: ${after.policy.payees.map((p) => p.label).join(', ')}`);
    expect(after.hasCredentials, 'badge back (the device re-checked it is its own)');
    expect(after.spent === 0n, 'a fresh budget');

    step('The agent works again');
    await arm();
    await harness.bridge.refresh();
    const coffee = await server.agent.fetch(main, { url: `${shop}/cafe` });
    expect(coffee.kind === 'paid', `cafe paid on Arc${coffee.kind === 'paid' ? `: ${coffee.receipt.txHash}` : ` -> ${JSON.stringify(coffee).slice(0, 200)}`}`);
    const bread = await server.agent.fetch(main, { url: `${shop}/bakery` });
    expect(bread.kind === 'paid', 'the bakery is still trusted: paid with no tap');
  } finally {
    harness?.stop();
    await server.close();
    await new Promise((r) => ms.close(() => r(null)));
  }
  console.log(failures === 0 ? '\n\x1b[32mM7 e2e passed\x1b[0m' : `\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('\ne2e could not run:', e); process.exit(2); });

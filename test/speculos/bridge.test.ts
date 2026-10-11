// M2 acceptance: the real bridge module, over a real WebSocket, signing on Speculos.
//
// A local WebSocket server plays our relay. It sends `sign_payment` exactly as the server
// will, and the signature that comes back must recover to 0xAGENT for those exact fields.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { recoverTypedDataAddress } from 'viem';
import {
  EIP712_TYPES, decodeState, encodeChunks, encodePolicy, paymentDomain, parseTabToServer,
  type Policy, type TabToServer,
} from '@bsa-sentry/types';
import { startBridgeHarness } from '../../scripts/bridge-harness.js';
import { INS, apdu, approveReview, setSession, unhex } from './client.js';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = (process.env.MERCHANT_CAFE_ADDRESS ?? '').toLowerCase();
const EVIL = (process.env.MERCHANT_EVIL_ADDRESS ?? '').toLowerCase();
const AGENT = (process.env.SPECULOS_AGENT_ADDRESS ?? '').toLowerCase();
const PORT = 18787;

const policy: Policy = {
  active: true, chainId: 5042002n, token: TOKEN,
  autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
  payees: [{ address: CAFE as `0x${string}`, label: 'Cafe Sat' }],
};

let wss: WebSocketServer;
let tab: WsSocket | undefined;
const received: TabToServer[] = [];
let harness: ReturnType<typeof startBridgeHarness>;

const waitFor = async <T>(pick: () => T | undefined, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = pick();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the bridge');
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  // A fresh device with the demo policy and an armed session.
  const set = apdu(encodeChunks(INS.SET_POLICY, encodePolicy(policy))[0]!);
  await approveReview();
  expect((await set).sw).toBe(0x9000);
  await setSession(true);

  wss = new WebSocketServer({ port: PORT });
  wss.on('connection', (socket) => {
    tab = socket;
    socket.on('message', (raw) => received.push(parseTabToServer(JSON.parse(String(raw)))));
  });
  harness = startBridgeHarness({ url: `ws://localhost:${PORT}` });
  await waitFor(() => tab);
});

afterAll(async () => {
  harness?.stop();
  await new Promise<void>((r) => wss.close(() => r()));
});

describe('the bridge over a real socket, signing on Speculos', () => {
  it('announces itself with a status message as soon as it connects', async () => {
    const status = await waitFor(() => received.find((m) => 'type' in m && m.type === 'status'));
    expect(status).toMatchObject({ type: 'status', flex: 'connected', session: true });
    // The state blob decodes to the policy we just installed.
    const state = decodeState(unhex((status as any).state));
    expect(state.policy.budget).toBe(20_000_000n);
  });

  it('turns sign_payment into a signature that recovers to 0xAGENT', async () => {
    const fields = {
      chainId: '5042002', token: TOKEN, to: CAFE, value: '3000000',
      validAfter: '0', validBefore: '4000000000', nonce: `0x${'c1'.repeat(32)}`,
    };
    tab!.send(JSON.stringify({ id: 'coffee', type: 'sign_payment', fields, hint: 'Cafe Sat', wantCredentials: false }));
    const reply = await waitFor(() => received.find((m) => 'id' in m && m.id === 'coffee'));
    expect(reply).toMatchObject({ id: 'coffee', ok: true });
    const { v, r, s } = (reply as any).signature;
    const signer = await recoverTypedDataAddress({
      domain: paymentDomain(5042002, TOKEN),
      types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: AGENT as `0x${string}`, to: CAFE as `0x${string}`, value: 3_000_000n,
        validAfter: 0n, validBefore: 4_000_000_000n, nonce: fields.nonce as `0x${string}`,
      },
      signature: `${r}${s.slice(2)}${v.toString(16)}` as `0x${string}`,
    });
    expect(signer.toLowerCase()).toBe(AGENT);
  });

  it('relays a device refusal with its reason, and nothing is signed', async () => {
    const fields = {
      chainId: '5042002', token: TOKEN, to: EVIL, value: '400000000',
      validAfter: '0', validBefore: '4000000000', nonce: `0x${'c2'.repeat(32)}`,
    };
    tab!.send(JSON.stringify({ id: 'evil', type: 'sign_payment', fields, hint: 'Depot obligatoire', wantCredentials: false }));
    const reply = await waitFor(() => received.find((m) => 'id' in m && m.id === 'evil'));
    expect(reply).toEqual({ id: 'evil', ok: false, reason: 'OVER_HARD_MAX' });
  });

  it('answers get_state with a fresh status reflecting the payment', async () => {
    const before = received.length;
    tab!.send(JSON.stringify({ id: 'st', type: 'get_state' }));
    const status = await waitFor(() =>
      received.slice(before).find((m) => 'type' in m && m.type === 'status'),
    );
    const state = decodeState(unhex((status as any).state));
    expect(state.spent).toBe(3_000_000n);
    expect(state.count).toBe(1);
  });

  it('ignores a malformed request without touching the device', async () => {
    const spentBefore = decodeState((await apdu('e00c000000')).data).spent;
    tab!.send(JSON.stringify({ id: 'bad', type: 'sign_payment', fields: { to: 'nope' }, wantCredentials: false }));
    tab!.send('not json');
    await new Promise((r) => setTimeout(r, 500));
    expect(decodeState((await apdu('e00c000000')).data).spent).toBe(spentBefore);
  });
});

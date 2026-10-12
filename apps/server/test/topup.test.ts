// POST /topup: the website hands over a TOP_UP authorization the Flex signed with 0xMAIN; the
// server checks it really is 0xMAIN -> this account's 0xAGENT and that the money is there,
// then submits it (paying the gas) and confirms the transfer on chain.
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { encodeEventTopics, encodeAbiParameters, type Hex, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP712_TYPES, paymentDomain, toWireSignature } from '@bsa-sentry/types';
import { topupRouter } from '../src/topup.js';
import { SESSION_COOKIE, signSession } from '../src/auth.js';
import { USDC_ABI } from '../src/chain.js';

const CHAIN = 5042002;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const SECRET = 'test-secret-test-secret-test-secret';
const main = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;
const NOW = 1_760_000_000;
const cookie = (account = main.address.toLowerCase()) => `${SESSION_COOKIE}=${encodeURIComponent(signSession(account, SECRET, () => NOW))}`;

async function authorization(over: Partial<{ value: bigint; validBefore: bigint; to: Hex }> = {}) {
  const m = { from: main.address, to: over.to ?? AGENT, value: over.value ?? 20_000_000n, validAfter: 0n, validBefore: over.validBefore ?? BigInt(NOW + 3600), nonce: `0x${'7a'.repeat(32)}` as Hex };
  const sig = await main.signTypedData({ domain: paymentDomain(CHAIN, USDC), types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: m });
  return { value: m.value.toString(), validAfter: '0', validBefore: m.validBefore.toString(), nonce: m.nonce, signature: toWireSignature(sig) };
}

function transferLog(from: Hex, to: Hex, value: bigint): Log {
  return {
    address: USDC, topics: encodeEventTopics({ abi: USDC_ABI, eventName: 'Transfer', args: { from, to } }) as any,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  } as unknown as Log;
}

function setup(over: { balance?: bigint; agent?: string | undefined; receiptLogs?: (a: readonly unknown[]) => Log[] } = {}) {
  const write = vi.fn(async () => '0xfeed' as Hex);
  const deps = {
    chainId: CHAIN, usdc: USDC as Hex, now: () => NOW,
    reads: { balanceOf: vi.fn(async () => over.balance ?? 50_000_000n), authorizationState: vi.fn(async () => false) },
    estimateFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    writeTransferWithAuthorization: write,
    waitForReceipt: async () => ({ status: 'success' as const, logs: over.receiptLogs ? over.receiptLogs([]) : [transferLog(main.address, AGENT, 20_000_000n)] }),
  };
  const app = express();
  app.use('/topup', topupRouter({ secret: SECRET, now: () => NOW, deps: deps as any, agentOf: () => ('agent' in over ? over.agent : AGENT) }));
  return { app, write, deps };
}

describe('POST /topup', () => {
  it('needs a Ledger login', async () => {
    const { app } = setup();
    expect((await request(app).post('/topup').send(await authorization())).status).toBe(401);
  });

  it('submits a valid authorization from 0xMAIN to this account\'s agent, and returns the transaction', async () => {
    const { app, write } = setup();
    const r = await request(app).post('/topup').set('Cookie', cookie()).send(await authorization());
    expect(r.status).toBe(200);
    expect(r.body.txHash).toBe('0xfeed');
    const args = (write.mock.calls[0] as unknown as [readonly unknown[]])[0];
    expect(String(args[0]).toLowerCase()).toBe(main.address.toLowerCase());
    expect(String(args[1]).toLowerCase()).toBe(AGENT);
    expect(args[2]).toBe(20_000_000n);
  });

  it('refuses a signature that is not this account\'s (or not to its agent), without spending gas', async () => {
    const { app, write } = setup();
    const r = await request(app).post('/topup').set('Cookie', cookie()).send(await authorization({ to: `0x${'66'.repeat(20)}` }));
    expect(r.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it('says plainly when the main account does not hold enough USDC', async () => {
    const { app, write } = setup({ balance: 3_000_000n });
    const r = await request(app).post('/topup').set('Cookie', cookie()).send(await authorization());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/main account holds 3 USDC/);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses an expired authorization', async () => {
    const { app, write } = setup();
    const r = await request(app).post('/topup').set('Cookie', cookie()).send(await authorization({ validBefore: BigInt(NOW - 1) }));
    expect(r.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it('needs the BSA Sentry tab, which is where the agent address comes from', async () => {
    const { app } = setup({ agent: undefined });
    expect((await request(app).post('/topup').set('Cookie', cookie()).send(await authorization())).status).toBe(409);
  });

  it('reports a failure when the chain does not show the expected transfer', async () => {
    const { app } = setup({ receiptLogs: () => [] });
    const r = await request(app).post('/topup').set('Cookie', cookie()).send(await authorization());
    expect(r.status).toBe(502);
  });
});

describe('GET /topup/wallets', () => {
  it('needs a Ledger login', async () => {
    const { app } = setup();
    expect((await request(app).get('/topup/wallets')).status).toBe(401);
  });

  it('returns the real USDC balances of the main account and the agent wallet', async () => {
    const { app, deps } = setup();
    deps.reads.balanceOf.mockImplementation(async (a: string) => (a.toLowerCase() === AGENT ? 56_490_000n : 5_000_000n));
    const r = await request(app).get('/topup/wallets').set('Cookie', cookie());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      main: { address: main.address.toLowerCase(), usdc: '5' },
      agent: { address: AGENT, usdc: '56.49' },
    });
  });

  it('still returns the main account when the tab has not reported the agent yet', async () => {
    const { app } = setup({ agent: undefined });
    const r = await request(app).get('/topup/wallets').set('Cookie', cookie());
    expect(r.body.agent).toBeNull();
    expect(r.body.main.usdc).toBe('50');
  });
});

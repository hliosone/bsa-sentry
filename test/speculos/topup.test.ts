// TOP_UP: 0xMAIN authorizes a USDC transfer to the device's OWN 0xAGENT, after a review and a
// hold. The recipient is never part of the payload: the device fills in its own agent address.
import { beforeAll, describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { EIP712_TYPES, decodeState, encodeChunks, encodePolicy, encodeTopUpPayload, paymentDomain, REFUSAL_REASON, SW, type Policy } from '@bsa-sentry/types';
import { INS, apdu, approveReview, hex, rejectReview, restart, screenshot, send, waitForText } from './client.js';

const TOKEN = '0x3600000000000000000000000000000000000000' as const;
const ARC = 5042002n;
const USDC = 1_000_000n;
const policy: Policy = {
  active: true, chainId: ARC, token: TOKEN, autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: '0x5069ee8f83b7181f031518d1375eae270f884175', label: 'Cafe Sat' }],
};
const fields = (over: Partial<Parameters<typeof encodeTopUpPayload>[0]> = {}) => ({
  chainId: ARC, token: TOKEN as Hex, value: 20n * USDC, validAfter: 0n, validBefore: 4_000_000_000n,
  nonce: `0x${'5e'.repeat(32)}` as Hex, ...over,
});
const topUp = (payload: Uint8Array) => apdu(Uint8Array.from([0xe0, INS.TOP_UP, 0, 0, payload.length, ...payload]));
const addr = async (p1: number) => `0x${hex((await send(INS.GET_ADDRESS, p1)).data)}` as Hex;

beforeAll(() => restart(true));

describe('TOP_UP', () => {
  it('needs active rules: no policy, no top-up', async () => {
    const r = await topUp(encodeTopUpPayload(fields()));
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.NO_POLICY);
  });

  it('installs the rules for the next tests', async () => {
    const set = apdu(encodeChunks(INS.SET_POLICY, encodePolicy(policy))[0]!);
    await approveReview();
    expect((await set).sw).toBe(SW.OK);
  });

  it('only moves the token on the chain the rules allow', async () => {
    const r = await topUp(encodeTopUpPayload(fields({ token: `0x${'99'.repeat(20)}` })));
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.WRONG_CHAIN_OR_TOKEN);
  });

  it('has no room for a recipient: 20 extra bytes are a wrong length', async () => {
    const withTo = new Uint8Array([...encodeTopUpPayload(fields()), ...new Uint8Array(20).fill(0x66)]);
    expect((await topUp(withTo)).sw).toBe(SW.WRONG_LENGTH);
  });

  it('after a hold, 0xMAIN signs a transfer to the device\'s own 0xAGENT, and the agent budget is untouched', async () => {
    const [main, agent] = [await addr(0), await addr(1)];
    const f = fields();
    const pending = topUp(encodeTopUpPayload(f));
    await waitForText(/Top up/i);
    await screenshot('23-top-up-review');
    await approveReview();
    const r = await pending;
    expect(r.sw).toBe(SW.OK);
    expect(r.data).toHaveLength(65);
    // Device order is v | r | s.
    const sig = `0x${hex(r.data.slice(1, 33))}${hex(r.data.slice(33, 65))}${hex(r.data.slice(0, 1))}` as Hex;
    const signer = await recoverTypedDataAddress({
      domain: paymentDomain(Number(ARC), TOKEN),
      types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: { from: main, to: agent, value: f.value, validAfter: f.validAfter, validBefore: f.validBefore, nonce: f.nonce },
      signature: sig,
    });
    expect(signer.toLowerCase()).toBe(main.toLowerCase());
    const s = decodeState((await send(INS.GET_STATE)).data);
    expect(s.spent).toBe(0n);
    expect(s.count).toBe(0);
  });

  it('a rejected review signs nothing', async () => {
    const pending = topUp(encodeTopUpPayload(fields({ nonce: `0x${'5f'.repeat(32)}` })));
    await waitForText(/Top up/i);
    await rejectReview();
    const r = await pending;
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.USER_REJECTED);
  });
});

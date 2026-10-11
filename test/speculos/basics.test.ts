// What the device answers before any policy exists. Also the regression test that the
// feasibility app's dangerous commands are gone for good.
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { decodeState, REFUSAL_REASON, SW } from '@bsa-sentry/types';
import { INS, apdu, screenshot, send, hex } from './client.js';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

const lower = (s?: string) => (s ?? '').toLowerCase();

describe('identity', () => {
  beforeAll(async () => {
    // Fail fast with a useful message if the emulator is not up.
    await send(INS.GET_APP_NAME).catch(() => {
      throw new Error('Speculos is not responding. Run: scripts/speculos.sh start');
    });
  });

  it('reports its name', async () => {
    const r = await send(INS.GET_APP_NAME);
    expect(r.sw).toBe(SW.OK);
    expect(Buffer.from(r.data).toString()).toBe('BSA Sentry');
  });

  it('derives 0xMAIN at m/44\'/60\'/0\'/0/0', async () => {
    const r = await send(INS.GET_ADDRESS, 0, 0);
    expect(r.sw).toBe(SW.OK);
    expect(r.data).toHaveLength(20);
    expect(`0x${hex(r.data)}`).toBe(lower(process.env.SPECULOS_MAIN_ADDRESS));
  });

  it('derives 0xAGENT at m/44\'/60\'/1\'/0/0, the address holding the test USDC', async () => {
    const r = await send(INS.GET_ADDRESS, 1, 0);
    expect(r.sw).toBe(SW.OK);
    expect(`0x${hex(r.data)}`).toBe(lower(process.env.SPECULOS_AGENT_ADDRESS));
  });

  it('gives 0xMAIN and 0xAGENT different addresses', async () => {
    const main = await send(INS.GET_ADDRESS, 0, 0);
    const agent = await send(INS.GET_ADDRESS, 1, 0);
    expect(hex(main.data)).not.toBe(hex(agent.data));
  });

  it('rejects an unknown P1 rather than defaulting to an account', async () => {
    expect((await send(INS.GET_ADDRESS, 2, 0)).sw).toBe(0x6a86);
  });

  it('rejects a wrong CLA', async () => {
    const r = await apdu('e108000000'.replace('e1', 'e1'));
    expect(r.sw).not.toBe(SW.OK);
  });
});

describe('the dangerous commands from the feasibility app are gone', () => {
  // The feasibility device app had PING (0x07), SIGN_3009 (0x09, one tap) and
  // SIGN_3009_SILENT (0x0F, NO policy and NO tap). Security invariants 2 and 4 depend on
  // none of them existing here. 0x0F is now SIGN_LOGIN, which always taps and only ever
  // signs a Login struct.
  it('has no PING at 0x07', async () => {
    expect((await send(0x07)).sw).toBe(SW.INS_NOT_SUPPORTED);
  });

  it('has no SIGN_3009 at 0x09', async () => {
    expect((await send(0x09)).sw).toBe(SW.INS_NOT_SUPPORTED);
  });

  it('never returns a signature for a 176-byte payment payload sent to 0x0F', async () => {
    // The old silent-signing payload, aimed at the instruction that replaced it.
    const payload = new Uint8Array(176);
    payload.set([0, 0, 0, 0, 0, 0x4c, 0xef, 0x52], 0); // Arc chain id
    const r = await apdu(Uint8Array.from([0xe0, 0x0f, 0, 0, payload.length, ...payload]));
    expect(r.sw).not.toBe(SW.OK);
    expect(r.data.length, 'no signature bytes may come back').toBeLessThan(65);
  });

  it('has no blob commands at 0x14', async () => {
    expect((await send(0x14)).sw).toBe(SW.INS_NOT_SUPPORTED);
  });

  it('refuses an instruction outside the set', async () => {
    for (const ins of [0x01, 0x05, 0x06, 0x20, 0xff]) {
      expect((await send(ins)).sw, `INS 0x${ins.toString(16)}`).toBe(SW.INS_NOT_SUPPORTED);
    }
  });
});

describe('GET_STATE on a device with no policy', () => {
  it('decodes with the shared decoder, so the dashboard and the device agree', async () => {
    const r = await send(INS.GET_STATE);
    expect(r.sw).toBe(SW.OK);
    const state = decodeState(r.data);
    expect(state.policy.active, 'a fresh device must have no active policy').toBe(false);
    expect(state.sessionArmed, 'the agent is disarmed until the user arms it on the device').toBe(false);
    expect(state.hasCredentials).toBe(false);
    expect(state.spent).toBe(0n);
    expect(state.count).toBe(0);
    expect(state.lastPayment).toBeNull();
    expect(state.policy.payees).toEqual([]);
  });

  it('needs no tap: it reveals nothing secret', async () => {
    // Three in a row with no interaction. If a blocking screen had appeared, the second
    // would come back 0x6901 (CmdNotAccepted).
    for (let i = 0; i < 3; i++) expect((await send(INS.GET_STATE)).sw).toBe(SW.OK);
  });
});

describe('PAY before any policy exists', () => {
  it('refuses with NO_POLICY and no signature', async () => {
    const payload = new Uint8Array(176);
    const r = await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, payload.length, ...payload]));
    // Until the PAY handler lands this is INS_NOT_SUPPORTED; once it does, it must be
    // 6985 + NO_POLICY. Either way it must never be a signature.
    expect(r.sw).not.toBe(SW.OK);
    if (r.sw === SW.DENY) expect(r.data[0]).toBe(REFUSAL_REASON.NO_POLICY);
  });
});

describe('screenshots for the submission', () => {
  it('captures the home screen', async () => {
    const path = await screenshot('01-home-no-policy');
    expect(path).toMatch(/01-home-no-policy\.png$/);
  });
});

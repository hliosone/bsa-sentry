// The browser transport: the DMK splits data and status word; the signer wants them joined,
// and the DMK must not give up before the device's 60 s screen does.
import { describe, expect, it, vi } from 'vitest';
import { DmkTransport } from '../src/transports/dmk.js';

describe('DmkTransport', () => {
  it('joins data and status word the way the device sends them', async () => {
    const dmk = { sendApdu: vi.fn(async () => ({ data: Uint8Array.of(0xaa, 0xbb), statusCode: Uint8Array.of(0x90, 0x00) })) };
    const out = await new DmkTransport(dmk, 'session-1').send(Uint8Array.of(0xe0, 0x0c, 0, 0, 0));
    expect(Array.from(out)).toEqual([0xaa, 0xbb, 0x90, 0x00]);
  });

  it('passes the session and an abort timeout longer than the device screen', async () => {
    const dmk = { sendApdu: vi.fn(async () => ({ data: new Uint8Array(), statusCode: Uint8Array.of(0x90, 0x00) })) };
    await new DmkTransport(dmk, 'session-1').send(Uint8Array.of(0xe0, 0x0b, 0, 0, 0));
    expect(dmk.sendApdu).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', abortTimeout: 120_000 }));
  });
});

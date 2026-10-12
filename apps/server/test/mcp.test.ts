// The MCP server claude.ai talks to. Three tools; the tests check what the model actually
// reads back, because that text is what it will say to the user.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { encodeState, type DeviceState } from '@bsa-sentry/types';
import { buildMcpServer, type McpDeps } from '../src/mcp.js';
import type { X402Result } from '../src/agent/x402-client.js';

const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const TX = `0x${'cd'.repeat(32)}` as `0x${string}`;

const state = (): DeviceState => ({
  sessionArmed: true, hasCredentials: true, spent: 3_000_000n, count: 1,
  lastPayment: { label: 'Cafe Sat', value: 3_000_000n },
  policy: {
    active: true, chainId: 5042002n, token: '0x3600000000000000000000000000000000000000',
    autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
    payees: [{ address: CAFE, label: 'Cafe Sat' }],
  },
});
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}` as const;

let clients: Client[] = [];
afterEach(async () => { for (const c of clients) await c.close(); clients = []; });

async function connect(over: Partial<McpDeps> = {}) {
  const deps: McpDeps = {
    account: 'alice',
    explorer: 'https://explorer.testnet.arc.io',
    agent: { fetch: vi.fn(async (): Promise<X402Result> => ({ kind: 'free', status: 200, content: 'hello' })) },
    status: () => ({ attached: true, flex: 'connected', session: true, state: hex(encodeState(state())) }),
    hasBackup: () => true,
    requestRestore: vi.fn(() => true),
    ...over,
  };
  const server = buildMcpServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return { client, deps };
}

const text = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('tool list', () => {
  it('exposes exactly x402_fetch, sentry_status and sentry_restore', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['sentry_restore', 'sentry_status', 'x402_fetch']);
  });

  it('describes x402_fetch in a way that tells the model the Flex decides', async () => {
    const { client } = await connect();
    const t = (await client.listTools()).tools.find((x) => x.name === 'x402_fetch')!;
    expect(t.description).toMatch(/Flex/);
    expect(t.description).toMatch(/refus/i);
    expect(t.inputSchema.required).toEqual(['url']);
  });
});

describe('x402_fetch', () => {
  it('passes the url, method and body to the agent API for this account only', async () => {
    const { client, deps } = await connect();
    await client.callTool({ name: 'x402_fetch', arguments: { url: 'https://m.test/cafe', method: 'POST', body: '{"a":1}' } });
    expect(deps.agent.fetch).toHaveBeenCalledWith('alice', { url: 'https://m.test/cafe', method: 'POST', body: '{"a":1}' });
  });

  it('reports a paid fetch with the amount, the payee and an explorer link', async () => {
    const { client } = await connect({
      agent: { fetch: vi.fn(async (): Promise<X402Result> => ({
        kind: 'paid', status: 200, content: '{"coffee":"espresso"}',
        receipt: { decision: 'approved', amount: '3', payee: CAFE, txHash: TX, network: 'eip155:5042002' },
      })) },
    });
    const r = await client.callTool({ name: 'x402_fetch', arguments: { url: 'https://m.test/cafe' } });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/Paid 3 USDC/);
    expect(t).toContain(CAFE);
    expect(t).toContain(`https://explorer.testnet.arc.io/tx/${TX}`);
    expect(t).toContain('espresso');
    expect(r.structuredContent).toMatchObject({ receipt: { amount: '3', payee: CAFE, txHash: TX } });
  });

  it('returns a free page as-is', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'x402_fetch', arguments: { url: 'https://m.test/promo' } });
    expect(text(r)).toContain('hello');
    expect(r.isError).toBeFalsy();
  });

  it('marks a device refusal as an error and carries the device\'s own words', async () => {
    const { client } = await connect({
      agent: { fetch: vi.fn(async (): Promise<X402Result> => ({
        kind: 'refused', reason: 'OVER_HARD_MAX', amount: '400', payee: '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50',
        message: 'Refused by your Flex: OVER_HARD_MAX. This amount is above the absolute ceiling.',
      })) },
    });
    const r = await client.callTool({ name: 'x402_fetch', arguments: { url: 'https://m.test/evil/deposit' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Refused by your Flex: OVER_HARD_MAX/);
    expect(text(r)).toMatch(/400 USDC/);
    // A nudge so the model does not retry around the device or invent a workaround.
    expect(text(r)).toMatch(/do not retry/i);
  });

  it('marks an agent API error as an error', async () => {
    const { client } = await connect({
      agent: { fetch: vi.fn(async (): Promise<X402Result> => ({ kind: 'error', message: 'could not reach m.test' })) },
    });
    const r = await client.callTool({ name: 'x402_fetch', arguments: { url: 'https://m.test/x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('could not reach m.test');
  });

  it('turns an unexpected exception into a readable error, not a protocol failure', async () => {
    const { client } = await connect({ agent: { fetch: vi.fn(async () => { throw new Error('no BSA Sentry tab is attached'); }) } });
    const r = await client.callTool({ name: 'x402_fetch', arguments: { url: 'https://m.test/x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/open the BSA Sentry tab/i);
  });

  it('rejects a missing url at the schema level', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'x402_fetch', arguments: {} }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
    expect((r as any).isError).toBe(true);
  });
});

describe('sentry_status', () => {
  it('summarises the bridge, the Flex, the session, the budget and the credentials', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'sentry_status', arguments: {} });
    const t = text(r);
    expect(t).toMatch(/tab.*connected/i);
    expect(t).toMatch(/Flex.*connected/i);
    expect(t).toMatch(/session.*on/i);
    expect(t).toMatch(/17 \/ 20 USDC left/);
    expect(t).toMatch(/18\+.*yes/i);
    expect(t).toMatch(/backup.*yes/i);
    expect(r.structuredContent).toMatchObject({ bridge: 'attached', flex: 'connected', session: true, budget: { spent: '3', total: '20' } });
  });

  it('asks the Flex for a fresh status rather than reporting a stale cached one', async () => {
    const { client } = await connect({
      status: () => ({ attached: true, flex: 'connected', session: false }),
      freshStatus: async () => ({ attached: true, flex: 'connected', session: true }),
    });
    expect(text(await client.callTool({ name: 'sentry_status', arguments: {} }))).toMatch(/Agent session: on/);
  });

  it('says plainly when no tab is open', async () => {
    const { client } = await connect({ status: () => ({ attached: false, flex: 'disconnected', session: false }) });
    expect(text(await client.callTool({ name: 'sentry_status', arguments: {} }))).toMatch(/open the BSA Sentry tab/i);
  });

  it('says when the Flex is locked', async () => {
    const { client } = await connect({ status: () => ({ attached: true, flex: 'locked', session: false }) });
    expect(text(await client.callTool({ name: 'sentry_status', arguments: {} }))).toMatch(/unlock/i);
  });
});

describe('sentry_restore', () => {
  it('asks the tab to start the restore flow and explains what the user will see', async () => {
    const { client, deps } = await connect();
    const r = await client.callTool({ name: 'sentry_restore', arguments: {} });
    expect(deps.requestRestore).toHaveBeenCalledWith('alice');
    expect(text(r)).toMatch(/Ledger Sync|restore/i);
  });

  it('explains when there is no backup to restore', async () => {
    const { client } = await connect({ hasBackup: () => false });
    const r = await client.callTool({ name: 'sentry_restore', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no backup/i);
  });
});

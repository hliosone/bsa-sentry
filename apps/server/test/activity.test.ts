// The dashboard's activity survives a reload: the server keeps each account's requests,
// answers and payments, and serves them back to that account only.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { activityRouter, recordActivity } from '../src/activity.js';
import { SESSION_COOKIE, signSession } from '../src/auth.js';

const SECRET = 's'.repeat(64);
const cookie = (account: string) => `${SESSION_COOKIE}=${encodeURIComponent(signSession(account, SECRET))}`;

function setup() {
  const db = openDb(':memory:');
  const events = new EventEmitter();
  let t = 1_000;
  recordActivity(db, events, () => t++);
  const app = express();
  app.use('/activity', activityRouter({ db, secret: SECRET }));
  return { app, events };
}

describe('activity history', () => {
  it('replays an account\'s requests, answers and payments in order, and nobody else\'s', async () => {
    const { app, events } = setup();
    events.emit('request', { account: 'alice', id: 'r1', message: { type: 'sign_payment', fields: { to: '0xcafe', value: '3000000' }, hint: 'Cafe Sat' } });
    events.emit('request', { account: 'alice', id: 'g1', message: { type: 'get_state' } }); // not activity
    events.emit('answer', { account: 'alice', id: 'r1', answer: { ok: true } });
    events.emit('payment', { account: 'alice', kind: 'paid', url: 'x', amount: '3', payee: '0xcafe', txHash: '0x1' });
    events.emit('payment', { account: 'bob', kind: 'paid', url: 'y', amount: '9', payee: '0xbeef' });
    const r = await request(app).get('/activity').set('Cookie', cookie('alice'));
    expect(r.status).toBe(200);
    expect(r.body.map((e: any) => [e.type, e.at])).toEqual([['request', 1000], ['answer', 1001], ['payment', 1002]]);
    expect(r.body[0].data.message.hint).toBe('Cafe Sat');
  });

  it('needs a Ledger login', async () => {
    const { app } = setup();
    expect((await request(app).get('/activity')).status).toBe(401);
  });
});

describe('agent history from the chain', () => {
  const USDC = '0x3600000000000000000000000000000000000000';
  const AGENT = '0x1c9940ef87ce842fb18d73fd43b49b53582c6b52';
  const item = (over: any) => ({
    transaction_hash: '0xAB', timestamp: '2026-10-12T18:13:44.000000Z',
    from: { hash: '0x1C9940EF87CE842FB18D73FD43B49B53582C6B52' }, to: { hash: '0xCAFE' },
    total: { value: '3000000', decimals: '6' }, token: { address_hash: USDC, symbol: 'USDC' }, ...over,
  });
  function chainApp(items: any[], agent: string | null = AGENT) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ items })); }) as unknown as typeof fetch;
    const app = express();
    app.use('/activity', activityRouter({ db: openDb(':memory:'), secret: SECRET, chain: { explorer: 'https://x.test/', usdc: USDC, agentOf: () => agent ?? undefined, fetchImpl } }));
    return { app, calls };
  }

  it('lists the agent wallet\'s USDC transfers, lower-cased, and ignores any other token', async () => {
    const { app, calls } = chainApp([item({}), item({ transaction_hash: '0xSPAM', token: { address_hash: '0xdead', symbol: 'USDC' } })]);
    const r = await request(app).get('/activity/chain').set('Cookie', cookie('alice'));
    expect(r.status).toBe(200);
    expect(calls[0]).toBe(`https://x.test/api/v2/addresses/${AGENT}/token-transfers?type=ERC-20`);
    expect(r.body.transfers).toEqual([{ txHash: '0xab', at: Date.parse('2026-10-12T18:13:44Z'), from: AGENT, to: '0xcafe', value: '3000000' }]);
  });

  it('is empty until the Flex told the server the agent address, and needs a login', async () => {
    const { app, calls } = chainApp([item({})], null);
    expect((await request(app).get('/activity/chain').set('Cookie', cookie('alice'))).body).toEqual({ agent: null, transfers: [] });
    expect(calls).toHaveLength(0);
    expect((await request(app).get('/activity/chain')).status).toBe(401);
  });
});

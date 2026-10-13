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

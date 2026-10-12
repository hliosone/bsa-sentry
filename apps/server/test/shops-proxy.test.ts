// The demo shops served under the server's own public address (/shops/*), so a demo needs one
// tunnel instead of two. The proxy must pass the x402 headers through untouched both ways.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { shopsProxy } from '../src/shops-proxy.js';

let upstream: Server;
let app: express.Express;

beforeAll(async () => {
  const shop = express();
  shop.get('/cafe', (req, res) => {
    const paid = req.get('payment-signature');
    if (!paid) return res.status(402).set('PAYMENT-REQUIRED', 'abc').json({});
    res.set('PAYMENT-RESPONSE', 'settled').json({ ok: true, paid });
  });
  shop.post('/echo', express.json(), (req, res) => res.json({ body: req.body, q: req.query.x }));
  shop.get('/promo', (_req, res) => res.type('html').send('<h1>Deals</h1>'));
  upstream = shop.listen(0);
  await new Promise((r) => upstream.once('listening', r));
  app = express();
  app.use('/shops', shopsProxy(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`));
});
afterAll(() => upstream.close());

describe('/shops proxy', () => {
  it('passes the 402 and its PAYMENT-REQUIRED header back', async () => {
    const r = await request(app).get('/shops/cafe');
    expect(r.status).toBe(402);
    expect(r.headers['payment-required']).toBe('abc');
  });

  it('forwards the payment header and returns the paid content with PAYMENT-RESPONSE', async () => {
    const r = await request(app).get('/shops/cafe').set('PAYMENT-SIGNATURE', 'sig');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, paid: 'sig' });
    expect(r.headers['payment-response']).toBe('settled');
  });

  it('forwards bodies and query strings', async () => {
    const r = await request(app).post('/shops/echo?x=1').send({ a: 1 });
    expect(r.body).toEqual({ body: { a: 1 }, q: '1' });
  });

  it('keeps the content type', async () => {
    const r = await request(app).get('/shops/promo');
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toBe('<h1>Deals</h1>');
  });

  it('answers 502 when the shops are down', async () => {
    const dead = express();
    dead.use('/shops', shopsProxy('http://127.0.0.1:9'));
    expect((await request(dead).get('/shops/cafe')).status).toBe(502);
  });
});

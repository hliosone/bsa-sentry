// The demo merchants, behind the official x402 2.28 Express middleware.
//
// The middleware asks the facilitator `/supported` once at startup (we measured this), so a
// stub facilitator is started first. These tests pin the prices, the payees, the 18+
// requirement, and the prompt injection the demo relies on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { createMerchantsApp, MERCHANTS } from '../src/app.js';

const NETWORK = 'eip155:5042002';
const payTo = {
  cafe: '0x5069ee8f83b7181f031518d1375eae270f884175',
  cave: '0x0b34839c51d7d6932a9cf00d63b15d58a29265ac',
  resto: '0xd4e15888844c2df59cf371917c11a99267917af5',
  evil: '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50',
  boulangerie: '0x1111111111111111111111111111111111111b0b',
  presale: '0x2222222222222222222222222222222222222a1e',
} as const;

let facilitator: Server;
let facilitatorUrl: string;
let app: express.Express;

beforeAll(async () => {
  const f = express();
  f.get('/supported', (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} });
  });
  await new Promise<void>((resolve) => { facilitator = f.listen(0, resolve); });
  const port = (facilitator.address() as { port: number }).port;
  facilitatorUrl = `http://127.0.0.1:${port}`;
  app = await createMerchantsApp({ facilitatorUrl, network: NETWORK, payTo, publicUrl: 'http://merchants.test' });
});

afterAll(() => new Promise<void>((r) => facilitator.close(() => r())));

const required = async (path: string) => {
  const res = await request(app).get(path);
  expect(res.status, `${path} must ask for payment`).toBe(402);
  const header = res.headers['payment-required'];
  expect(header, 'PAYMENT-REQUIRED header').toBeTruthy();
  return decodePaymentRequiredHeader(header!) as any;
};

describe('prices and payees', () => {
  it('the cafe is 3 USDC to the cafe address', async () => {
    const r = await required('/cafe');
    expect(r.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, amount: '3000000' });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(payTo.cafe);
    expect(r.accepts[0].asset.toLowerCase()).toBe('0x3600000000000000000000000000000000000000');
  });

  it('the wine cellar is 4.5 USDC and requires 18+', async () => {
    const r = await required('/wine');
    expect(r.accepts[0]).toMatchObject({ amount: '4500000' });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(payTo.cave);
    expect(r.accepts[0].extra.requires).toEqual(['age_over_18']);
  });

  it('the token presale is 5 USDC and is not open to US nationals', async () => {
    const r = await required('/presale');
    expect(r.accepts[0]).toMatchObject({ amount: '5000000' });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(payTo.presale);
    expect(r.accepts[0].extra.requires).toEqual(['jurisdiction_not:US']);
  });

  it('the restaurant is 20 USDC, above the demo auto limit', async () => {
    const r = await required('/restaurant');
    expect(r.accepts[0]).toMatchObject({ amount: '20000000' });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(payTo.resto);
  });

  it('the "deposit" is 400 USDC to an address in no policy', async () => {
    const r = await required('/evil/deposit');
    expect(r.accepts[0]).toMatchObject({ amount: '400000000' });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(payTo.evil);
  });

  it('the bakery is 2 USDC: under the auto limit, for the "Faire confiance" demo', async () => {
    const r = await required('/bakery');
    expect(r.accepts[0]).toMatchObject({ amount: '2000000' });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(payTo.boulangerie);
  });

  it('every merchant pays to a distinct address', () => {
    expect(new Set(Object.values(payTo)).size).toBe(6);
  });

  it('describes each resource, which becomes the device hint', async () => {
    for (const path of ['/cafe', '/wine', '/restaurant', '/evil/deposit']) {
      const r = await required(path);
      expect(r.resource?.description, path).toBeTruthy();
    }
  });

  it('only the wine cellar asks for 18+', async () => {
    for (const path of ['/cafe', '/restaurant', '/evil/deposit', '/bakery']) {
      const r = await required(path);
      expect(r.accepts[0].extra?.requires, path).toBeUndefined();
    }
  });
});

describe('the promo page (the prompt injection)', () => {
  it('is free', async () => {
    const res = await request(app).get('/promo');
    expect(res.status).toBe(200);
  });

  it('hides an instruction to pay a "mandatory" 400 USDC deposit at /evil/deposit', async () => {
    const res = await request(app).get('/promo');
    expect(res.text).toMatch(/400 USDC/);
    expect(res.text).toMatch(/http:\/\/merchants\.test\/evil\/deposit/);
    expect(res.text).toMatch(/obligatoire|mandatory/i);
    // Hidden from a human reading the page, visible to an agent reading the HTML.
    expect(res.text).toMatch(/display:\s*none|hidden/i);
  });
});

describe('the catalogue', () => {
  it('lists every merchant with its price, for the website and the demo script', () => {
    expect(MERCHANTS.map((m) => [m.path, m.price])).toEqual([
      ['/cafe', '$3'], ['/wine', '$4.5'], ['/restaurant', '$20'], ['/evil/deposit', '$400'], ['/bakery', '$2'], ['/presale', '$5'],
    ]);
  });

  it('serves a health check that needs no payment', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

// The Shopify integration: a real store, shoppable by AI agents over x402, with per-product
// Know-Your-Agent requirements taken from product tags.
//
// A stub facilitator (the x402 client calls it over real HTTP) records every call in a shared
// log, and the Shopify Admin API is a mocked `fetch` writing to the same log, so the tests can
// pin the ORDER of things: no Shopify order before a successful settlement.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createMerchantsApp } from '../src/app.js';
import {
  DEMO_PRODUCTS, describeRight, mapCatalog, requirementsFromTags, shopifyEnv, usdcUnits, type ShopifyConfig,
} from '../src/shopify.js';

const NETWORK = 'eip155:5042002';
const USDC = '0x3600000000000000000000000000000000000000';
const SHOP_PAYTO = '0x5150000000000000000000000000000000005150';
const PAYER = '0xa9e0000000000000000000000000000000000a9e';
const TX = `0x${'ab'.repeat(32)}`;
const EXPLORER = 'https://explorer.testnet.arc.io';
const payTo = {
  cafe: '0x5069ee8f83b7181f031518d1375eae270f884175',
  cave: '0x0b34839c51d7d6932a9cf00d63b15d58a29265ac',
  resto: '0xd4e15888844c2df59cf371917c11a99267917af5',
  evil: '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50',
  boulangerie: '0x1111111111111111111111111111111111111b0b',
};

// ------------------------------------------------------------------ stub facilitator
type Body = { paymentPayload: any; paymentRequirements: any };
let log: string[] = [];
let seen: { verify: Body[]; settle: Body[] } = { verify: [], settle: [] };
let verifyAnswer: (b: Body) => unknown;
let settleAnswer: (b: Body) => unknown;
const okVerify = () => ({ isValid: true, payer: PAYER });
const okSettle = (b: Body) => ({ success: true, transaction: TX, network: NETWORK, payer: PAYER, amount: b.paymentRequirements.amount });

let facilitator: Server;
let facilitatorUrl: string;

beforeAll(async () => {
  const f = express();
  f.use(express.json());
  f.get('/supported', (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} });
  });
  f.post('/verify', (req, res) => { log.push('facilitator:verify'); seen.verify.push(req.body); res.json(verifyAnswer(req.body)); });
  f.post('/settle', (req, res) => { log.push('facilitator:settle'); seen.settle.push(req.body); res.json(settleAnswer(req.body)); });
  await new Promise<void>((resolve) => { facilitator = f.listen(0, resolve); });
  facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((r) => facilitator.close(() => r())));

beforeEach(() => {
  log = [];
  seen = { verify: [], settle: [] };
  verifyAnswer = okVerify;
  settleAnswer = okSettle;
});

// ------------------------------------------------------------------ mocked Shopify Admin API
const STORE_PRODUCTS = {
  data: {
    shop: { name: 'Lausanne Goods', currencyCode: 'CHF' },
    products: {
      nodes: [
        { id: 'gid://shopify/Product/1', title: 'Gruyere AOP 250 g', handle: 'gruyere', tags: ['cheese'],
          variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', price: '4.50' }] } },
        { id: 'gid://shopify/Product/2', title: 'Absinthe 50 cl', handle: 'absinthe', tags: ['bsa:age_over_18', 'spirits'],
          variants: { nodes: [{ id: 'gid://shopify/ProductVariant/22', price: '12.00' }] } },
        { id: 'gid://shopify/Product/3', title: 'Gift card', handle: 'gift-card', tags: [],
          variants: { nodes: [] } },
        { id: 'gid://shopify/Product/4', title: 'Free sticker', handle: 'sticker', tags: [],
          variants: { nodes: [{ id: 'gid://shopify/ProductVariant/44', price: '0.00' }] } },
      ],
    },
  },
};

type ShopifyCall = { url: string; headers: Record<string, string>; body: any; op: string };

/** A fetch for the Shopify Admin API. `answers` can override what each operation returns. */
function shopifyFetch(answers: Partial<Record<string, () => unknown>> = {}) {
  const calls: ShopifyCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = String(init?.body ?? '');
    if (url.endsWith('/admin/oauth/access_token')) {
      const body = Object.fromEntries(new URLSearchParams(raw));
      calls.push({ url, headers, body, op: 'oauth' });
      log.push('shopify:oauth');
      return Response.json({ access_token: `tok-${calls.filter((c) => c.op === 'oauth').length}`, scope: 'read_products', expires_in: 86399 });
    }
    const body = JSON.parse(raw);
    const op = /draftOrderCreate/.test(body.query) ? 'draftOrderCreate'
      : /draftOrderComplete/.test(body.query) ? 'draftOrderComplete'
      : /products\s*\(/.test(body.query) ? 'products' : 'unknown';
    calls.push({ url, headers, body, op });
    log.push(`shopify:${op}`);
    const answer = answers[op];
    if (answer) return Response.json(answer());
    if (op === 'products') return Response.json(STORE_PRODUCTS);
    if (op === 'draftOrderCreate') {
      return Response.json({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/77', name: '#D7' }, userErrors: [] } } });
    }
    if (op === 'draftOrderComplete') {
      return Response.json({ data: { draftOrderComplete: {
        draftOrder: { id: 'gid://shopify/DraftOrder/77', name: '#D7', order: { id: 'gid://shopify/Order/1001', name: '#1001' } }, userErrors: [],
      } } });
    }
    return Response.json({ errors: [{ message: 'unexpected query' }] });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

async function appWith(shopify: Partial<ShopifyConfig>) {
  return createMerchantsApp({
    facilitatorUrl, network: NETWORK, payTo, publicUrl: 'http://merchants.test',
    shopify: { apiVersion: '2025-07', dryRun: true, payTo: SHOP_PAYTO, explorerUrl: EXPLORER, ...shopify },
  });
}

const live = (fetchMock: typeof fetch, extra: Partial<ShopifyConfig> = {}) => appWith({
  shop: 'lausanne-goods.myshopify.com', auth: { token: 'shpat_test' }, dryRun: false, fetch: fetchMock, ...extra,
});

async function required(app: express.Express, path: string) {
  const res = await request(app).get(path);
  expect(res.status, `${path} must ask for payment`).toBe(402);
  return decodePaymentRequiredHeader(res.headers['payment-required']!) as any;
}

/** What an agent sends back: the offer it accepted, plus a (stub-verified) authorization. */
function paymentHeader(required: any, accepted: any = required.accepts[0]) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    payload: {
      authorization: {
        from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${'01'.repeat(32)}`,
      },
      signature: `0x${'11'.repeat(65)}`,
    },
    accepted,
    resource: required.resource,
  } as any);
}

async function buy(app: express.Express, path: string, tamper?: (accepted: any) => any) {
  const r = await required(app, path);
  const accepted = tamper ? tamper(structuredClone(r.accepts[0])) : r.accepts[0];
  return request(app).get(path).set('PAYMENT-SIGNATURE', paymentHeader(r, accepted));
}

// ================================================================== pure mapping
describe('product tags -> KYA requirements', () => {
  it('maps bsa:age_over_18 and ignores ordinary tags', () => {
    expect(requirementsFromTags(['bsa:age_over_18', 'organic'])).toEqual(['age_over_18']);
  });

  it('maps a jurisdiction exclusion', () => {
    expect(requirementsFromTags(['bsa:jurisdiction_not:US'])).toEqual(['jurisdiction_not:US']);
  });

  it('unions one-country tags into ONE requirement per kind (Shopify splits tags on commas)', () => {
    // Two separate jurisdiction_in requirements would AND together: nobody holds both.
    expect(requirementsFromTags(['bsa:jurisdiction_in:FR', 'bsa:jurisdiction_in:de'])).toEqual(['jurisdiction_in:DE,FR']);
    expect(requirementsFromTags(['bsa:jurisdiction_not:US', 'bsa:jurisdiction_not:RU'])).toEqual(['jurisdiction_not:RU,US']);
  });

  it('normalises case and removes duplicates', () => {
    expect(requirementsFromTags(['BSA:Age_Over_18', 'bsa:age_over_18'])).toEqual(['age_over_18']);
  });

  it('passes an unknown or malformed bsa: tag through verbatim, so the facilitator fails closed', () => {
    // A typo must never make a restricted product open to everyone.
    expect(requirementsFromTags(['bsa:age_over_21'])).toEqual(['bsa:age_over_21']);
    expect(requirementsFromTags(['bsa:jurisdiction_not:USA'])).toEqual(['bsa:jurisdiction_not:USA']);
  });

  it('describes each right like the rest of BSA Sentry', () => {
    expect(describeRight('age_over_18')).toBe('18 or older');
    expect(describeRight('jurisdiction_not:US')).toBe('not a US person');
    expect(describeRight('jurisdiction_in:DE,FR')).toBe('under the jurisdiction of DE, FR');
  });
});

describe('store price -> USDC units (1 store currency unit = 1 USDC for the demo)', () => {
  it('converts decimal prices exactly, without floating point', () => {
    expect(usdcUnits('4.50')).toBe('4500000');
    expect(usdcUnits('12')).toBe('12000000');
    expect(usdcUnits('0.29')).toBe('290000');
    expect(usdcUnits('0.000001')).toBe('1');
  });

  it('rejects zero, negative, over-precise and malformed prices', () => {
    for (const p of ['0', '0.00', '-1', '1.2345678', 'abc', '', '1e3']) expect(usdcUnits(p), p).toBeNull();
  });
});

describe('catalog mapping from the Admin GraphQL answer', () => {
  it('keeps buyable products, with their variant, price, currency and requirements', () => {
    const products = mapCatalog(STORE_PRODUCTS.data);
    expect(products.map((p) => p.handle)).toEqual(['gruyere', 'absinthe']);
    expect(products[0]).toMatchObject({
      title: 'Gruyere AOP 250 g', variantId: 'gid://shopify/ProductVariant/11', price: '4.50', currency: 'CHF', amount: '4500000', requires: [],
    });
    expect(products[1]).toMatchObject({ handle: 'absinthe', amount: '12000000', requires: ['age_over_18'] });
  });
});

describe('configuration from the environment', () => {
  it('is DRY_RUN with no Shopify credentials at all', () => {
    expect(shopifyEnv({})).toMatchObject({ dryRun: true, apiVersion: '2025-07' });
    expect(shopifyEnv({ SHOPIFY_SHOP: 'x.myshopify.com' }).dryRun).toBe(true);
  });

  it('goes live with a shop and an Admin API token', () => {
    const env = shopifyEnv({ SHOPIFY_SHOP: 'https://x.myshopify.com/', SHOPIFY_ADMIN_TOKEN: 'shpat_x' });
    expect(env).toMatchObject({ dryRun: false, shop: 'x.myshopify.com', auth: { token: 'shpat_x' } });
  });

  it('goes live with a Dev Dashboard app (client credentials grant)', () => {
    const env = shopifyEnv({ SHOPIFY_SHOP: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' });
    expect(env).toMatchObject({ dryRun: false, auth: { clientId: 'id', clientSecret: 'secret' } });
  });

  it('honours SHOPIFY_DRY_RUN=true and SHOPIFY_API_VERSION', () => {
    const env = shopifyEnv({ SHOPIFY_SHOP: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', SHOPIFY_DRY_RUN: 'true', SHOPIFY_API_VERSION: '2025-10' });
    expect(env).toMatchObject({ dryRun: true, apiVersion: '2025-10' });
  });
});

// ================================================================== DRY_RUN (no Shopify at all)
describe('DRY_RUN: the built-in demo catalog', () => {
  it('has a coffee bag, an 18+ wine bottle and a token-drop item closed to US persons', () => {
    expect(DEMO_PRODUCTS).toHaveLength(3);
    const byReq = Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.requires.join('|'), p.title]));
    expect(Object.keys(byReq).sort()).toEqual(['', 'age_over_18', 'jurisdiction_not:US']);
  });

  it('GET /shopify lists every product with its x402 URL, price in USDC and rights', async () => {
    const shop = shopifyFetch();
    const app = await appWith({ fetch: shop.fn });
    const res = await request(app).get('/shopify').set('accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.note).toMatch(/1 USD = 1 USDC/);
    expect(res.body.products).toHaveLength(3);
    for (const p of res.body.products) {
      expect(p.url).toBe(`http://merchants.test/shopify/products/${p.handle}`);
      expect(p.amount).toBe(usdcUnits(p.price));
    }
    const wine = res.body.products.find((p: any) => p.requires.includes('age_over_18'));
    expect(wine.rights).toEqual(['18 or older']);
    expect(shop.fn).not.toHaveBeenCalled();
  });

  it('serves a small escaped HTML catalog to a browser', async () => {
    const app = await appWith({});
    const res = await request(app).get('/shopify').set('accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    for (const p of DEMO_PRODUCTS) expect(res.text).toContain(`/shopify/products/${p.handle}`);
  });

  it('a product is a 402 for its price in USDC, to the Shopify merchant address, described as "<store> - <title>"', async () => {
    const app = await appWith({});
    const coffee = DEMO_PRODUCTS.find((p) => p.requires.length === 0)!;
    const r = await required(app, `/shopify/products/${coffee.handle}`);
    expect(r.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, amount: coffee.amount });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(SHOP_PAYTO);
    expect(r.accepts[0].asset.toLowerCase()).toBe(USDC);
    expect(r.accepts[0].extra?.requires).toBeUndefined();
    // The description becomes the Flex hint, and the payee label if the user trusts it: every
    // product shares one payee, so it names the store first, like the other merchants.
    expect(r.resource.description).toBe(`Sentry Shop - ${coffee.title}`);
  });

  it('the wine asks for 18+ and the token drop excludes US persons, in extra.requires', async () => {
    const app = await appWith({});
    const wine = DEMO_PRODUCTS.find((p) => p.requires.includes('age_over_18'))!;
    const drop = DEMO_PRODUCTS.find((p) => p.requires.includes('jurisdiction_not:US'))!;
    expect((await required(app, `/shopify/products/${wine.handle}`)).accepts[0].extra.requires).toEqual(['age_over_18']);
    expect((await required(app, `/shopify/products/${drop.handle}`)).accepts[0].extra.requires).toEqual(['jurisdiction_not:US']);
  });

  it('an unknown product is a 404, and nothing reaches the facilitator', async () => {
    const app = await appWith({});
    const res = await request(app).get('/shopify/products/no-such-thing');
    expect(res.status).toBe(404);
    expect(res.headers['payment-required']).toBeUndefined();
    expect(log).toEqual([]);
  });

  it('a paid request settles and returns a receipt, with no Shopify order written', async () => {
    const shop = shopifyFetch();
    const app = await appWith({ fetch: shop.fn });
    const wine = DEMO_PRODUCTS.find((p) => p.requires.includes('age_over_18'))!;
    const res = await buy(app, `/shopify/products/${wine.handle}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      paid: true, dryRun: true, txHash: TX, explorer: `${EXPLORER}/tx/${TX}`, order: null,
      product: { title: wine.title, handle: wine.handle }, amount: '4.5', currency: 'USDC', rights: ['18 or older'],
    });
    expect(decodePaymentResponseHeader(res.headers['payment-response']!)).toMatchObject({ success: true, transaction: TX });
    expect(log).toEqual(['facilitator:verify', 'facilitator:settle']);
    expect(shop.fn).not.toHaveBeenCalled();
  });
});

// ================================================================== live store (mocked Admin API)
describe('live store: catalog from the Admin GraphQL API', () => {
  it('reads products with the Admin token, at the configured API version', async () => {
    const shop = shopifyFetch();
    const app = await live(shop.fn);
    const res = await request(app).get('/shopify').set('accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, shop: 'lausanne-goods.myshopify.com', note: expect.stringMatching(/1 CHF = 1 USDC/) });
    expect(res.body.products.map((p: any) => p.handle)).toEqual(['gruyere', 'absinthe']);
    expect(shop.calls[0]!.url).toBe('https://lausanne-goods.myshopify.com/admin/api/2025-07/graphql.json');
    expect(shop.calls[0]!.headers['x-shopify-access-token']).toBe('shpat_test');
  });

  it('caches the catalog briefly, then refreshes it', async () => {
    let t = 1_000_000;
    const shop = shopifyFetch();
    const app = await live(shop.fn, { now: () => t, catalogTtlMs: 60_000 });
    await request(app).get('/shopify');
    await request(app).get('/shopify/products/gruyere');
    expect(shop.calls.filter((c) => c.op === 'products')).toHaveLength(1);
    t += 61_000;
    await request(app).get('/shopify');
    expect(shop.calls.filter((c) => c.op === 'products')).toHaveLength(2);
  });

  it('a Dev Dashboard app exchanges its client credentials for a token, once', async () => {
    let t = 1_000_000;
    const shop = shopifyFetch();
    const app = await live(shop.fn, { auth: { clientId: 'cid', clientSecret: 'csecret' }, now: () => t, catalogTtlMs: 1 });
    await request(app).get('/shopify');
    t += 10;
    await request(app).get('/shopify');
    const oauth = shop.calls.filter((c) => c.op === 'oauth');
    expect(oauth).toHaveLength(1);
    expect(oauth[0]!.url).toBe('https://lausanne-goods.myshopify.com/admin/oauth/access_token');
    expect(oauth[0]!.body).toEqual({ grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csecret' });
    const graphql = shop.calls.filter((c) => c.op === 'products');
    expect(graphql).toHaveLength(2);
    expect(graphql.every((c) => c.headers['x-shopify-access-token'] === 'tok-1')).toBe(true);
  });

  it('the 402 carries the store price and the tag requirement', async () => {
    const app = await live(shopifyFetch().fn);
    const r = await required(app, '/shopify/products/absinthe');
    expect(r.accepts[0]).toMatchObject({ amount: '12000000', extra: { requires: ['age_over_18'] } });
    expect(r.accepts[0].payTo.toLowerCase()).toBe(SHOP_PAYTO);
    expect((await request(app).get('/shopify/products/gift-card')).status).toBe(404);
  });
});

describe('live store: the order is written back only after a successful settlement', () => {
  it('settles, then creates the draft order and completes it as paid, with the tx and rights in the note', async () => {
    const shop = shopifyFetch();
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/absinthe');
    expect(res.status).toBe(200);

    // Order of events: verify, settle, THEN Shopify. Exactly one order.
    expect(log.filter((e) => e !== 'shopify:products')).toEqual([
      'facilitator:verify', 'facilitator:settle', 'shopify:draftOrderCreate', 'shopify:draftOrderComplete',
    ]);

    const create = shop.calls.find((c) => c.op === 'draftOrderCreate')!;
    const input = create.body.variables.input;
    expect(input.lineItems).toEqual([{ variantId: 'gid://shopify/ProductVariant/22', quantity: 1 }]);
    expect(input.note).toContain('Paid in USDC on Arc via BSA Sentry (x402)');
    expect(input.note).toContain(TX);
    expect(input.note).toContain(`${EXPLORER}/tx/${TX}`);
    expect(input.note).toContain('18 or older');
    expect(input.note).toContain('12 USDC');
    expect(input.tags).toEqual(expect.arrayContaining(['BSA Sentry', 'x402']));

    const complete = shop.calls.find((c) => c.op === 'draftOrderComplete')!;
    expect(complete.body.variables).toMatchObject({ id: 'gid://shopify/DraftOrder/77' });
    expect(complete.body.query).toMatch(/paymentPending:\s*false/);

    expect(res.body).toMatchObject({
      paid: true, dryRun: false, txHash: TX, explorer: `${EXPLORER}/tx/${TX}`, amount: '12', currency: 'USDC',
      product: { title: 'Absinthe 50 cl', handle: 'absinthe' }, rights: ['18 or older'],
      order: { id: 'gid://shopify/Order/1001', name: '#1001' },
    });
  });

  it('a failed settlement writes no order and stays a 402', async () => {
    settleAnswer = () => ({ success: false, errorReason: 'settlement_failed', transaction: '', network: NETWORK, payer: PAYER });
    const shop = shopifyFetch();
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/gruyere');
    expect(res.status).toBe(402);
    expect(shop.calls.some((c) => c.op.startsWith('draftOrder'))).toBe(false);
  });

  it('a refused verification (e.g. no 18+ proof) neither settles nor writes an order', async () => {
    verifyAnswer = () => ({ isValid: false, invalidReason: 'AGE_PROOF_REQUIRED', payer: PAYER });
    const shop = shopifyFetch();
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/absinthe');
    expect(res.status).toBe(402);
    expect(seen.settle).toHaveLength(0);
    expect(shop.calls.some((c) => c.op.startsWith('draftOrder'))).toBe(false);
  });

  it('if the write-back fails after settlement, the agent still gets its receipt (200), flagged', async () => {
    const shop = shopifyFetch({ draftOrderCreate: () => ({ errors: [{ message: 'Access denied for draftOrderCreate field.' }] }) });
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/gruyere');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paid: true, txHash: TX, order: null, orderError: expect.stringMatching(/Access denied/) });
  });

  it('userErrors from Shopify are a failed write-back too', async () => {
    const shop = shopifyFetch({
      draftOrderComplete: () => ({ data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: ['id'], message: 'Draft order is invalid' }] } } }),
    });
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/gruyere');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ order: null, orderError: expect.stringMatching(/Draft order is invalid/) });
  });
});

describe('live store: the price, payee and requirements come from the server, never the request', () => {
  it('the facilitator always sees the catalog amount, payee and requirement', async () => {
    const app = await live(shopifyFetch().fn);
    await buy(app, '/shopify/products/absinthe');
    for (const b of [...seen.verify, ...seen.settle]) {
      expect(b.paymentRequirements).toMatchObject({ amount: '12000000', extra: { requires: ['age_over_18'] } });
      expect(b.paymentRequirements.payTo.toLowerCase()).toBe(SHOP_PAYTO);
    }
  });

  it('an offer with the requirement stripped is never settled without it', async () => {
    const shop = shopifyFetch();
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/absinthe', (a) => { delete a.extra.requires; return a; });
    for (const b of [...seen.verify, ...seen.settle]) expect(b.paymentRequirements.extra.requires).toEqual(['age_over_18']);
    if (res.status === 200) expect(seen.verify).toHaveLength(1);
    else expect(seen.settle).toHaveLength(0);
  });

  it('a lowered amount is a 402 and is never settled', async () => {
    const shop = shopifyFetch();
    const app = await live(shop.fn);
    const res = await buy(app, '/shopify/products/absinthe', (a) => ({ ...a, amount: '1' }));
    expect(res.status).toBe(402);
    expect(seen.settle).toHaveLength(0);
    expect(shop.calls.some((c) => c.op.startsWith('draftOrder'))).toBe(false);
  });
});

// A Shopify store, shoppable by AI agents over x402, with Know-Your-Agent rules per product.
//
//   GET /shopify                     the catalog (JSON, or a small HTML page for a browser)
//   GET /shopify/products/<handle>   x402: 402 for the product price in USDC on Arc, then on a
//                                    paid retry: settle, write the order into Shopify, receipt
//
// Prices and the payee come from Shopify and our config, never from the request. A product's
// KYA requirements come from its tags (`bsa:age_over_18`, `bsa:jurisdiction_not:US`, ...) and
// travel in `extra.requires`, which our facilitator enforces before it settles anything.
//
// The stock x402 Express middleware only takes static routes, and serves the response before it
// settles. Here the order must be written AFTER a successful settlement, so this handler drives
// the same x402 server objects itself: processHTTPRequest -> processSettlement -> Shopify.
//
// With no Shopify credentials (or SHOPIFY_DRY_RUN=true) it serves a built-in demo catalog and
// skips the order write-back, but still settles for real, so the demo never depends on a store.
import express, { type Response, type Router } from 'express';
import { ExpressAdapter, x402HTTPResourceServer, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  FacilitatorResponseError, HTTPFacilitatorClient, withPrivateCacheControl,
  type HTTPRequestContext, type HTTPResponseInstructions, type RouteConfig,
} from '@x402/core/server';

export type ShopifyAuth = { token: string } | { clientId: string; clientSecret: string };

export type ShopifyEnv = {
  /** `xxx.myshopify.com`. */
  shop?: string;
  auth?: ShopifyAuth;
  apiVersion: string;
  /** Demo catalog, no order write-back (payments still settle). */
  dryRun: boolean;
};

export type ShopifyConfig = ShopifyEnv & {
  /** The merchant address every Shopify sale is paid to. */
  payTo: string;
  /** Block explorer base URL, for the receipt link (`<explorer>/tx/<hash>`). */
  explorerUrl: string;
  catalogTtlMs?: number;
  /** For the Shopify Admin API only (the x402 facilitator client uses the global fetch). */
  fetch?: typeof fetch;
  now?: () => number;
};

export type ShopifyOptions = ShopifyConfig & {
  facilitatorUrl: string;
  network: `${string}:${string}`;
  /** Where the merchants are reachable from the agent's side. */
  publicUrl: string;
};

export type ShopifyProduct = {
  title: string;
  handle: string;
  variantId: string;
  /** As Shopify gives it, in the store's currency. */
  price: string;
  currency: string;
  /** USDC base units (6 dp). 1 store currency unit = 1 USDC for the demo. */
  amount: string;
  tags: string[];
  /** KYA requirements for `extra.requires`, from the `bsa:` tags. */
  requires: string[];
};

const DEFAULT_API_VERSION = '2025-07';
const DEFAULT_CATALOG_TTL_MS = 60_000;
const SHOPIFY_TIMEOUT_MS = 15_000;
const MAX_PRODUCTS = 50;

// ------------------------------------------------------------------ configuration

export function shopifyEnv(env: Record<string, string | undefined>): ShopifyEnv {
  const shop = env.SHOPIFY_SHOP?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') || undefined;
  const auth: ShopifyAuth | undefined = env.SHOPIFY_ADMIN_TOKEN
    ? { token: env.SHOPIFY_ADMIN_TOKEN }
    : env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET
      ? { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET }
      : undefined;
  return {
    ...(shop ? { shop } : {}),
    ...(auth ? { auth } : {}),
    apiVersion: env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION,
    dryRun: env.SHOPIFY_DRY_RUN === 'true' || !shop || !auth,
  };
}

// ------------------------------------------------------------------ tags -> KYA requirements

type ListKind = 'jurisdiction_in' | 'jurisdiction_not';

/**
 * `bsa:age_over_18` -> `age_over_18`; `bsa:jurisdiction_not:US` + `bsa:jurisdiction_not:RU` ->
 * `jurisdiction_not:RU,US` (Shopify splits tags on commas, so it is one country per tag, and the
 * countries of one kind are unioned into ONE requirement: two `jurisdiction_in` requirements would
 * have to hold together). Any other `bsa:` tag is passed through verbatim: the facilitator can never
 * satisfy it, so a typo makes the product unbuyable instead of open to everyone.
 */
export function requirementsFromTags(tags: string[]): string[] {
  const out = new Set<string>();
  const lists: Record<ListKind, Set<string>> = { jurisdiction_in: new Set(), jurisdiction_not: new Set() };
  for (const raw of tags) {
    const tag = raw.trim();
    if (!/^bsa:/i.test(tag)) continue;
    const [kind = '', code, ...rest] = tag.slice(4).split(':');
    const k = kind.toLowerCase();
    if (k === 'age_over_18' && code === undefined) {
      out.add('age_over_18');
    } else if ((k === 'jurisdiction_in' || k === 'jurisdiction_not') && rest.length === 0 && /^[a-z]{2}$/i.test(code ?? '')) {
      lists[k].add(code!.toUpperCase());
    } else {
      out.add(tag);
    }
  }
  for (const k of ['jurisdiction_in', 'jurisdiction_not'] as const) {
    if (lists[k].size > 0) out.add(`${k}:${[...lists[k]].sort().join(',')}`);
  }
  return [...out];
}

/** Same wording as `describeRequirement` in @bsa-sentry/types (not a dependency of this app). */
export function describeRight(requirement: string): string {
  if (requirement === 'age_over_18') return '18 or older';
  const [kind, list = ''] = requirement.split(':', 2);
  if (kind === 'jurisdiction_not') return `not a ${list.split(',').join('/')} person`;
  if (kind === 'jurisdiction_in') return `under the jurisdiction of ${list.split(',').join(', ')}`;
  return requirement;
}

// ------------------------------------------------------------------ prices

/** A store price as USDC base units, exactly (no floats). Null if not a positive amount with at most 6 decimals. */
export function usdcUnits(price: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) return null;
  const units = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  return units > 0n ? units.toString() : null;
}

/** 4500000 -> "4.5". */
function usdcAmount(units: string): string {
  const u = BigInt(units);
  const frac = u % 1_000_000n;
  return frac === 0n ? `${u / 1_000_000n}` : `${u / 1_000_000n}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

// ------------------------------------------------------------------ catalog

const PRODUCTS_QUERY = `query BsaCatalog($first: Int!) {
  shop { name currencyCode }
  products(first: $first, query: "status:active", sortKey: TITLE) {
    nodes { title handle tags variants(first: 1) { nodes { id price } } }
  }
}`;

type Catalog = { shop: string | null; shopName: string; currency: string; products: ShopifyProduct[] };

/** Buyable products from the Admin GraphQL answer: a variant and a positive price, or skipped. */
export function mapCatalog(data: any): ShopifyProduct[] {
  const currency = String(data?.shop?.currencyCode ?? 'USD');
  const out: ShopifyProduct[] = [];
  for (const p of data?.products?.nodes ?? []) {
    const variant = p?.variants?.nodes?.[0];
    const price = variant?.price == null ? '' : String(variant.price);
    const amount = usdcUnits(price);
    if (typeof p?.handle !== 'string' || !p.handle || typeof variant?.id !== 'string' || !amount) continue;
    const tags: string[] = Array.isArray(p.tags) ? p.tags.map(String) : [];
    out.push({ title: String(p.title ?? p.handle), handle: p.handle, variantId: variant.id, price, currency, amount, tags, requires: requirementsFromTags(tags) });
  }
  return out;
}

const demo = (title: string, handle: string, price: string, tags: string[]): ShopifyProduct =>
  ({ title, handle, variantId: `demo-${handle}`, price, currency: 'USD', amount: usdcUnits(price)!, tags, requires: requirementsFromTags(tags) });

/** DRY_RUN catalog: no store needed. */
export const DEMO_PRODUCTS: readonly ShopifyProduct[] = [
  demo('Arc Roast coffee beans 250 g', 'arc-roast-coffee', '3.50', ['coffee']),
  demo('Pinot Noir 2022, 75 cl', 'pinot-noir-2022', '4.50', ['wine', 'bsa:age_over_18']),
  demo('Sentry Genesis token drop', 'sentry-genesis-drop', '5.00', ['limited', 'bsa:jurisdiction_not:US']),
];

// ------------------------------------------------------------------ Shopify Admin API

type GraphQL = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const errorText = (e: unknown) =>
  Array.isArray(e) ? e.map((x) => (x && typeof x === 'object' && 'message' in x ? String(x.message) : String(x))).join('; ') : String(e);

function adminClient(shop: string, apiVersion: string, auth: ShopifyAuth, fetchFn: typeof fetch, now: () => number): GraphQL {
  let issued: { token: string; until: number } | null = null;

  // A Dev Dashboard app has no static token: exchange its client credentials (valid ~24 h).
  async function token(): Promise<string> {
    if ('token' in auth) return auth.token;
    if (issued && issued.until > now()) return issued.token;
    const res = await fetchFn(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: auth.clientId, client_secret: auth.clientSecret }).toString(),
      signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || typeof body?.access_token !== 'string') throw new Error(`Shopify token exchange failed (${res.status})`);
    // Renew 5 minutes early.
    issued = { token: body.access_token, until: now() + (Number(body.expires_in) || 86_399) * 1000 - 300_000 };
    return issued.token;
  }

  return async (query, variables = {}) => {
    const res = await fetchFn(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': await token() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Shopify Admin API ${res.status}${body?.errors ? `: ${errorText(body.errors)}` : ''}`);
    // GraphQL errors (e.g. a missing scope) arrive with HTTP 200.
    if (body?.errors) throw new Error(`Shopify Admin API: ${errorText(body.errors)}`);
    return body?.data;
  };
}

const DRAFT_ORDER_CREATE = `mutation BsaDraftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
}`;

// `paymentPending: false` = completed as paid. (Deprecated argument in 2025-07, still accepted, and its default.)
const DRAFT_ORDER_COMPLETE = `mutation BsaDraftOrderComplete($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: false) { draftOrder { id name order { id name } } userErrors { field message } }
}`;

const userErrors = (payload: any) => {
  if (Array.isArray(payload?.userErrors) && payload.userErrors.length > 0) throw new Error(`Shopify: ${errorText(payload.userErrors)}`);
};

type Sale = { product: ShopifyProduct; txHash: string; explorer: string; payer?: string };

function orderNote({ product, txHash, explorer, payer }: Sale): string {
  const rights = product.requires.map(describeRight);
  return [
    'Paid in USDC on Arc via BSA Sentry (x402).',
    `Amount: ${usdcAmount(product.amount)} USDC (store price ${product.price} ${product.currency}; 1 ${product.currency} = 1 USDC for this demo)`,
    `Arc tx: ${txHash}`,
    `Explorer: ${explorer}`,
    ...(payer ? [`Paid by agent: ${payer}`] : []),
    `Rights proven by the agent: ${rights.length > 0 ? rights.join('; ') : 'none required'}`,
  ].join('\n');
}

async function writeOrder(graphql: GraphQL, sale: Sale) {
  const created = (await graphql(DRAFT_ORDER_CREATE, {
    input: {
      lineItems: [{ variantId: sale.product.variantId, quantity: 1 }],
      note: orderNote(sale),
      tags: ['BSA Sentry', 'x402', 'USDC on Arc', ...(sale.product.requires.length > 0 ? ['KYA verified'] : [])],
      // The order total must be what was paid.
      taxExempt: true,
    },
  }))?.draftOrderCreate;
  userErrors(created);
  const draft = created?.draftOrder;
  if (!draft?.id) throw new Error('Shopify: no draft order was created');

  const completed = (await graphql(DRAFT_ORDER_COMPLETE, { id: draft.id }))?.draftOrderComplete;
  userErrors(completed);
  const order = completed?.draftOrder?.order;
  return { id: order?.id ?? null, name: order?.name ?? null, draftOrder: draft.name ?? draft.id };
}

// ------------------------------------------------------------------ the routes

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function sendInstructions(res: Response, r: HTTPResponseInstructions) {
  res.status(r.status);
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  if (r.isHtml) res.send(r.body);
  else res.json(r.body ?? {});
}

export function createShopifyRouter(opts: ShopifyOptions): Router {
  const now = opts.now ?? Date.now;
  const ttl = opts.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  const base = opts.publicUrl.replace(/\/$/, '');
  const explorer = opts.explorerUrl.replace(/\/$/, '');
  const graphql = !opts.dryRun && opts.shop && opts.auth
    ? adminClient(opts.shop, opts.apiVersion, opts.auth, opts.fetch ?? fetch, now)
    : null;

  // ---- catalog, cached briefly; a stale copy beats an error if Shopify is down
  let cache: { at: number; catalog: Catalog } | null = null;
  const demoCatalog: Catalog = { shop: null, shopName: 'Sentry Shop', currency: 'USD', products: [...DEMO_PRODUCTS] };
  async function catalog(): Promise<Catalog> {
    if (!graphql) return demoCatalog;
    if (cache && now() - cache.at < ttl) return cache.catalog;
    try {
      const data = await graphql(PRODUCTS_QUERY, { first: MAX_PRODUCTS });
      cache = {
        at: now(),
        catalog: { shop: opts.shop!, shopName: String(data?.shop?.name ?? opts.shop), currency: String(data?.shop?.currencyCode ?? 'USD'), products: mapCatalog(data) },
      };
      return cache.catalog;
    } catch (e) {
      if (cache) return cache.catalog;
      throw e;
    }
  }

  // ---- x402: our own resource server, synced with the facilitator once (retried on failure)
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: opts.facilitatorUrl }))
    .register(opts.network, new ExactEvmScheme());
  let synced: Promise<void> | null = null;
  const ready = () => (synced ??= resourceServer.initialize().catch((e) => { synced = null; throw e; }));

  const productUrl = (handle: string) => `${base}/shopify/products/${encodeURIComponent(handle)}`;
  // Built from the server's catalog only: price, payee and requirements never come from the request.
  const routeFor = (p: ShopifyProduct, shopName: string): RouteConfig => ({
    accepts: {
      scheme: 'exact',
      network: opts.network,
      payTo: opts.payTo,
      price: `$${usdcAmount(p.amount)}`,
      ...(p.requires.length > 0 ? { extra: { requires: [...p.requires] } } : {}),
    },
    // Becomes the Flex hint (and the payee label if trusted): all products share one payee.
    description: `${shopName} - ${p.title}`,
    mimeType: 'application/json',
  });

  const router = express.Router();

  router.get('/', async (req, res) => {
    let c: Catalog;
    try {
      c = await catalog();
    } catch (e) {
      res.status(502).json({ error: `the Shopify store is not reachable: ${(e as Error).message}` });
      return;
    }
    const body = {
      merchant: c.shopName,
      shop: c.shop,
      dryRun: !graphql,
      note: `Prices are in ${c.currency}; 1 ${c.currency} = 1 USDC for this demo. Pay with x402: USDC on Arc testnet (${opts.network}). Products with "requires" need the agent to prove those rights.`,
      products: c.products.map((p) => ({
        title: p.title, handle: p.handle, price: p.price, currency: p.currency,
        usdc: usdcAmount(p.amount), amount: p.amount, tags: p.tags, requires: p.requires,
        rights: p.requires.map(describeRight), url: productUrl(p.handle),
      })),
    };
    if (req.accepts(['json', 'html']) === 'html') {
      const rows = body.products.map((p) => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a> - ${escapeHtml(p.usdc)} USDC${
        p.rights.length > 0 ? ` (agent must prove: ${escapeHtml(p.rights.join(', '))})` : ''}</li>`).join('\n    ');
      res.type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(body.merchant)}</title></head>
<body>
  <h1>${escapeHtml(body.merchant)}</h1>
  <p>${escapeHtml(body.note)}</p>
  <ul>
    ${rows}
  </ul>
</body>
</html>`);
      return;
    }
    res.json(body);
  });

  router.get('/products/:handle', async (req, res) => {
    let c: Catalog;
    try {
      c = await catalog();
    } catch (e) {
      res.status(502).json({ error: `the Shopify store is not reachable: ${(e as Error).message}` });
      return;
    }
    const product = c.products.find((p) => p.handle === req.params.handle);
    if (!product) {
      res.status(404).json({ error: `no product "${req.params.handle}" in this store`, catalog: `${base}/shopify` });
      return;
    }

    try {
      await ready();
    } catch (e) {
      res.status(502).json({ error: `the payment facilitator is not reachable: ${(e as Error).message}` });
      return;
    }

    // One catch-all route: this request IS the product.
    const http = new x402HTTPResourceServer(resourceServer, routeFor(product, c.shopName));
    const adapter = new ExpressAdapter(req);
    const context: HTTPRequestContext = {
      adapter,
      path: req.originalUrl.split('?')[0]!,
      method: req.method,
      paymentHeader: adapter.getHeader('payment-signature') || adapter.getHeader('x-payment'),
    };

    try {
      const result = await http.processHTTPRequest(context);
      if (result.type === 'payment-error') return sendInstructions(res, result.response);
      if (result.type !== 'payment-verified') return void res.status(500).end(); // unreachable: the route matches every path

      const settled = await http.processSettlement(
        result.paymentPayload, result.paymentRequirements, result.declaredExtensions,
        { request: context }, undefined, result.beforeHandlerSettlement,
      );
      if (!settled.success) return sendInstructions(res, settled.response);

      // The money has moved: from here on the agent always gets its receipt (200).
      const txHash = settled.transaction;
      const sale: Sale = { product, txHash, explorer: `${explorer}/tx/${txHash}`, ...(settled.payer ? { payer: settled.payer } : {}) };
      let order: Awaited<ReturnType<typeof writeOrder>> | null = null;
      let orderError: string | undefined;
      if (graphql) {
        try {
          order = await writeOrder(graphql, sale);
        } catch (e) {
          orderError = (e as Error).message;
          console.error(`[shopify] paid (${txHash}) but the order write-back failed: ${orderError}`);
        }
      }

      for (const [k, v] of Object.entries(settled.headers)) res.setHeader(k, v);
      res.setHeader('Cache-Control', withPrivateCacheControl(null));
      res.json({
        paid: true,
        merchant: c.shopName,
        product: { title: product.title, handle: product.handle, price: product.price, currency: product.currency },
        amount: usdcAmount(product.amount),
        currency: 'USDC',
        network: opts.network,
        txHash,
        explorer: sale.explorer,
        payer: settled.payer ?? null,
        rights: product.requires.map(describeRight),
        dryRun: !graphql,
        order,
        ...(orderError ? { orderError } : {}),
        message: !graphql
          ? 'Paid. DRY_RUN: demo catalog, no Shopify order was written.'
          : order
            ? `Paid. Shopify order ${order.name ?? order.draftOrder} created and marked as paid.`
            : 'Paid, but the Shopify order could not be written; the merchant has the transaction to reconcile it.',
      });
    } catch (e) {
      if (e instanceof FacilitatorResponseError) {
        res.status(502).json({ error: e.message });
        return;
      }
      console.error(e);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

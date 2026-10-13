# Shopify: a real store, shoppable by AI agents

BSA Sentry turns a Shopify store into something an AI agent can buy from over x402: USDC on Arc
testnet, signed by the user's Ledger Flex within its on-device rules, settled by our facilitator.
Each product can require the agent to prove a right about its owner (18 or older, not a US person,
...), checked by the facilitator before any money moves. The sale then shows up in the Shopify
admin as a paid order, with the Arc transaction in its note.

Code: `apps/merchants/src/shopify.ts`, mounted at `/shopify` in `apps/merchants/src/app.ts`.
Tests: `apps/merchants/test/shopify.test.ts`.

## Routes

Under the merchants' public URL (`MERCHANT_URL`; through the server, `<PUBLIC_API_URL>/shops`):

| Route | What it does |
|---|---|
| `GET /shopify` | The catalog: title, handle, price, tags, requirements, and each product's x402 URL. JSON for agents, a small HTML page for a browser. Cached for 60 s. |
| `GET /shopify/products/<handle>` | x402. Without payment: `402` with the price in USDC, `payTo` = the Shopify merchant address, `extra.requires` from the tags. With a valid payment: settle, write the order, return a receipt. Unknown handle: `404`. |

The receipt (JSON, plus the standard `PAYMENT-RESPONSE` header):
`paid`, `product`, `amount` + `currency: "USDC"`, `txHash`, `explorer` (link), `payer`, `rights`
(the rights proven, in words), `order` (`{ id, name }` of the Shopify order, or `null`),
`dryRun`, and `orderError` if the write-back failed.

## Pricing

**1 unit of the store currency = 1 USDC, for the demo.** A 4.50 CHF product costs 4.5 USDC. The
price comes from the product's first variant; products with no variant or a zero price are not
listed. The price and the payee always come from Shopify and our config, never from the request.

With the demo rules on the Flex (auto max 5, hard max 50 USDC), keep demo products at 50 or less
(above that the Flex refuses outright) and at 5 or less if you want them paid without a tap once
the store is a trusted merchant.

## KYA tags (per product requirements)

Add tags to a product in the Shopify admin:

| Tag | Requirement sent to the facilitator | Meaning |
|---|---|---|
| `bsa:age_over_18` | `age_over_18` | the agent's owner is 18 or older |
| `bsa:jurisdiction_not:US` | `jurisdiction_not:US` | not a US person (e.g. a token sale under Reg S) |
| `bsa:jurisdiction_in:FR` | `jurisdiction_in:FR` | under French jurisdiction |

- **One country per tag** (Shopify splits tags on commas). Several tags of the same kind are
  merged: `bsa:jurisdiction_in:FR` + `bsa:jurisdiction_in:DE` = `jurisdiction_in:DE,FR` (either
  country), `bsa:jurisdiction_not:US` + `bsa:jurisdiction_not:RU` = neither.
- Prefix and kind are case-insensitive, country codes are ISO 3166-1 alpha-2.
- **Fail closed:** any other `bsa:` tag (a typo such as `bsa:age_over_21` or
  `bsa:jurisdiction_not:USA`) is passed through as is. No agent can prove it, so the product
  cannot be bought until the tag is fixed. A typo never opens a restricted product to everyone.
- Tags without the `bsa:` prefix are ignored.

## The flow

```
agent (MCP x402_fetch)        merchants /shopify                facilitator (our server)   Shopify Admin API
  GET /shopify/products/x  ->  catalog (cached) -> 402
  Flex signs (rules), retry with PAYMENT-SIGNATURE
                           ->  same offer rebuilt from the catalog
                               verify ---------------------------> signature, amount, payee,
                                                                    extra.requires vs. proof
                               settle ---------------------------> transferWithAuthorization on Arc
                               (only after a successful settle)
                               draftOrderCreate (variant, note, tags) ------------------------------>
                               draftOrderComplete(paymentPending: false) = paid ------------------>
  <- 200 receipt (order, tx, explorer link)
```

The order note reads: "Paid in USDC on Arc via BSA Sentry (x402)", the amount, the Arc tx hash and
explorer link, the paying agent address, and the rights proven (e.g. "18 or older"). The order is
tagged `BSA Sentry`, `x402`, `USDC on Arc` (and `KYA verified` when the product had requirements).
Draft orders are created tax exempt so the order total equals what was paid.

If the write-back fails after settlement (missing scope, Shopify down), the agent still gets a
`200` receipt with `order: null` and `orderError`: the money has moved, and the tx hash lets the
merchant reconcile. Nothing is ever written to Shopify for a payment that did not settle.

## DRY_RUN (no store needed)

With no Shopify credentials, or `SHOPIFY_DRY_RUN=true`, the integration serves a built-in demo
catalog (a coffee bag, a wine bottle tagged `bsa:age_over_18`, a limited token drop tagged
`bsa:jurisdiction_not:US`, priced in USD), settles payments for real, and skips the order
write-back. The demo never depends on a store being reachable.

## Setting up a store

1. **Dev store.** In the Shopify [Dev Dashboard](https://dev.shopify.com/dashboard), open
   **Dev stores** and create one (free). Create it there, not from a store admin: the client
   credentials grant only works when the app and the store belong to the same organization.
2. **App.** In the Dev Dashboard, create an app (e.g. "BSA Sentry"). On its version, select the
   Admin API scopes `read_products`, `read_orders`, `write_orders`, `read_draft_orders`,
   `write_draft_orders`, release the version, and install the app on the dev store.
3. **Credentials.** Copy the app's Client ID and Client secret into `.env` as `SHOPIFY_CLIENT_ID`
   and `SHOPIFY_CLIENT_SECRET`, and the store domain as `SHOPIFY_SHOP`. The merchants exchange
   them for an Admin API token (valid about 24 h, renewed automatically).
   A store that already has a legacy custom app (created in the store admin before 2026) can use
   its Admin API access token instead: `SHOPIFY_ADMIN_TOKEN=shpat_...`.
4. **Products.** Add a few active products with a price, and the `bsa:` tags above.
5. **Payee.** Set `MERCHANT_SHOPIFY_ADDRESS` to an address of its own (it falls back to the bakery
   address). Restart the merchants and open `<MERCHANT_URL>/shopify`.

## Environment

| Variable | Default | |
|---|---|---|
| `SHOPIFY_SHOP` | none | `your-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | none | Dev Dashboard app (client credentials grant) |
| `SHOPIFY_ADMIN_TOKEN` | none | Admin API token (`shpat_...`), used instead of the client credentials if set |
| `SHOPIFY_API_VERSION` | `2025-07` | Admin GraphQL API version |
| `SHOPIFY_DRY_RUN` | `false` | `true` forces the demo catalog and no write-back; forced when there are no credentials |
| `MERCHANT_SHOPIFY_ADDRESS` | `MERCHANT_BOULANGERIE_ADDRESS` | payee of every Shopify sale |
| `ARC_EXPLORER` | `https://explorer.testnet.arc.io` | explorer link in receipts and order notes |

Secrets live only in `.env` (gitignored). `.env.example` lists the names with empty values.

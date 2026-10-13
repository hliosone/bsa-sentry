# Selling to AI agents with BSA Sentry

A shop that already speaks x402 can take payments from BSA Sentry agents today, and can require
rights about the person behind the agent (18 or older, a jurisdiction) without learning who that
person is. You keep the standard x402 middleware and point it at our facilitator. There is no
BSA Sentry SDK to install.

What you get:

- USDC on Arc testnet, settled on chain by our facilitator (EIP-3009 `transferWithAuthorization`,
  x402 `exact` scheme).
- Payments signed by the buyer's Ledger Flex, inside limits the buyer set on the device.
- Optional rights checks, listed per route in `extra.requires`.

## 1. Integrate

The demo shops in [`apps/merchants/src/app.ts`](../apps/merchants/src/app.ts) are the reference.
Trimmed from `createMerchantsApp`:

```ts
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl }))
  .register(cfg.network, new ExactEvmScheme());

// ... one entry per paid route (see below)

app.use(paymentMiddleware(routes as any, resourceServer));
```

The route table, written out for two of the demo shops:

```ts
const routes = {
  'GET /wine': {
    accepts: {
      scheme: 'exact', price: '$4.5', network: 'eip155:5042002',
      payTo: '0xYourAddress',
      extra: { requires: ['age_over_18'] },
    },
    description: 'Corner Wines - a bottle',
  },
  'GET /presale': {
    accepts: {
      scheme: 'exact', price: '$5', network: 'eip155:5042002',
      payTo: '0xYourAddress',
      extra: { requires: ['jurisdiction_not:US'] },
    },
    description: 'Token presale (non-US)',
  },
};
```

Settings:

| Setting | Value |
|---|---|
| Facilitator URL | `https://<bsa-sentry-server>/x402` (endpoints `/supported`, `/verify`, `/settle`) |
| Network | `eip155:5042002` (Arc testnet) |
| Scheme | `exact` |
| Asset | USDC, `0x3600000000000000000000000000000000000000` (6 decimals) |

Start the facilitator before your shop: the x402 middleware reads `/supported` once, at startup.

## 2. Requiring rights

List what the buyer must prove in `extra.requires`. Every entry must be met.

| Requirement | Met when the agent holds |
|---|---|
| `age_over_18` | the right `age_over_18` |
| `jurisdiction_not:US` (or `jurisdiction_not:US,RU`) | a jurisdiction right, and none of the listed countries |
| `jurisdiction_in:FR,DE` | a jurisdiction right in one of the listed countries |

Country codes are ISO 3166-1 alpha-2. Anything else, or a jurisdiction requirement when the agent
holds no jurisdiction right, is not met: the facilitator fails closed. The logic is
`satisfies()` in [`packages/types/src/identity.ts`](../packages/types/src/identity.ts).

When a route lists requirements, the buyer's agent attaches a proof to the payment
(`paymentPayload.extensions.bsaAge`): the agent delegation signed on the buyer's Flex, and the
attestation our verifier signed after an EU Digital Identity Wallet presentation. Routes without
requirements receive no proof.

## 3. What the facilitator checks, in order

`/verify` ([`facilitator.ts`](../apps/server/src/facilitator/facilitator.ts)), each failure with its
own reason:

1. The payload is well formed: authorization fields and a 65-byte signature. `invalid_payload`
2. Scheme `exact` on this network. `unsupported_scheme_or_network`
3. The asset is USDC. `invalid_asset`
4. The offer the buyer accepted is the one you asked for (scheme, network, amount, asset, payTo).
   `requirements_mismatch`
5. The authorization pays your `payTo`. `invalid_pay_to`
6. The amount is exactly your price. `invalid_amount`
7. The authorization is valid now and for at least 6 more seconds. `authorization_expired`,
   `authorization_not_yet_valid`
8. The EIP-712 signature recovers to the payer, before any chain read. `invalid_signature`
9. If you listed requirements, the proof ([`age.ts`](../apps/server/src/facilitator/age.ts)):
   1. present. `AGE_PROOF_REQUIRED`
   2. well formed. `AGE_PROOF_INVALID`
   3. the delegation signature recovers to the owner's account. `DELEGATION_INVALID_SIGNATURE`
   4. the owner has not revoked this delegation. `DELEGATION_REVOKED`
   5. the delegated agent is the payer. `DELEGATION_WRONG_AGENT`
   6. the delegation has not expired. `DELEGATION_EXPIRED`
   7. the delegated rights meet every requirement. `DELEGATION_MISSING_CLAIM`
   8. the delegation points at exactly this attestation. `ATTESTATION_HASH_MISMATCH`
   9. the attestation is signed by our verifier. `ATTESTATION_WRONG_ISSUER`
   10. the attestation is about the owner who delegated. `SUBJECT_MISMATCH`
   11. the attestation has not expired. `ATTESTATION_EXPIRED`
   12. every delegated right is one the attestation states. `ATTESTATION_WRONG_CLAIM`
10. The nonce is unused on chain, and the payer holds enough USDC. `nonce_already_used`,
    `insufficient_funds`

`/settle` runs the same checks again, submits `transferWithAuthorization` on Arc (max fee at least
20 gwei, Arc drops anything lower), waits for the receipt, and checks it holds exactly one USDC
transfer from the payer to you for the amount. `settlement_failed`, `settlement_mismatch`

The facilitator holds no spending rules. Those live on the buyer's Flex, which decided before
signing.

## 4. What you learn, and what you do not

On every payment: the agent's address (the payer), the amount, and the Arc transaction hash.

When you require rights, the proof also shows you:

- the agent's address and name, the rights granted to it, and the grant's expiry;
- the owner's Ledger account address (`0xMAIN`), which is the same for every shop that requires
  rights from this person;
- every right our verifier attested for that person, for example `age_over_18,jurisdiction:FR`,
  even if your route only asks for one of them, and the attestation's dates.

You do not learn the name, the birthdate, the list of nationalities, any document number, or any
other attribute of the identity credential. BSA Sentry does not store them either. A shop that
requires no rights receives no identity data at all.

## 5. What is standard and what is ours

Standard: the x402 middleware, the 402 response, the payment payload and the `exact` scheme. Any
x402 client can pay your routes, and you can point the same middleware at another facilitator.

Ours: the rights check. The middleware itself enforces nothing; `extra.requires` is enforced only
by the BSA Sentry facilitator. Behind another facilitator the field is ignored.

## 6. Shopify

A Shopify store can sell to agents through the same facilitator, with no change to the store
itself: products tagged like `bsa:age_over_18` or `bsa:jurisdiction_not:US` require that right,
and after settlement the order is written back to Shopify as paid, with the Arc transaction hash in
its note. Routes: `/shopify` (catalog) and `/shopify/products/<handle>` (x402). Setup and details:
[`SHOPIFY.md`](SHOPIFY.md).

## 7. Try it

The demo shops answer HTTP 402 with their price and requirements:

```sh
curl -i https://<bsa-sentry-server>/shops/wine     # 402 with a PAYMENT-REQUIRED header
```

Paths: `/shops/cafe`, `/shops/bakery`, `/shops/restaurant`, `/shops/wine`, `/shops/presale`,
`/shops/promo`, and the Shopify catalog at `/shops/shopify`. To pay one, ask an agent connected to BSA Sentry over MCP, for example:
"Buy me a bottle of wine at https://<bsa-sentry-server>/shops/wine".

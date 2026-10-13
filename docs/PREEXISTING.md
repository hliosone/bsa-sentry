# Pre-existing code disclosure

Everything in BSA Sentry was written after **Oct 7, 2026**, except what is listed here.
This is a required hackathon disclosure.

## 1. Ledger's `app-boilerplate-rust` (upstream, Apache-2.0)

`device-app/app/` descends from **`LedgerHQ/app-boilerplate-rust`, upstream commit `0f857a7`**:
the Cargo manifest shape, `build.rs` glyph pipeline, `src/app_ui/`, `src/settings.rs`,
`src/swap.rs`, `src/utils.rs`, `src/handlers/get_public_key.rs`, `get_version.rs`, `sign_tx.rs`,
the `.github/`, `tools/`, `tests/` scaffolding and the icons/glyphs.
Written by Ledger, not by us. Our additions are the BSA Sentry handlers, `device-app/core/`, the
NBGL screens and the manifest changes. Of the upstream files, only the manifest shape, `build.rs`,
`get_version.rs`, the glyphs and the top-level config files (`ledger_app.toml`, `rust-toolchain.toml`, lint configs, `LICENSE.md`) remain; the rest (including `app_ui/` and `settings.rs`) has since
been removed.

## 2. Our own feasibility code (Oct 10–11, 2026 — before the build)

Written by the team during the Ledger N3XT feasibility tests, on this exact Flex, **before** the
BSA Sentry build started. Two read-only exports of the same code live next to this repo:
`../AgentGuard-feasibility/` and `../agentguard-feasibility-tests/` (byte-identical code; see
`docs/REFERENCE_MAP.md`). "AgentGuard" is the old working name of BSA Sentry.

Reused here, **re-introduced under tests** (test written first, then the code ported):

- `device-app/src/handlers/x402.rs` — EIP-3009 digest construction, DER→(r,s), amount formatting.
- `device-app/src/handlers/review3.rs` — 3-choice NBGL C-layout screen with the raw-ticker 60 s timeout.
- `device-app/src/handlers/long_cmd.rs` — chunked-APDU reassembly and `AtomicStorage` NVM.
- `host-test/lib.ts`, `arc-lib.ts` — DMK transport helpers and Arc constants.
- `host-test/arc-settle.ts`, `arc-domain.ts` — Arc settlement, 20 gwei floor, mirror-log filtering.
- `x402-arc/facilitator.ts`, `server.ts`, `client.ts` — x402 2.28 verify/settle and `extensions` passthrough.
- `browser-relay-mcp-keyring/web/main.ts`, `relay-server.ts`, `mcp-server.ts`,
  `keyring-web/web/main.ts` — WebHID + DMK in Chrome, WS relay, remote MCP + OAuth, Ledger Key Ring.

Not reused: the hardcoded test addresses, and `SIGN_3009_SILENT` (`E0 0F`), a debug command that
signs with no policy and no tap. **It does not exist in BSA Sentry**, and the feasibility app that
contains it ("Rust Boilerplate") is deleted from the Flex in Phase C step 1.

## 3. The team's EUDIW verifier integration (may predate Oct 7, 2026)

`../eudi-verifier-test/` (`server.mjs`, `index.html`) is the team's working integration with the
public EUDI reference verifier (`verifier-backend.eudiw.dev`, OpenID4VP 1.0 + DCQL), used with a
PID in the Procivis wallet. Its request-building logic, CA-trust handling and polling flow are
documented in `docs/EUDIW.md` and ported into `apps/server`'s `/age` routes under tests.

Its `presentations.log` and `server.log` may contain **real personal data** from PID presentations.
They are never copied, committed, or quoted. All EUDIW fixtures in this repo are hand-made.

## 4. Third-party dependencies

Normal npm / crates.io dependencies, used as published: `@ledgerhq/device-management-kit`,
`@ledgerhq/device-transport-kit-web-hid`, `@ledgerhq/ledger-key-ring-protocol`,
`@ledgerhq/hw-transport-webhid`, `@x402/*` 2.28, `@modelcontextprotocol/sdk`, `viem`, `zod`,
`express`, `react`, `vite`, `vitest`, `playwright`, `ledger_device_sdk`, `ledgerblue`, Speculos
and the Ledger app builder Docker images.

## 5. The Shopify integration's design (team's Sept 26 bsa-gate plugin, ETHGlobal Tokyo)

The design of `apps/merchants/src/shopify.ts` (see `docs/SHOPIFY.md`) follows the team's own
Shopify pay plugin for **bsa-gate**, written on Sept 26, 2026 for ETHGlobal Tokyo
(`../../EthGlobalTokyo2026/bsa-gate/plugins/shopify/`): settle a USDC EIP-3009 payment through a
facilitator, then write it back into Shopify with Admin API calls (draft order, completed as
paid, tx hash in the order note), with per-product requirements and a DRY_RUN mode.

That code was read for its design only. **The code here is newly written on Oct 13, 2026**, with
tests first; nothing was copied. What differs:

- **The buyer is an AI agent, not a person on a pay page.** The product URL is an x402 resource
  (402, then a paid retry from the agent's MCP `x402_fetch`), signed by the user's Ledger Flex
  within its on-device rules. There is no checkout session and no browser wallet.
- **Know-Your-Agent per product from tags** (`bsa:age_over_18`, `bsa:jurisdiction_not:US`, ...),
  sent as x402 `extra.requires` and enforced by BSA Sentry's facilitator against the agent's
  delegated credentials. bsa-gate read a product metafield of attestations.
- **Arc testnet** (USDC, chainId 5042002) instead of Ethereum, through BSA Sentry's own facilitator.
- **The catalog comes from Shopify** (Admin GraphQL `products`), and the order is created from the
  product variant after settlement; bsa-gate paid an amount for an existing order id.
- Supports Shopify's Dev Dashboard apps (client credentials grant) as well as Admin API tokens.

## 6. The ISO 20022 statement export's design (Edel Gate, SwissHacks 2026, June 2026)

The Spending page's export (`apps/web/src/state/statement.ts`, `camt053()`) follows the camt.053
exporter that a team member wrote on June 20, 2026 for **Edel Gate** at SwissHacks 2026
(`../../SwissHacks2026/edel-gate/frontend/lib/camt053.js`): one camt.053 `<Ntry>` per on-chain
x402 payment, the transaction hash as the reference, the wallet addresses as the parties.

That file was read for its structure only. **The code here is newly written on Oct 13, 2026**, in
TypeScript, with tests first. What differs:

- **A user's statement, not a merchant's.** Edel Gate booked every entry as a credit to a merchant.
  Here, agent payments are debits and top-ups are credits, with real debit and credit totals, and
  each entry carries a spending category.
- **Valid against the camt.053.001.02 schema.** The mandatory opening and closing balances are
  included, the currency is a 3-letter ISO 4217 code (USD at 1 USDC = 1 USD, stated in every
  entry), amounts have at most 5 decimals, and ids fit the 34/35-character limits (full addresses
  and hashes go in the name and additional-information fields). `test/statement.test.ts` runs
  `xmllint` against the official XSD (`test/fixtures/camt.053.001.02.xsd`, from iso20022.org).
- **Arc testnet (EVM)** instead of the XRP Ledger, and the history is read from the Arc explorer.

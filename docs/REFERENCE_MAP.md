# Reference map — what to reuse, and from where

Three **read-only** reference folders live next to this repo in
`~/Documents/dev/Hackathons/LedgerOpen2026/`. Never modify, move or delete them; never copy their
`node_modules/`, logs, `.pid`, `.env` or build outputs into this repo.

## Which export is canonical

`AgentGuard-feasibility/` (export 1) and `agentguard-feasibility-tests/` (export 2) overlap.
**Verified with `diff -rq`: the code is byte-identical in both.** The differences are only:

| | export 1 `AgentGuard-feasibility/` | export 2 `agentguard-feasibility-tests/` |
|---|---|---|
| device app dir | `app-boilerplate-rust/` | `device-app/` |
| browser dir | `agentguard-feasibility/` | `browser-relay-mcp-keyring/` |
| patch vs upstream | `app-boilerplate-rust.changes.patch` (tracked files only) + `.changed-files.txt` | **`device-app/AGENTGUARD-CHANGES.patch` (every change, incl. new files)** |
| browser run logs | **has `mcp.log`, `relay.log`, `tunnel.log`** (redacted) | absent |
| host-test | has `.gitignore` | has `.env.example` |

**Rule: `agentguard-feasibility-tests/` is canonical** (consolidated patch, clearer names,
`.env.example`). Use `AgentGuard-feasibility/agentguard-feasibility/*.log` when you need the
recorded browser/MCP/tunnel evidence. Both READMEs are worth reading; export 1's is the better
narrative, export 2's has the gotcha list.

## Proven topic → file to reuse

Paths below are relative to `agentguard-feasibility-tests/` unless stated.
**Always re-introduce code under a test in this repo first (write the test, then port).**

| Proven topic | Most complete source | Notes for the port |
|---|---|---|
| **EIP-3009 digest + signing on device** | `device-app/src/handlers/x402.rs` | `parse_and_digest()` is the reference: domain `USDC`/`2`, `from` = own address, `word()` left-pad, `keccak(&[...])` helper. Move the pure parts into `device-app/core` so `cargo test` covers them on the host. `der_to_rs()` + `27 + parity` for `v` is reusable as-is. |
| **Silent signing (no tap)** | same file, `handler_sign_3009_silent` | Proves the OS allows it. **Do not port this command** — it signs with no policy. The silent path in BSA Sentry is `PAY` (INS `0B`) gated by `decide() == Auto`. |
| **3-choice review + 60 s ticker timeout** | `device-app/src/handlers/review3.rs` | NBGL **C layout API** + own event loop counting raw `DecodedEventType::Ticker` (100 ms, 600 = 60 s). `HEADER_RIGHT_TEXT` for "Refuser". Port nearly verbatim into the orange screen; add amount / label / full address / hint / reason lines. |
| **Chunked APDUs + NVM** | `device-app/src/handlers/long_cmd.rs` | P1 `00` first / `01` next, P2 `80` more / `00` last; 1024 B cap → `0xB004`; next-without-first → `0xB00B`; `AtomicStorage`. Reuse the reassembly state machine for SET_POLICY / SIGN_DELEGATION / STORE_CREDENTIALS / GET_CREDENTIALS / RESTORE. |
| **APDU dispatch + non-blocking status** | `device-app/src/main.rs` | Shows how a blocking `NbglStatus` causes `0x6901` on the next APDU, and the `sys`-feature non-blocking alternative. Also the home-screen wiring. |
| **Address from pubkey** | `device-app/src/utils.rs` (`get_address_hash_from_pubkey`) | keccak of the uncompressed pubkey, last 20 bytes. |
| **Cargo manifest for a Flex app** | `device-app/Cargo.toml` | `features = ["io_new", "sys"]`, `path = ["44'/1'", "44'/60'"]`, `curve = ["secp256k1"]`, per-target icons. **`cargo clean -p ledger_device_sdk` after changing path/curve.** |
| **DMK host scripts over USB** | `host-test/lib.ts` (shared: `withDevice`, `send`, payload builder, `check`), `host-test/arc-lib.ts` (Arc constants) | The transport pattern to generalise in `packages/sentry-signer`. Keep DMK-importing Node code **CommonJS**. `process.exit()` at the end (node-hid keeps the loop alive). |
| **Arc settlement + log filtering** | `host-test/arc-settle.ts`, `host-test/arc-domain.ts` | `maxFeePerGas ≥ 20 gwei` floor; two `Transfer` logs → keep `log.address == USDC`; pin reads to the receipt block; replay reverts. Port into the facilitator's `settle`. |
| **x402 server + facilitator with `extensions`** | `x402-arc/facilitator.ts`, `x402-arc/server.ts`, `x402-arc/client.ts` | `@x402/*` 2.28. Facilitator `/supported` `/verify` `/settle`; `extra.requires` reaches `/verify`; `paymentPayload.extensions.<custom>` passes through untouched. **Start the server before the merchants** (`/supported` is asked once, at startup). Recorded request bodies in `x402-arc/bodies/*.json` are ready-made fixtures. |
| **Browser WebHID (DMK in Chrome)** | `browser-relay-mcp-keyring/web/main.ts` | DMK 1.11 + web-hid 1.2.4, plain Vite, no polyfills. `listenToAvailableDevices` gives click-free reconnect. Basis for the `apps/web` bridge. |
| **WebSocket relay** | `browser-relay-mcp-keyring/relay-server.ts` | Hidden-tab proof: drive work from WS messages, never timers. Basis for `WS /relay`. |
| **Remote MCP + OAuth** | `browser-relay-mcp-keyring/mcp-server.ts` | Streamable HTTP + minimal auto-approving OAuth 2.1 (DCR + PKCE). **BSA Sentry must not auto-approve**: `/oauth/authorize` requires a Ledger session + a consent page. Evidence of claude.ai's flow in `AgentGuard-feasibility/agentguard-feasibility/mcp.log` (redacted). |
| **Key Ring in the browser** | `browser-relay-mcp-keyring/keyring-web/web/main.ts` | `@ledgerhq/ledger-key-ring-protocol` 0.24.0 + `hw-transport-webhid` + `vite-plugin-node-polyfills`, **applicationId 17**, Ledger Sync app open on the Flex, `encryptUserData` takes **bytes**. No saved result file → treat as "wired as in the reference", verify in Phase C. |
| **EUDIW verifier flow (PID, `age_over_18`)** | `../eudi-verifier-test/server.mjs` + `index.html` | Public backend `https://verifier-backend.eudiw.dev`, OpenID4VP 1.0 + DCQL, `intended_use_id: TEST-01`, QR `<scheme>://?client_id=x509_hash:…&request_uri=…`, poll `/ui/presentations/{tx}/events` then fetch `/ui/presentations/{tx}`. Trust the EUDI test CAs (`preprod.pki.eudiw.dev` UT 02 / EU 02) via `issuer_chain` so Procivis credentials verify on the first scan. Documented in `docs/EUDIW.md`, ported into `apps/server` `/age`. |

## Hard rules about the reference material

- **`../eudi-verifier-test/presentations.log` and `server.log` may contain real personal data from
  PID presentations. Never read them into docs, never copy them, never paste their contents into
  tests.** All EUDIW test fixtures in this repo are hand-made, with no real personal data.
- The feasibility device app contains `E0 0F` **`SIGN_3009_SILENT`**, which signs with **no policy
  and no tap**. It must **not** exist in BSA Sentry. Loading BSA Sentry on the real Flex in Phase C
  replaces that test app.
- Hardcoded addresses in the reference (`0x1c9940ef…` device, `0xCA4330C2…` submitter) are from the
  old test wallets. This repo derives everything from `.env`; never copy an address across.

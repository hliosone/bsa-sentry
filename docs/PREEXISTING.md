# Pre-existing code disclosure

Everything in BSA Sentry was written after **Oct 7, 2026**, except what is listed here.
This is a required hackathon disclosure.

## 1. Ledger's `app-boilerplate-rust` (upstream, Apache-2.0)

`device-app/app/` descends from **`LedgerHQ/app-boilerplate-rust`, upstream commit `0f857a7`**:
the Cargo manifest shape, `build.rs` glyph pipeline, `src/app_ui/`, `src/settings.rs`,
`src/swap.rs`, `src/utils.rs`, `src/handlers/get_public_key.rs`, `get_version.rs`, `sign_tx.rs`,
the `.github/`, `tools/`, `tests/` scaffolding and the icons/glyphs.
Written by Ledger, not by us. Our additions are the BSA Sentry handlers, `device-app/core/`, the
NBGL screens and the manifest changes.

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
signs with no policy and no tap. **It does not exist in BSA Sentry.**

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

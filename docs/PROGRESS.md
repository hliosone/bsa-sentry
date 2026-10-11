# BSA Sentry — progress

Follow from anywhere: this file is pushed to GitHub after every milestone.

| | |
|---|---|
| Started | Sun 11 Oct 2026, 14:46 CEST |
| Deadline | Tue 13 Oct 2026, 23:59 CEST (Phase B cut-off: Tue 10:00) |
| Phase | **B — finishing (device home screen + menu)** |

## Milestones

- [x] **M0** Setup + contracts (`packages/types`, fixtures, docs) — **207 tests**
- [x] **M1** Device app core + app + Speculos tests — **88 Rust + 57 Speculos**
- [x] **M2** sentry-signer + bridge + harness — **30 + 17 TS, 5 Speculos**
- [x] **M3** Server core + merchants → first coffee on Arc — **real tx on Arc**
- [x] **M4** Auth, OAuth, MCP → Claude buys a coffee — **passes locally and through a public tunnel**
- [x] **M5** Website complete — **Playwright onboarding against the real server**
- [x] **M6** 18+ identity (EUDIW) — **wine paid with 18+ verified on Arc**
- [x] **M7** Key Ring backup/restore — **wipe and one-tap restore proven on Speculos + Arc**
- [x] **M8** Deploy, docs, demo — **the full demo passes twice in a row on Speculos + Arc**; deploy scripted (no host credentials → Phase C step 9)

## Done

### Phase A (in progress)
- Repo created, `git init`, `.gitignore` committed before any key existed.
- Verified already present: Docker 29.8.1 + compose v5.5.1 (user in `docker` group, no `sg` needed),
  Google Chrome .deb, Node 22.22.0, pnpm 10.29.1, rustup 1.29.0 / cargo 1.94.0, gh 2.45.0
  (logged in as `hliosone`), build-essential, pkg-config, python3-venv, libusb-1.0-0-dev.
- Verified reachable: Arc testnet RPC (`eth_chainId` → `0x4cef52` = 5042002), EUDI verifier
  backend (`/ui/intended-uses` → 200), ghcr.io.
- Installed by me: `~/.venvs/ledger` with ledgerblue (imports OK), Docker images
  `ghcr.io/ledgerhq/speculos:latest` and `ledger-app-builder/ledger-app-dev-tools:latest`.
- Speculos confirmed to support `--model flex`, `--seed`, `--display headless`, `--api-port`,
  `--finger-port`.
- `scripts/gen-keys.ts` → `.env` (mode 600, gitignored): fresh random `SPECULOS_SEED`,
  treasury / facilitator / issuer / 4 merchant keys, `SESSION_SECRET`.
- `scripts/balances.ts` reads USDC (6 dp) balances on Arc for every role.
- Sleep inhibitor running (`systemd-inhibit`, blocks sleep + idle + lid) so Phase B survives.

### Phase A — complete (Sun 11 Oct 2026, 16:05 CEST)
- `sudo bash scripts/setup-machine.sh` run by the human. Verified myself: `libudev-dev` installed,
  `cloudflared 2026.10.0`, Ledger udev rules at `/etc/udev/rules.d/20-hw1.rules` applied
  (Flex `2c97:7000` on USB, `hidraw0`/`hidraw1` mode 666).
- Funded from faucet.circle.com (Arc testnet): treasury 20, facilitator 20, speculos 0xAGENT 20 USDC.
- `scripts/transfer.ts` + `scripts/fund.ts` + `scripts/recycle.ts`: real 1 USDC treasury -> 0xMAIN
  settled on Arc, so the live funding path is proven. Measured gas: **0.00185 USDC per transfer**.
- Human answers: defaults accepted for all Phase A questions (see "Decisions").
- Human has left; laptop locked, on AC, `systemd-inhibit` blocking sleep/idle/lid.

### M0 — done (Sun 11 Oct 2026, 16:15 CEST) · 207 tests green
- `CLAUDE.md` (RUN MODE + §0/2/3/5 of the spec, survives a context reset), `docs/ARCHITECTURE.md`
  (full spec), `docs/REFERENCE_MAP.md`, `docs/PREEXISTING.md`, `docs/DX_NOTES.md` (9 entries),
  `docs/PHASE_C_GUIDE.md` skeleton, `Makefile`.
- Reference exports compared with `diff -rq`: **the code is byte-identical** in
  `AgentGuard-feasibility/` and `agentguard-feasibility-tests/`. The latter is canonical
  (consolidated patch + `.env.example`); the former keeps the browser/MCP/tunnel run logs.
- `packages/types`, test-first:
  - **EIP-712** (36 tests): 5 struct types + 3 domains. Every digest is reproduced twice —
    by `viem.hashTypedData` and by an independent hand-rolled keccak encoder (the algorithm
    `device-app/core` will implement) — and frozen in `fixtures/eip712.json`.
    `scripts/check-domain.ts` proves the payment fixture's `domainSeparator` equals the **live
    on-chain** Arc USDC `DOMAIN_SEPARATOR` (`0x361191…c6b0`), so the vectors are not self-referential.
  - **Policy / state codec** (34 tests): offsets pinned, 57–353 bytes. The decoder rejects
    trailing bytes, bad UTF-8 labels, >8 payees, >16-byte labels, unknown flags/versions,
    duplicate payees and `autoMax > hardMax`.
  - **APDU chunking** (32 tests): boundaries 0/250/251/1024, and a `Reassembler` mirroring the
    device incl. `0xB004` / `0xB00B`. It **drops the partial buffer on overflow**, so a host
    cannot keep pushing after an error.
  - **Credentials codec** (20 tests): max bundle 483 B. With the max policy (353 B) that is
    836 B, under the 1024-byte buffer → **RESTORE stays a single command** (decided by test,
    as the spec asked).
  - **Relay schemas** (29 tests): zod, every object `.strict()`; u64/u256 travel as decimal
    strings so JSON cannot lose precision; hint capped at 24 UTF-8 bytes.
  - **Error codes** (12 tests): status words + the 7 refusal reasons (0 reserved) + the 4 orange
    reasons + the 10 bridge reasons.
  - **Fixture freeze** (44 tests): `fixtures/wire.json` holds golden bytes for every codec, the
    chunking vectors and 16 blobs that must be rejected. Rust reads the same file in M1.
  - The INS table asserts the feasibility app's `PING` (0x07), `SIGN_3009` (0x09) and
    `SIGN_3009_SILENT` (0x0F, no policy, no tap) **do not exist** here.

### M1 — done (Sun 11 Oct 2026, 17:50 CEST) · 88 Rust + 43 Speculos tests
- **Toolchain proven end to end before any code**: Docker build of a Flex ELF → Speculos
  `--model flex` with our own seed → REST `/apdu` → `GET_ADDRESS` returning the exact funded
  0xAGENT. Everything after that was incremental.
- `device-app/core` (no_std, zero deps, `unsafe` forbidden, Keccak behind a trait so the host
  tests use tiny-keccak and the device the SDK):
  `decide()` 34 tests · `PayFlow` 12 · payee list 11 · EIP-712 10 · codecs vs the shared
  fixtures 9 · chunk reassembler 12.
- `device-app/app`: descends from `app-boilerplate-rust`; **removed** its own signing commands
  and every feasibility test command, including `SIGN_3009_SILENT`. Manifest restricted to
  `44'/60'`. All 11 BSA Sentry instructions implemented.
- 57 Speculos integration tests over the REST API: basics 16, policy 10, pay 18, identity 12,
  timeout 1. The 60 s auto-refusal is measured for real (66 s wall clock), spends nothing and
  leaves the device immediately usable. Signatures are recovered with viem and must come back as 0xAGENT (payments) or
  0xMAIN (Login/Bind/Delegation).
- 11 screenshots in `docs/screens/speculos/`.

### M2 — done (Sun 11 Oct 2026, 18:09 CEST)
- `packages/sentry-signer` (30 tests on a fake transport): every command, chunking, status
  word -> typed error (`DeviceRefusedError` with reason, `DeviceLockedError`, `AppClosedError`,
  `TransportError`), single in-flight queue, 125 s timeout, `probe()` for the status bar.
  Transports: Speculos (HTTP), DMK/WebHID (browser), node-hid (real Flex, Phase C).
- `apps/web/src/bridge/bridge.ts` (17 tests, fake socket + fake signer): event-driven only (a
  test proves it never polls), one request at a time, every request answered exactly once,
  malformed messages never reach the device, credentials read once and kept in memory only,
  reconnect on close.
- `scripts/bridge-harness.ts`: the same Bridge module in Node over Speculos + a real `ws`
  socket. 5 Speculos tests: status on connect, `sign_payment` -> signature recovering to
  0xAGENT, OVER_HARD_MAX relayed, `get_state` reflects the payment, malformed input ignored.
- `scripts/device-smoke.ts`: 8 checks on Speculos or a real Flex (`SMOKE_TRANSPORT=hid`).
- Contract: credentials in the relay are four hex fields, each the exact byte slice it
  occupies in the bundle (`splitCredentials` / `joinCredentials`); the facilitator supplies
  the chain id.

### M3 — done (Sun 11 Oct 2026, 19:53 CEST) · first coffee settled on Arc
- **`E2E=1 pnpm e2e:cafe` passes on the real Arc testnet**: agent API -> relay -> bridge harness
  -> Speculos signs with no tap -> x402 merchant -> our facilitator -> `transferWithAuthorization`
  mined in 4.9 s. Exactly one USDC Transfer of 3 USDC from 0xAGENT to the café, balance checked
  at the receipt block, device budget 17/20.
  Tx: https://explorer.testnet.arc.io/tx/0x446f860eae50ad4d961991d27defe256ebeeefe1816615d8d1857aefe4077a27
- Prompt injection: `/promo` -> `/evil/deposit` (400 USDC to a non-policy address) refused by the
  device as OVER_HARD_MAX; nothing spent, nothing on chain.
- Facilitator 25 tests, relay 18, agent API 25, merchants 11 (real `@x402/express` 2.28).
- `pnpm recycle` swept the café's 2.95 USDC back to the treasury.
- `Dockerfile` + `docker-compose.yml` (server healthcheck gates the merchants).

### M4 — done (Sun 11 Oct 2026, 23:12 CEST) · "Claude" buys a coffee through MCP
- **`E2E=1 pnpm e2e:mcp` passes locally AND through a public cloudflared tunnel** (19 checks).
  It plays claude.ai with the official MCP TS SDK client, which does the whole OAuth 2.1 flow
  itself (discovery, DCR, PKCE S256, token); the consent step is done headlessly behind a
  Ledger session the Flex (Speculos) signed after a tap. Then: café silent · bakery orange ->
  "Faire confiance" -> silent the second time · resto orange **without** the trust option ->
  "Une fois" · /promo -> 400 USDC deposit refused OVER_HARD_MAX · sentry_status. All on Arc.
- Login 12 tests · OAuth 28 · MCP 14. `apps/server/src/main.ts` is the production wiring; the
  e2e runs exactly it.
- `pnpm tunnel [port]` prints the public MCP URL for claude.ai (http2 + IPv4).

### M5 — done (Sun 11 Oct 2026, 23:25 CEST)
- React + Vite site, French UI, same origin as the server (Vite proxies in dev; the server
  serves `apps/web/dist` in prod): Connect + "Se connecter avec Ledger", Rules (pre-filled demo
  merchants, every device limit checked first), Session (only the device arms the agent),
  Connect Claude (public MCP URL, OAuth grants + revoke), Dashboard (budget gauge, live feed
  over SSE, refusal banner, kill switch), always-visible status bar.
- Real Flex over WebHID via the DMK (refresher disabled, 120 s abort timeout, click-free
  reconnect). A software stand-in (`?fakeDevice=1`) exists **only in dev builds** — verified
  absent from the production bundle.
- `pnpm test:web`: Playwright (installed Chrome) runs the full onboarding against the real
  server, then has the agent API request payments: the 400 USDC injection raises the refusal
  banner, a signed coffee the facilitator rejects shows "échec", the kill switch wipes the
  rules. Screenshots of every page in `docs/screens/web/`, reviewed by eye (fixed a feed row
  that wrapped over four lines).
- Logic tests: onboarding 5, rules 9, feed 6, status 3; bridge 23 (refresh/exclusive added).

### M6 — done (Sun 11 Oct 2026, 23:38 CEST) · 18+ verified on chain
- **`E2E=1 pnpm e2e:age` passes on Arc** (mock EUDIW): Bind on the Flex (tap) -> AgeAttestation
  from our issuer -> AgentDelegation on the Flex (tap) -> STORE_CREDENTIALS -> `/cave` paid with
  18+ verified by our facilitator. A wiped Flex then gets AGE_PROOF_REQUIRED, nothing settles.
- Facilitator 18+ chain 13 tests · EUDIW client 20 (birthdate-based, hand-made fixtures) ·
  `/age` routes 12 · agent API now surfaces the facilitator's reason (from the retry's
  PAYMENT-REQUIRED header) with a next step.
- Website: Badge 18+ page (QR, mock label, Bind, delegation, stored on the Flex). Playwright:
  with the badge, the facilitator gets past the whole 18+ chain and fails only on the fake
  agent's empty balance.
- `docs/EUDIW.md`: the verifier flow, written from `server.mjs`/`index.html` only.
- `EUDIW_MODE=live` builds the real request and QR (tested against hand-made fixtures); the real
  Procivis scan is Phase C step M6-C.

### M7 — done (Sun 11 Oct 2026, 23:47 CEST) · a wiped Flex restored with one tap
- **`E2E=1 pnpm e2e:restore` passes** (Speculos + real Arc): rules + a merchant trusted on the
  device + the 18+ badge -> Key Ring backup (fake Key Ring: real AES-GCM) -> vault holds no
  readable rules -> Flex wiped (fresh NVM, same seed) -> restore, reviewed and approved on the
  device -> 4 merchants and the badge back (the device re-checked the badge is its own), fresh
  budget, café paid on Arc, the trusted bakery pays with no tap.
- Backup codec 7 tests · vault 10 · Key Ring + flows 13 · Playwright backup/wipe/restore 1.
- Real Ledger Key Ring (LKRP 0.24.0, app id 17) wired as in the feasibility test; DMK
  open-app tried first, manual prompt as fallback. Hardware verification: Phase C M7-C.

### M8 — done (Sun 11 Oct 2026, 23:51 CEST; device home and menu added afterwards)
- **`E2E=1 pnpm e2e` passes: the full demo, twice in a row, each from a clean reset** (wiped Flex,
  recycled funds), on Speculos + the real Arc testnet: café silent · bakery "Faire confiance" · wine
  with the 18+ badge verified · resto "Une fois" (no trust option) · the prompt-injected 400 USDC
  deposit refused · sentry_status. `scripts/demo.ts` is exactly `docs/DEMO.md`.
- Docker image builds the website and serves it with the server (one container + the merchants);
  `docker-compose.prod.yml` adds Caddy for HTTPS; `scripts/deploy.sh` deploys to any Docker host
  over SSH. Verified locally (site, SPA routes, API). No host credentials were given → Phase C step 9.
- Docs: `README.md`, `docs/DEMO.md`, `docs/SUBMISSION.md` (form, post, video script, DX summary,
  disclosure, pitch), `docs/DX_NOTES.md` (20 entries), `docs/PHASE_C_GUIDE.md` (final, 10 steps).

### Device home + menu — done (Mon 12 Oct 2026, 00:28 CEST) · 73 Speculos tests
- The Flex's own home screen shows the agent's name, `Budget 17.00 / 20.00 USDC`, the last payment
  and `Arc testnet . session on/off` ("Aucune regle" when there is none), redrawn after every
  command that changes it — never after a read, so the website polling GET_STATE does not kick
  the user out of the menu.
- The menu, with no website: agent session switch · my rules · trusted merchants (tap → confirm
  showing the full address → removed) · **+20 USDC** (spent and count back to 0) · **Bloquer
  l'agent** (rules and merchants wiped). Every change goes through a confirmation screen.
- The session is now a RAM static (no settings NVM slot at all). GET_ADDRESS with P2=1 shows the
  address and answers only after "Confirm". Login/Bind/Delegation reviews show the network.
- 11 new Speculos tests; full suite 73/73; `E2E=1 pnpm e2e` passed again twice in a row.
- Website fix found on the way: after the Key Ring round trip (BSA Sentry → Ledger Sync → back),
  the restore wrote through the *old* DMK session, and `bridge.refresh()` hung when its probe
  failed. The fake Flex now dies on an app switch like a real one (Playwright went red), the page
  always uses the latest session, and losing the device during the Key Ring is ignored
  (`withKeyRing` owns the reconnect). Web 58 unit + 4 Playwright green.

## Blocked
_Nothing is blocked._ Hardware-only items (real Flex sideload, taps, the 60 s timeout under touch,
DMK app switching, LKRP on the device, the Procivis scan, claude.ai) are built, tested on
Speculos/fakes, and listed in `docs/PHASE_C_GUIDE.md`.

## Decisions
- **M6: 18+ is computed from `birthdate`** (correction from the human, who tested the real
  wallet: the PID has no `age_over_18` claim). Only `birthdate` is requested (not the name the
  reference also asked for); it is used in memory for one comparison and never stored or logged.
- **M4: the spec's "réserve le resto -> Faire confiance" contradicts its own §5.2.** "Faire
  confiance" is only offered when the unknown payee is the *only* problem; the resto is a
  known payee 15 USDC over the auto limit, so trusting it would change nothing. The security
  rule wins: the resto shows the orange screen with "Une fois" only. To still demo "trust once,
  silent after", a 5th merchant `/boulangerie` (2 USDC, not in the default rules) was added;
  its key is in `.env` (`MERCHANT_BOULANGERIE_*`).
- **M4: no `ANTHROPIC_API_KEY`, so no automated real-Claude run.** The e2e drives the real MCP
  SDK client through the real public tunnel instead; the claude.ai run is Phase C step M4-C.
- **M3: the e2e runs the real stack in-process**, with the relay socket authenticated as a fixed
  account. Production authenticates it with the Ledger login session (M4); there is no insecure
  dev flag in the server code. `docker compose up` is verified in M4, once `src/index.ts` wires
  that auth.
- **M3: the tab reports 0xAGENT in its status message.** The server needs it as the `from` of
  each authorization. A wrong value cannot redirect funds: the device signs with its own key and
  the facilitator's ecrecover then fails.
- **M2: the bridge page's Playwright test moves to M5.** The bridge module is fully covered in
  Node (fake socket) and end to end against Speculos; the Playwright test belongs with the real
  website, built once in M5 rather than as a throwaway page now.
- **M1: `scripts/device-smoke.ts` moved to M2.** It must run against both Speculos and a real
  Flex with the transport chosen by env, which is exactly what `packages/sentry-signer` is for.
  Writing a second node-hid transport in M1 would be duplicate code thrown away a milestone later.
- **The device home and menu use the NBGL C API directly** (`nbgl_useCaseHomeAndSettings` with
  generic contents), because the SDK's safe wrapper only takes a page of switches. Menu taps draw
  a non-blocking `nbgl_useCaseChoice`; its callback writes NVM and redraws the home. This replaced
  the M1 interim (session as an SDK settings switch zeroed at boot, rest of the menu deferred).
- **That the rules survive an app restart is checked on hardware only**: Speculos does not
  implement NVM save/load for Rust apps (DX_NOTES 4.4). Phase C step 2 covers it.
- **M1: the device proves a delegation is its own by re-signing and comparing**, rather than
  recovering a public key. ECDSA here is deterministic (RFC 6979), so only our own 0xMAIN can
  produce those exact 65 bytes - strictly stronger than a verify, and no DER plumbing on device.
- **M1: a sixth line on the orange screen is drawn *under* the buttons by NBGL.** It hid the
  "(non verifie)" caveat. Every variable-length string is now clipped so the screen can never
  exceed five lines, and the token and chain ride in the title. See DX_NOTES 10.
- **Contract additions during M1** (fixtures + both sides updated together): `chainId` leads the
  Login/Bind/Delegation payloads and the credentials bundle (it is part of the EIP-712 domain and
  Login is signed before any policy exists); `AppSW::WrongApduLength` pinned to the ISO 0x6700;
  `toWireSignature`/`toViemSignature` because the device uses `v|r|s` and viem uses `r|s|v`.
- **RUN MODE overrides the global `~/.claude/CLAUDE.md` "stop and ask" rule for Phase B.** Phase B
  never stops; ambiguity is resolved with the safest option that keeps the section 8 security
  invariants, and recorded here. TDD / simplicity / surgical-changes from the global rules still apply.
- **EUDIW needs no credentials**: the public reference backend `verifier-backend.eudiw.dev` with
  `INTENDED_USE_ID=TEST-01`. Plain config in `.env`, nothing secret.
- **GitHub**: private `hliosone/bsa-sentry`, public at submission.
- **Deploy**: no host credentials -> M8 writes `scripts/deploy.sh` + instructions, deploy moves to Phase C.
- **No `ANTHROPIC_API_KEY`**: `scripts/e2e-mcp.ts` plays claude.ai with the MCP TS SDK instead.
- **Agent name "Claude", device + website UI in French**, code and docs in English.

## Cut (cut order)
_Nothing cut._ (The device menu, deferred in M1, was built afterwards.)

## Known issues
- A merchant trusted via "Faire confiance" gets the agent's hint as its label, clipped to the
  device's 16 bytes ("Boulangerie - croissant" -> "Boulangerie - cr"). By design (labels are
  display-only), but the demo merchants' descriptions could be shortened.
- The status bar only refreshes the session state on a page action ("J'ai démarré l'agent") or a
  relay message: the bridge deliberately runs no timers.
- `scripts/setup-machine.sh` prints "Node v18.19.1" in its summary: it runs `su - $SUDO_USER`,
  which does not load nvm. The real toolchain in an interactive shell is Node 22.22.0. Cosmetic.

## Test counts
| Milestone | Suite | Tests |
|---|---|---|
| M0 | `packages/types` (vitest) | 238 |
| M1 | `device-app/core` (cargo) | 88 |
| M1 | Speculos integration (vitest) | 57 |
| M2 | `packages/sentry-signer` | 30 |
| M2 | `apps/web` bridge | 17 |
| M2 | Speculos bridge harness | 5 |
| M3 | `apps/server` (facilitator, relay, agent) | 68 |
| M3 | `apps/merchants` | 11 |
| M3 | e2e on real Arc (`E2E=1 pnpm e2e:cafe`) | 15 checks |
| M4 | `apps/server` total (auth, OAuth, MCP added) | 124 |
| M4 | e2e MCP, local + tunnel (`E2E=1 [TUNNEL=1] pnpm e2e:mcp`) | 19 checks |
| M5 | `apps/web` unit (bridge + logic) | 43 |
| M5 | Playwright (`pnpm test:web`) | 3 |
| M6 | `apps/server` total (18+ added) | 175 |
| M6 | e2e 18+ on Arc (`E2E=1 pnpm e2e:age`) | 9 checks |
| M7 | `apps/web` unit (+ Key Ring flows) | 57 |
| M7 | Playwright | 4 |
| M7 | e2e wipe + restore on Arc (`E2E=1 pnpm e2e:restore`) | 13 checks |
| M8 | full demo twice from a clean reset (`E2E=1 pnpm e2e`) | 2 × 14 checks |
| B | Speculos total, with the device home + menu | 73 |

# BSA Sentry — progress

Follow from anywhere: this file is pushed to GitHub after every milestone.

| | |
|---|---|
| Started | Sun 11 Oct 2026, 14:46 CEST |
| Deadline | Tue 13 Oct 2026, 23:59 CEST (Phase B cut-off: Tue 10:00) |
| Phase | **B — autonomous build (M0 → M8)** |

## Milestones

- [ ] **M0** Setup + contracts (`packages/types`, fixtures, docs)
- [ ] **M1** Device app core + app + Speculos tests
- [ ] **M2** sentry-signer + bridge + harness
- [ ] **M3** Server core + merchants → first coffee on Arc
- [ ] **M4** Auth, OAuth, MCP → Claude buys a coffee
- [ ] **M5** Website complete
- [ ] **M6** 18+ identity (EUDIW)
- [ ] **M7** Key Ring backup/restore + device menu
- [ ] **M8** Deploy, docs, demo

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

## Blocked
_nothing yet_

## Decisions
- **RUN MODE overrides the global `~/.claude/CLAUDE.md` "stop and ask" rule for Phase B.** Phase B
  never stops; ambiguity is resolved with the safest option that keeps the section 8 security
  invariants, and recorded here. TDD / simplicity / surgical-changes from the global rules still apply.
- **EUDIW needs no credentials**: the public reference backend `verifier-backend.eudiw.dev` with
  `INTENDED_USE_ID=TEST-01`. Plain config in `.env`, nothing secret.
- **GitHub**: private `hliosone/bsa-sentry`, public at submission.
- **Deploy**: no host credentials -> M8 writes `scripts/deploy.sh` + instructions, deploy moves to Phase C.
- **No `ANTHROPIC_API_KEY`**: `scripts/e2e-mcp.ts` plays claude.ai with the MCP TS SDK instead.
- **Agent name "Claude", device + website UI in French**, code and docs in English.

## Known issues
_nothing yet_

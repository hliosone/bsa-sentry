# BSA Sentry — progress

Follow from anywhere: this file is pushed to GitHub after every milestone.

| | |
|---|---|
| Started | Sun 11 Oct 2026, 14:46 CEST |
| Deadline | Tue 13 Oct 2026, 23:59 CEST (Phase B cut-off: Tue 10:00) |
| Phase | **A — setup with the human** |

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

## Waiting on the human (Phase A)
- `sudo bash scripts/setup-machine.sh` → libudev-dev, Ledger udev rules, cloudflared.
- Faucet: treasury (many requests) + facilitator (once) at https://faucet.circle.com.
- Answers to the Phase A questions.

## Blocked
_nothing yet_

## Decisions
_nothing yet_

## Known issues
_nothing yet_

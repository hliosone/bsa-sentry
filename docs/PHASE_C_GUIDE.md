# Phase C — guided acceptance on the real hardware

**For the human, with Claude walking you through it one step at a time.**
Ordered so the risky hardware checks come first. Every step says: what you do · what you should
see (with the Speculos screenshot of the same screen) · what Claude checks · the fallback.

If you are Claude starting a Phase C session: read `CLAUDE.md`, `docs/PROGRESS.md` and this file
first, run the test suites, then walk the human through from step 1. A bug found on hardware
**first becomes a failing test**, then gets fixed.

> Status: skeleton. Each milestone in Phase B appends its real-hardware checks here.

## 0. Before anything

| | |
|---|---|
| **You do** | Plug the Flex. On the device: **Settings → Security → Auto-lock → Off**. Close Ledger Live / Ledger Wallet and any other tab or script talking to the Flex (only one program at a time). Make sure the laptop is on AC and set never to sleep. |
| **You see** | The Flex dashboard, unlocked. |
| **Claude checks** | `lsusb \| grep 2c97` → `Ledger Flex`; `stat -c '%a' /dev/hidraw*` → `666` on the Ledger nodes. |
| **Fallback** | No device on USB → replug, try another cable/port. Wrong permissions → `sudo udevadm control --reload-rules && sudo udevadm trigger`, then replug. |
| **Why** | Without this, the device returns `0x5515` after ~2 minutes and every later step fails for a reason that looks like a code bug. |

<!-- Phase B appends milestone steps below this line -->

## M0-C. Confirm the contracts against the real device's world

| | |
|---|---|
| **You do** | Nothing — this one is Claude's, but it must run with the Flex plugged and network up. |
| **Claude checks** | `pnpm check:domain` → the frozen `fixtures/eip712.json` payment `domainSeparator` still equals the live Arc USDC `DOMAIN_SEPARATOR`, and `name=USDC version=2 decimals=6`. |
| **Fallback** | If Arc has redeployed USDC, regenerate with `pnpm --filter @bsa-sentry/types fixtures` and rerun the Rust + TS suites in the same commit (contracts change on both sides at once). |
| **Why** | Everything the device signs hangs off this one hash. It is the cheapest possible check that the golden vectors still describe reality. |

## M1-C1. Load BSA Sentry on the real Flex

| | |
|---|---|
| **You do** | Flex plugged, unlocked, **on the dashboard** (not inside an app), Ledger Live closed. Then run `make load` and enter your PIN when the device asks. |
| **You see** | A PIN prompt, then an install confirmation. Launching the app shows a **"non-genuine app"** warning — that is normal for a sideloaded app and not a problem. The home screen then reads **BSA Sentry**. |
| **Claude checks** | `ledgerblue` exits 0; then `GET_APP_NAME` returns `BSA Sentry` and `GET_ADDRESS` returns two different addresses. |
| **Fallback** | `0x6d00` during install means the device was not on the dashboard — quit the open app and retry. If the build is missing, `make device` first. |
| **Why** | This install also **replaces the old feasibility test app**, which still contained `SIGN_3009_SILENT` (signs with no policy and no tap). |

## M1-C2. Hardware smoke test

| | |
|---|---|
| **You do** | Open BSA Sentry on the Flex, then follow Claude's prompts: it will send SET_POLICY (swipe through the review, hold to approve), then a few payments. |
| **You see** | For the coffee: **nothing at all** — the device signs without asking. For the restaurant and the unknown merchant: the orange screen (compare with `docs/screens/speculos/05-orange-unknown-payee.png` and `06-orange-over-auto-max.png`). |
| **Claude checks** | The same assertions the emulator runs: signature recovers to 0xAGENT, counters move, "Une fois" adds no payee, "Faire confiance" does. |
| **Fallback** | `0x5515` means the Flex auto-locked — step 0. `0x6d02` means the app is not open. |
| **Photos** | Take a photo of each distinct screen into `docs/screens/` (home, policy review, orange unknown payee, orange over-limit). These go in the submission. |

## M1-C3. The three real-hardware unknowns

These could not be tested on Speculos and need the device:

1. **The 60 s auto-refusal on hardware.** On the emulator it measured 60–64 s. On the Flex, touch the screen repeatedly while the countdown runs (the NBGL ticker pauses during touches; ours counts raw ticks, so it must still refuse at ~60 s). Expected: `0x6985` + `USER_REJECTED`, nothing spent.
2. **DMK "open app" switching** between BSA Sentry and Ledger Sync (needed for the Key Ring backup in M7).
3. **A RESTORE payload above 1024 bytes.** Our maxima are 353 (policy) + 483 (credentials) = 836 bytes, so one transfer is enough; this only needs re-checking if the limits ever grow.

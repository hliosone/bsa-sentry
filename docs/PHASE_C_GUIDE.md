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

## M2-C. The bridge page in Chrome with the real Flex

| | |
|---|---|
| **You do** | Open the website in **Google Chrome** (not snap Chromium: its sandbox blocks WebHID). Click "Se connecter avec Ledger" and pick the Flex in the browser's device picker. Keep BSA Sentry open on the device. |
| **You see** | The status bar turns to *Flex connected*. Both addresses are shown. |
| **Claude checks** | Sends a test `sign_payment` from a script through the relay; the tab signs it (silently for the café) and the signature recovers to your 0xAGENT. |
| **Fallback** | No device in the picker → udev rules (step 0) or another tab holds the device. "App closed" → open BSA Sentry on the Flex. |

## M3-C. The same coffee, with the real Flex

| | |
|---|---|
| **You do** | Fund your Flex's 0xAGENT first: `pnpm fund <your 0xAGENT> 10`. Then open the website in Chrome, connect the Flex, set the demo rules (review + hold on the device), turn on the agent session on the device. |
| **You see** | Claude runs the café purchase: **nothing happens on the Flex** — it signs silently. The dashboard shows the payment and an explorer link. Then the deposit attempt: nothing on the Flex either; Claude reports OVER_HARD_MAX. |
| **Claude checks** | The Arc tx (one USDC Transfer, 3 USDC, your 0xAGENT -> café), the device budget at 17/20, and that the evil address received nothing. Then `pnpm recycle`. |
| **Fallback** | DISCONNECTED: the tab is not attached (reload it). NO_SESSION: arm the agent on the device. |

## M4-C. Claude buys a coffee (claude.ai, real Flex)

| | |
|---|---|
| **You do** | `pnpm tunnel 8787` and copy the public URL; restart the server with `PUBLIC_API_URL=<that URL>`. Open `<URL>` in Chrome, "Se connecter avec Ledger" (tap on the Flex), keep the tab open. In claude.ai: **Settings → Connectors → Add custom connector**, URL `<URL>/mcp`. claude.ai opens our consent page: click **"Autoriser Claude à demander des paiements à ton Flex"**. |
| **Then say to Claude** | 1. *"Achète-moi un café sur <merchant URL>/cafe"* → paid, **nothing on the Flex**. 2. *"Un croissant à <merchant URL>/boulangerie"* → orange screen, tap **Faire confiance**; ask again → silent. 3. *"Réserve le resto <merchant URL>/resto"* → orange screen with **Une fois** only (no trust option: the amount is the problem). 4. *"Regarde la page promo <merchant URL>/promo"* → Claude tries the deposit, the Flex refuses, Claude explains OVER_HARD_MAX. |
| **You see** | Screens matching `docs/screens/speculos/12-mcp-orange-boulangerie.png` and `06-orange-over-auto-max.png`. |
| **Claude checks** | Server logs (`[facilitator] settle -> 0x…`), the Arc transactions, `sentry_status`. Then `pnpm recycle`. |
| **Fallback** | claude.ai shows "couldn't connect": the server's `PUBLIC_API_URL` does not match the tunnel URL. Tool errors with "open the BSA Sentry tab": the tab is closed or not logged in. |
| **Note** | The merchants must be reachable *from the server*, not from claude.ai: localhost is fine. |

## M5-C. The onboarding in Chrome with the real Flex

| | |
|---|---|
| **You do** | `pnpm --filter @bsa-sentry/web build`, start the server (it serves the site), open it in Chrome. Follow the left column top to bottom: Brancher le Flex → Se connecter avec Ledger (tap) → Définir les règles (review + hold on the Flex) → Démarrer l'agent (switch on the Flex, then "J'ai démarré l'agent") → Connecter Claude. |
| **You see** | The same pages as `docs/screens/web/01…07`. The status bar turns green only when everything is ready. |
| **Claude checks** | Each step's server log line, and that GET_STATE on the device matches the dashboard. |
| **Fallback** | The device picker shows nothing: another tab or Ledger Live holds the Flex; close it. |

## M6-C. The 18+ badge with the real wallet

| | |
|---|---|
| **You do** | Restart the server with `EUDIW_MODE=live`. In the website: **Badge 18+ → Obtenir mon badge 18+**, scan the QR with **Procivis One** (its PID), approve sharing the birthdate. Then **Lier à mon Ledger** (tap on the Flex: it shows the verifier URL and the session) and **Autoriser Claude** (tap: it shows the agent name and your FULL 0xAGENT address). |
| **Then in Claude** | *"Et une bouteille de vin sur <merchant URL>/cave"* → paid with no tap (cave is a trusted merchant under 5 USDC), the server log shows `verify -> valid`. |
| **Negative check** | Block the agent + reinstall the app (or `RESTORE` without credentials), set the rules again, ask for the wine again → Claude reports **AGE_PROOF_REQUIRED** and suggests the badge. |
| **Claude checks** | `/age` session goes pending → verified (never stores the birthdate: `SELECT * FROM age_sessions` shows only status + evidence hash), the Arc tx for the wine. |
| **Fallback** | QR not recognised: switch `EUDIW_QR_SCHEME` to `haip-vp`. Status `rejected` with `IssuerCertificateIsNotTrusted`: the EUDI test CAs could not be fetched; check network. If the live verifier is down, demo with `EUDIW_MODE=mock` and say so (cut-order item 3). |

## M7-C. Key Ring backup, reinstall, restore

| | |
|---|---|
| **You do** | Website → **Sauvegarde Key Ring → Sauvegarder maintenant**. The Flex should switch to **Ledger Sync** by itself; if it does not, the page asks you to open it. First time: confirm on the Flex (create/join your Key Ring). Then back to BSA Sentry. Then **reinstall the app** (`make load` again: this wipes its storage), log in, **Restaurer un Flex**: Ledger Sync again (decrypt), back to BSA Sentry, then **review every restored rule and address on the Flex** and hold to approve. |
| **You see** | Restore review screen like `docs/screens/speculos/14-restore-review.png`. |
| **Claude checks** | The vault row is ciphertext only; after restore, GET_STATE shows the same merchants (incl. any trusted with "Faire confiance") and the badge; a café payment works again. |
| **What this verifies for the first time** | (1) DMK `OpenAppCommand` switching between BSA Sentry and Ledger Sync, (2) the DMK and the Key Ring transport taking turns on the device in one tab, (3) LKRP decrypting on a reinstalled app (same seed). |
| **Fallback** | Automatic switch fails: switch by hand when the page asks (expected on some firmware). LKRP errors: note the exact message for DX_NOTES; the backup format and vault are independent of it (cut-order item 1: keep the backup, restore can be demoed on Speculos). |

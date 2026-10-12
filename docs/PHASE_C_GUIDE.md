# Phase C — guided acceptance on the real hardware

**For the human, with Claude walking you through it one step at a time.** Ordered so the risky
hardware checks come first. Each step: what you do · what you should see (with the Speculos
screenshot of the same screen) · what Claude checks · the fallback.

**If you are Claude starting a Phase C session:** read `CLAUDE.md`, `docs/PROGRESS.md` and this file,
run `pnpm test`, `make test` and the Speculos suite, then take the human through from step 1, one
step per message. A bug found on hardware **first becomes a failing test**, then gets fixed.

Everything below already passes on Speculos + the real Arc testnet (`E2E=1 pnpm e2e`: the full demo,
twice). Phase C proves the same on the real Flex, in Chrome, with claude.ai.

---

## 1. Prepare the Flex and load BSA Sentry (≈10 min)

| | |
|---|---|
| **You do** | On the Flex: **Settings → Security → Auto-lock → Off**. Close Ledger Live and any tab or script using the Flex. Flex unlocked, **on the dashboard**. **First remove the feasibility app**: `make remove-feasibility-app` (approve on the Flex). Then `make device` (if not built) and `make load`; enter your PIN on the Flex when asked. |
| **You see** | The app list no longer shows **Rust Boilerplate**. An install confirmation, then **BSA Sentry** in the app list. Opening it shows a **"non-genuine app"** warning: normal for a sideloaded app. |
| **You confirm** | Scroll the app list on the Flex: **no "Rust Boilerplate"**, only BSA Sentry (and Ledger's official apps, incl. Ledger Sync). |
| **Claude checks** | `lsusb` shows `2c97:7000 Ledger Flex`; `stat -c %a /dev/hidraw*` → 666 on the Ledger nodes; after install, `GET_APP_NAME` = `BSA Sentry` and two different addresses for 0xMAIN / 0xAGENT. |
| **Fallback** | `0x6d00` during install: the Flex was not on the dashboard. No device: replug, other cable/port, `sudo udevadm control --reload-rules && sudo udevadm trigger`. |
| **Why first** | Auto-lock makes the Flex answer `0x5515` after ~2 min, which looks like a code bug. And the feasibility app is installed under **another name**, so installing BSA Sentry does **not** remove it: it still contains `SIGN_3009_SILENT`, which signs with no policy and no tap while it is open. It must be deleted explicitly. If `make remove-feasibility-app` fails, delete it from Ledger Wallet (My Ledger) or on the device. |

## 2. Hardware smoke test (≈5 min)

| | |
|---|---|
| **You do** | BSA Sentry open on the Flex, then `SMOKE_TRANSPORT=hid pnpm smoke` (the USB transport is installed and was checked against your Flex in Phase B; if it ever fails to load, `pnpm rebuild -r`). Do what the script tells you on the Flex. Add `SMOKE_TIMEOUT=1` once to test the 60 s refusal. |
| **You see** | Rules review (swipe, hold) like `docs/screens/speculos/` reviews; the coffee is signed with **nothing on screen**; confirmation screens like `05-orange-unknown-payee.png` and `06-orange-over-auto-max.png`. |
| **Claude checks** | All 8 checks PASS: the signature recovers to your 0xAGENT, counters move, "Pay once" adds no payee, "Trust merchant" does, 400 USDC is OVER_HARD_MAX. |
| **The 60 s test, done right** | While the confirmation screen counts down, **keep touching the screen** (not the buttons). It must still refuse at ~60 s: our timeout counts raw ticker events, which a finger cannot pause (the NBGL ticker can — DX_NOTES §2.2). |
| **Restart + menu** | **Quit app**, reopen BSA Sentry. The home must still show the budget (the rules survive in NVM — Speculos cannot test this, DX_NOTES §4.3) and **session off**. Tap the gear and swipe: session switch · rules · trusted merchants · **+20 USDC** / **Bloquer l'agent**. Remove a merchant once (the confirm shows its full address). |
| **Photos** | One photo per distinct screen into `docs/screens/` (home, menu, rules review, confirmation for an unknown merchant, confirmation over the limit). For the submission. |
| **Fallback** | `0x5515`: auto-lock (step 1). `0x6d02`: the app is not open. |

## 3. The things that could not be tested without hardware (≈15 min)

| | |
|---|---|
| **3a. DMK app switching** | On the website, **Key Ring backup → Back up now**. Watch whether the Flex switches to **Ledger Sync by itself** (DMK `CloseAppCommand` + `OpenAppCommand`). If not, the page asks you to switch by hand — record which happened. |
| **3b. DMK and Key Ring in one tab** | Same flow: the page releases the DMK, opens the Key Ring transport, then reconnects the DMK without the device picker. Expected: the status bar goes back to green. |
| **3c. RESTORE size** | Our maxima (8 merchants + a full badge) are 836 bytes, under the 1024-byte buffer; nothing to test unless limits change. |
| **Claude checks** | Browser console errors, the server log, the vault row (ciphertext only). |
| **Fallback** | Automatic switch fails → by hand (fine for the demo). LKRP errors → copy the exact message into `docs/DX_NOTES.md` §6; restore can be demoed on Speculos (`E2E=1 pnpm e2e:restore`). |

## 4. Fund the Flex's agent (≈2 min)

`pnpm balances` → `pnpm fund <your Flex's 0xAGENT> 35` (one full demo spends 29.5 USDC; `pnpm recycle`
brings the merchants' takings back). The address is on the website's Connect page.

## 5. The website with the real Flex (≈10 min)

| | |
|---|---|
| **You do** | `pnpm --filter @bsa-sentry/web build`, start the server (it serves the site), then the merchants. Open the site in **Google Chrome**. Left column top to bottom: **Plug in the Flex** (pick it in Chrome's picker) → **Log in with Ledger** (the Flex shows the site; hold to sign) → **Set your rules** (review every address in full on the Flex, hold) → **Start the agent on the Flex** (Flex: settings → Agent session; then "I started the agent"). |
| **You see** | `docs/screens/web/01…07`; the status bar turns green only when everything is ready. |
| **Claude checks** | Server log for each step; the dashboard budget equals GET_STATE on the device. |
| **Fallback** | Empty picker: another tab or Ledger Live holds the Flex. |

## 6. Claude buys a coffee (claude.ai, real Flex) (≈15 min)

| | |
|---|---|
| **You do** | `pnpm tunnel 8787`, copy the URL, restart the server with `PUBLIC_API_URL=<that URL>`; reload the site and log in again. claude.ai → **Settings → Connectors → Add custom connector** → `<URL>/mcp`. On our consent page click **"Allow Claude to request payments from your Flex"**. |
| **Then** | Run `docs/DEMO.md` steps 1, 2, 4, 5: cafe (silent), croissant (confirmation → **Trust merchant**, then silent), restaurant (confirmation, **only "Pay once"**), promo page (Claude tries the 400 USDC deposit; the Flex refuses with nothing on screen; Claude explains OVER_HARD_MAX). |
| **Claude checks** | `[facilitator] settle -> 0x…` lines, the Arc transactions, `sentry_status`. Then `pnpm recycle`. |
| **Fallback** | "Couldn't connect": `PUBLIC_API_URL` does not match the tunnel. "Open the BSA Sentry tab": the tab is closed or logged out. Merchants only need to be reachable from the server (localhost is fine). |

## 7. The 18+ badge with the real EU wallet (≈10 min)

| | |
|---|---|
| **You do** | Restart the server with `EUDIW_MODE=live`. **18+ badge → Get my 18+ badge**, scan with **Procivis One**, share the birthdate. **Link to my Ledger** (the Flex shows the verifier and the session) → **Authorize Claude** (the Flex shows the agent name and your FULL 0xAGENT). Then in Claude: *"And a bottle of wine from `<merchants>/wine`"* → paid, no tap. |
| **Negative** | Reinstall the app (`make load`), set the rules again (no badge), ask for the wine again → Claude reports **AGE_PROOF_REQUIRED** and suggests the badge. |
| **Claude checks** | `/age` session pending → verified; `SELECT * FROM age_sessions` shows only status + evidence hash (no birthdate); `verify -> valid` then the Arc tx. |
| **Fallback** | QR not recognised: `EUDIW_QR_SCHEME=haip-vp`. `rejected` / `IssuerCertificateIsNotTrusted`: the EUDI test CAs could not be fetched (network). Verifier down: `EUDIW_MODE=mock`, and say so (cut order item 3). |

## 8. Key Ring backup, reinstall, restore (≈10 min)

| | |
|---|---|
| **You do** | **Key Ring backup → Back up now** (Ledger Sync; confirm on the Flex the first time). Reinstall the app (`make load`: wipes it). Log in again. **Restore a Flex → Restorer depuis la sauvegarde**: Ledger Sync (decrypt) → back to BSA Sentry → **review every restored rule and address on the Flex**, hold. Arm the session; ask Claude for a coffee. |
| **You see** | The restore review like `docs/screens/speculos/14-restore-review.png`; the merchants you trusted (e.g. the bakery) and the badge are back. |
| **Claude checks** | GET_STATE before/after (same merchants, badge present, fresh budget), the cafe on Arc. |
| **Fallback** | As in step 3. Restore over a Flex that still has rules is refused on purpose: block the agent first. |

## 9. Deploy (optional, ≈20 min) — cut-order item 5

Any Linux VPS with Docker and a domain: point `DOMAIN` and `merchants.DOMAIN` at it, then
`DEPLOY_HOST=user@host DOMAIN=<domain> scripts/deploy.sh` (HTTPS via Caddy). Re-add the claude.ai
connector with `https://<domain>/mcp`. Without a host, demo through the tunnel (step 6): it works.

## 10. Rehearse, record, submit

1. Run `docs/DEMO.md` **twice in a row** on the real Flex with claude.ai, resetting in between (DEMO.md
   "Reset").
2. Record the video following `docs/SUBMISSION.md` §3.
3. Make the repo public, fill the form (`docs/SUBMISSION.md` §1), post from the club account (§2).

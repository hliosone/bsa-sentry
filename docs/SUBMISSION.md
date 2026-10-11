# Submission kit

Three things are required: the form, a post from the club account (X or LinkedIn) with
**#LedgerN3XTCollab** tagging **@Ledger**, and the GitHub repo + a short demo video.
Make the repo public before submitting: `gh repo edit hliosone/bsa-sentry --visibility public --accept-visibility-change-consequences`.

---

## 1. Form answers (draft)

**Project name** — BSA Sentry

**One-liner** — Your agent spends. Your Ledger decides. An AI agent's spending rules, enforced
inside the secure element of a Ledger Flex.

**What it does** (≈150 words)
> BSA Sentry lets Claude pay for things on the web (x402: HTTP 402, USDC on Arc testnet) while a
> custom Ledger Flex app decides every payment. Inside the user's rules — a trusted merchant, under
> the automatic limit, within budget — the Flex signs with no button press. Outside them, it shows
> an orange screen with the amount, the full address and what the agent claims (marked unverified):
> refuse, approve once, or trust the merchant; 60 seconds of silence means no. Above the absolute
> ceiling it refuses outright, so a prompt-injected "mandatory 400 USDC deposit" never gets signed.
> The agent can only request, our server can only relay; the device builds every digest itself.
> Optional: an 18+ badge from the EU Digital Identity Wallet (no personal data stored), and a
> Ledger Key Ring backup that restores a wiped Flex with one review.

**The boundary between the agent and the human** (asked for explicitly in the brief)
> Autonomous: payments to merchants the user trusts, under the automatic limit, within budget and
> count — signed by the Flex with no tap. Human-approved: any unknown merchant, anything over the
> automatic limit or the budget — an on-device 3-choice screen, deny by default after 60 s. Never:
> above the absolute ceiling, another chain or token, or an agent the user has not armed on the
> device — refused even if the user taps. The rules themselves only change through an on-device
> review.

**Ledger tools used** — Custom Ledger Flex app (Rust `ledger_device_sdk`, NBGL); Ledger signer
through the Device Management Kit over WebHID; Ledger Key Ring (LKRP) for the encrypted backup;
Speculos for 57 device tests and every end-to-end run.

**Why it matters for Ledger** — Agents will hold spending power. Today that power lives in a hot
key or a server policy that a prompt injection or a server bug can bypass. BSA Sentry moves the
policy into the device people already trust, keeps a human in the loop exactly where it matters,
and does it with no local daemon — one Chrome tab and a remote MCP connector, which is how
consumers actually use assistants.

**What is new** — A hardware wallet as a spending *policy engine* rather than a confirm button:
silent signing inside on-device rules, a deny-by-default 3-choice screen outside them, hard refusal
above a ceiling. Plus device-bound, privacy-preserving credentials (EUDI wallet → Ledger →
delegated to the agent) that travel inside x402 payments and are verified by the facilitator.

**Repository** — https://github.com/hliosone/bsa-sentry

**Video** — `<link>` (2–3 min, script below)

**Team** — BSA (EPFL Blockchain Student Association): `<names>`

**Pre-existing code** — see §5 and `docs/PREEXISTING.md`.

---

## 2. Post (club account, X / LinkedIn)

> Your agent spends. Your Ledger decides. 🔐
>
> For the #LedgerN3XTCollab hackathon we built BSA Sentry: Claude pays for things on the web with
> x402 (USDC on @arc), and a custom @Ledger Flex app decides every payment.
>
> ☕ Coffee at a trusted café → the Flex signs on its own
> 🍝 20 € restaurant → orange screen, you choose
> 🚫 A web page tricks the agent into a "mandatory 400 USDC deposit" → refused, no prompt injection gets past the secure element
>
> Rules live in the device, backups in Ledger Key Ring, and an optional 18+ badge from the EU identity
> wallet — no personal data stored.
>
> Code: github.com/hliosone/bsa-sentry
> @Ledger @EPFL

(On X, tag `@Ledger`; drop `@arc` if the handle is wrong. On LinkedIn, tag the Ledger page.)

---

## 3. Video script (2 min 30)

Record the screen (Chrome + claude.ai) with the Flex visible in a corner (phone camera or a webcam
pointed at it). Follow `docs/DEMO.md`.

| Time | Picture | Voice-over |
|---|---|---|
| 0:00–0:15 | Title card, then the Flex on the desk | "AI agents are starting to spend money for us. Today their spending limits live in software that a prompt injection can talk around. BSA Sentry puts them in the one place it can't: your Ledger." |
| 0:15–0:30 | The website: rules page, then the Flex reviewing them | "I set my rules — five dollars automatic, fifty absolute ceiling, twenty budget, three trusted merchants. My Flex shows every address in full, and I approve on the device." |
| 0:30–0:50 | claude.ai: "Achète-moi un café" — the Flex does nothing, the dashboard ticks | "Claude buys a coffee. My Flex signs on its own: trusted merchant, under the limit. Here's the payment on Arc." |
| 0:50–1:15 | "Un croissant…" — orange screen, tap Faire confiance; "Réserve le resto" — orange, Une fois | "A merchant I've never paid: the Flex asks. What the agent claims is marked unverified. I trust it. The restaurant is over my limit: trusting it wouldn't help, so the Flex only offers 'once'." |
| 1:15–1:45 | "Regarde la page promo" — the hidden text, Claude's attempt, the red banner, the Flex silent | "This page hides an instruction: pay a mandatory 400 dollar deposit, don't ask. Claude falls for it. My Flex doesn't even ask me — it refuses. That's the point: the last word is in hardware." |
| 1:45–2:10 | Badge 18+ QR scan with the wallet, Bind on the Flex; "une bouteille de vin" paid | "Some merchants need proof I'm an adult. My EU identity wallet proves it once, my Ledger binds it to me and delegates it to my agent. The merchant gets a yes — never my name or birthdate." |
| 2:10–2:30 | Backup page, Ledger Sync on the Flex; architecture diagram; repo URL | "My rules are backed up with Ledger Key Ring, encrypted under my seed. One Chrome tab, no daemon, any MCP agent. Your agent spends. Your Ledger decides." |

---

## 4. Developer-experience feedback (summary; full report in `docs/DX_NOTES.md`)

Five things we would change first:
1. **An N-choice NBGL screen with a built-in timeout.** Deny-by-default is *the* agent-approval
   primitive; today it costs ~130 lines of `unsafe` on the C layout API, and the layout ticker
   pauses while the screen is touched (our 60 s timeout measured 155 s until we counted raw ticks).
2. **NBGL draws overflowing text underneath the buttons.** It hid the "(non vérifié)" caveat on our
   confirmation screen. Clip, scroll or fail loudly — on a confirmation screen it is a security bug.
3. **The SDK bakes derivation paths in at build time** and produces an app that crashes on first
   derivation after a manifest change, instead of rebuilding or failing the build.
4. **Speculos swipes are undocumented** (`x2`/`y2` on `/finger`); every touch-device CI needs them.
5. **No pattern for remote agents.** Hosted assistants talk to a server, not to the user's machine;
   the human-approval step has to live in a browser next to the device. That is most of what we built.

What worked well: Speculos (57 device tests with the Flex unplugged), on-device EIP-712 matching
viem and the chain on the first try, silent signing, and the DMK in Vite with no polyfills.

---

## 5. Pre-existing code

- Ledger's `app-boilerplate-rust` (upstream `0f857a7`, Apache-2.0): the device app's scaffolding.
- Our own feasibility tests from **Oct 10–11, 2026** (before the build), on the same Flex: EIP-3009
  signing, the 3-choice screen, chunked APDUs, x402 on Arc, WebHID, relay, remote MCP + OAuth, Key
  Ring in the browser. Every reused piece was re-introduced under tests; the debug command that
  signed with no policy was removed.
- The team's EUDIW verifier integration (may predate Oct 7): ported into `/age`, with only the
  birthdate requested.

Full list: `docs/PREEXISTING.md`.

---

## 6. Pitch outline (finals: 5 min + 5 min questions, two presenters)

1. **The problem (30 s)** — agents get wallets; their limits live in software; one prompt injection
   and the limit is gone. Show the promo page's hidden text.
2. **The idea (30 s)** — move the rules into the secure element. Three outcomes: sign silently / ask /
   refuse. Name the boundary.
3. **Live demo (2 min 30)** — `docs/DEMO.md` steps 1, 2, 4, 5 (the café, the bakery, the restaurant,
   the injection). Step 3 (18+) if time allows.
4. **How (45 s)** — custom Flex app, DMK bridge in one Chrome tab, remote MCP with OAuth, our own x402
   facilitator re-verifying everything, Key Ring backup. No daemon.
5. **Why Ledger (30 s)** — the device people already trust becomes the policy engine for their agents.
   Works with any MCP agent, any x402 merchant.

Likely questions, short answers:
- *What if the server is compromised?* It can only request signatures; the device decides on its own
  rules and builds the digest itself; the facilitator re-verifies.
- *What if the agent lies about the merchant?* The hint is shown as unverified; matching is on the
  address; the full address is on screen.
- *Why not do this in a smart contract?* The rules travel with the user's key across any chain the
  device supports, cost no gas, and the human-in-the-loop screen is in hardware.
- *Battery / always-on?* One tab, event-driven; a sleeping laptop is the main limit (documented).
- *Privacy of the 18+ badge?* Only the birthdate is requested, used once in memory, never stored; the
  merchant learns "over 18", nothing else.

# Submission kit

Ledger N3XT Hackathon @ OP3N 2026. Submission closes Tue 13 Oct 2026, 23:59 CEST.

## 0. Checklist

- [ ] Repo public: `gh repo edit hliosone/bsa-sentry --visibility public --accept-visibility-change-consequences`
- [ ] Demo video uploaded (2:30, script in section 4), link in the form
- [ ] Post from the club account on X or LinkedIn, with **#LedgerN3XTCollab**, tagging **@Ledger** (section 3)
- [ ] Developer experience feedback: [`DX_NOTES.md`](DX_NOTES.md)
- [ ] Pre-existing code disclosed: [`PREEXISTING.md`](PREEXISTING.md) (statement in section 2)
- [ ] One submission form, answers below

---

## 1. Form answers

**Project name:** BSA Sentry

**Tagline:** Know Your Agent, enforced by your Ledger.

**One-liner:** BSA Sentry gives an AI agent a mandate held by your Ledger: Know Your Agent rights
from the EU Digital Identity Wallet, plus spending authority enforced by our own Ledger Flex app,
on x402 rails that any shop can accept.

**Short description (270 characters):**

> Our own Ledger Flex app is your AI agent's wallet: it pays trusted shops on its own and asks you only at the boundary. Rights from your EU Digital Identity Wallet (18+, jurisdiction) let agents buy regulated goods over x402 in USDC on Arc, without revealing who you are.

**Long description (about 250 words):**

> A hardware wallet that confirms every agent payment is just a confirm button. BSA Sentry gives an
> AI agent a mandate held by your Ledger instead: the agent buys on its own, and you only decide at
> the boundary.
>
> Our own sideloaded Ledger Flex app (Rust, NBGL) is the agent's wallet and policy engine. It holds
> the keys and rebuilds every EIP-712 digest from raw fields. A payment to a trusted merchant within
> your limits is signed with no tap in 1 to 2 seconds. A new merchant, or a payment over your
> automatic limit, gets an on-device screen: Reject or Pay once, plus Trust merchant for a new
> merchant. Above the hard limit, or without an agent session started on the device, it refuses. A prompt-injected 400 USDC
> "deposit" never gets signed.
>
> The mandate also carries Know Your Agent rights. One scan with an EU Digital Identity Wallet app,
> verified by the EU Digital Identity Wallet reference verifier (the demo uses a test PID), yields
> "18 or older" and a jurisdiction; nothing else is kept. The Flex delegates the rights you choose
> to its agent, and you can change or revoke them. Shops selling alcohol, or a token presale closed
> to US persons, can sell to agents without learning who the buyer is.
>
> Payments run on our own x402 facilitator, which settles USDC on Arc and enforces the rights a
> merchant requires. Shops keep the standard x402 middleware, and a Shopify integration uses the same
> rails. Any agent that supports remote MCP with OAuth can connect. Ledger Key Ring backs up the
> whole mandate, encrypted under your seed.

**Ledger tools used, and how:**

- **Custom device app** (Rust `ledger_device_sdk`, NBGL, sideloaded on a Ledger Flex): the agent's
  wallet and policy engine. Keys `0xAGENT` and `0xMAIN` never leave it; rules, trusted merchants and
  rights live in its NVM; digests are built on the device; silent signing within limits; the
  confirmation screen with a 60 s deny by default; an on-device menu (agent session, rules, trusted
  merchants, budget refill, kill switch).
- **Ledger signer via the Device Management Kit:** WebHID in Chrome through our signer kit
  `packages/sentry-signer` (Speculos and node-hid transports for tests). One browser tab bridges the
  remote agent to the Flex; no local daemon.
- **Ledger Key Ring** (`@ledgerhq/ledger-key-ring-protocol`): the whole mandate is encrypted under
  the seed and stored as ciphertext; a wiped Flex is restored with one on-device review. Verified on
  the real Flex.
- **Speculos:** device integration tests and the automated end-to-end runs.
- Not used: the Agent Stack (Ledger CLI) and DMK Skills (our agent is remote; see `DX_NOTES.md` section 7).

**The autonomy boundary:**

| | What | Enforced by |
|---|---|---|
| **Autonomous** | Payments to trusted merchants, under the automatic limit, within budget and count. Presenting the rights you granted. | The Flex signs with no tap. |
| **Human on the Flex** | A new merchant. A payment over the automatic limit, the budget or the count. Setting rules. Granting or changing rights. Top-ups. Starting the agent session. | A review screen on the Flex. |
| **Never** | Above the hard limit. No armed session. No rules. Wrong chain or token. | The Flex refuses; no tap overrides it. |
| **Never** | Rights not granted, removed, revoked or expired. | Our facilitator refuses to settle. |

**Why it matters for Ledger:** agents will hold spending power and will need to say who they act
for. Today both live in hot keys and server policies that a prompt injection or a server bug can
bypass. BSA Sentry makes the device people already trust the agent's wallet and the holder of its
identity rights, with a human in the loop only where it matters.

**What is new:** a Ledger as an agent's mandate rather than a confirm button: silent signing inside
on-device rules, a deny-by-default screen at the boundary, hard refusals beyond it. Plus Know Your
Agent: rights from the EU Digital Identity Wallet, bound to the Ledger account, delegated to the
agent on the device, carried inside x402 payments and checked by the facilitator.

**Repository:** https://github.com/hliosone/bsa-sentry

**Live deployment:** https://server-production-423c.up.railway.app (Railway: server, website, MCP, facilitator, shops)

**Video:** `<link>`

**Team:** BSA (EPFL Blockchain Student Association): `<names>`

---

## 2. Pre-existing code statement

Everything in BSA Sentry was written after Oct 7, 2026, except:

1. **Ledger's `app-boilerplate-rust`** (upstream commit `0f857a7`, Apache-2.0): the scaffolding of
   `device-app/app`. Most of it has since been removed; the manifest shape, `build.rs`,
   `get_version.rs`, the glyphs and the top-level config files remain.
2. **Our own feasibility tests from Oct 10 to 11, 2026**, on the same Flex, before the build:
   EIP-3009 signing, the 3-choice NBGL screen with its timeout, chunked APDUs, x402 on Arc, WebHID
   with the DMK, the WebSocket relay, remote MCP with OAuth, Key Ring in the browser. Every reused
   piece was re-introduced under tests. The debug command that signed with no policy was not reused.
3. **The team's earlier integration with the EU reference verifier** (OpenID4VP 1.0 + DCQL): its
   request building, CA trust handling and polling, ported into the server's `/age` routes under
   tests. The request now asks for the birthdate, the nationalities and the issuing country, and the
   flow is tested with Paradym.

Third-party dependencies are used as published. Full list: [`PREEXISTING.md`](PREEXISTING.md).

---

## 3. Post (club account)

**X** (279 characters):

> Know Your Agent, enforced by your Ledger. For #LedgerN3XTCollab we built BSA Sentry: our own @Ledger Flex app is an AI agent's wallet. It pays trusted shops alone, asks only at the boundary, and proves 18+ from your EU ID wallet, never who you are. github.com/hliosone/bsa-sentry

**LinkedIn** (tag the Ledger page):

> Know Your Agent, enforced by your Ledger.
>
> For the Ledger N3XT Hackathon @ OP3N 2026 (#LedgerN3XTCollab), the EPFL Blockchain Student
> Association built BSA Sentry: a mandate for AI agents, held by a @Ledger device.
>
> Our own Ledger Flex app is the agent's wallet. It signs payments to trusted shops on its own,
> within the limits you set on the device, and asks you only at the boundary: a new shop, or more
> than your automatic limit. A prompt-injected 400 USDC "deposit" is refused without even asking.
>
> The agent can also prove what a shop needs to know about you, 18 or older or a jurisdiction, from
> your EU Digital Identity Wallet, never who you are. Payments settle in USDC on Arc through our
> own x402 facilitator, so any x402 shop, and Shopify, can sell to agents.
>
> Code: https://github.com/hliosone/bsa-sentry

---

## 4. Demo video script (2:30)

Screen recording of Chrome (claude.ai, the BSA Sentry site, the shops) with the Flex filmed in a
corner. Every Flex screen must be readable.

**Before recording:**

- Rules set with the demo values (5 automatic, 50 hard limit, 20 budget, 10 payments), the bakery
  NOT trusted, agent session armed on the Flex, no rights granted yet.
- Budget: coffee 3 + croissant 2 + wine 4.5 + presale 5 = 14.5 of 20. Before the Shopify scene,
  tap **+20 USDC (reset budget)** on the Flex (cut it out), or the next payments hit the budget
  screen.
- Shopify needs a dev store with credentials in `.env` (`docs/SHOPIFY.md`); in DRY_RUN no order
  reaches the Shopify admin. Keep the product at 5 or less to be paid without a tap.
- Give Shopify its own `MERCHANT_SHOPIFY_ADDRESS`: with the bakery fallback the sale is paid
  silently but labelled as the bakery on the Flex and the dashboard. Then add it to the rules before
  recording, or show its first payment as a Trust merchant tap.
- After 18+ is removed, the Flex still signs the wine payment (it is within the rules); the
  facilitator refuses it and nothing is paid. Say "the merchant refuses", not "the Flex refuses".
- Use a test PID loaded into Paradym from `scripts/test-issuer.ts`, with an adult birthdate and a
  non-US nationality, or the wine or the presale is refused on camera.
- `MERCHANT_PRESALE_ADDRESS` must be set (`pnpm keys` does not create it), or `/shops/presale`
  does not exist.

| Time | Picture | Voice-over |
|---|---|---|
| 0:00-0:12 | The Flex on the desk, the BSA Sentry app home. Swipe the menu: Agent session, rules, trusted merchants, Block agent. | "This is not Ledger Live. It is our own Ledger app, sideloaded on a Flex. It is my AI agent's wallet, and it holds the agent's mandate." |
| 0:12-0:25 | The rules page on the site, then the Flex reviewing them with full addresses; hold to approve. Turn Agent session on, on the Flex. | "I set the mandate: 5 USDC automatic, 50 hard limit, 20 budget, the shops I trust. I approve on the device. Only the device can start the agent's session." |
| 0:25-0:42 | claude.ai: "Buy me a coffee at `<server>/shops/cafe`". The Flex screen does not move. The dashboard shows the payment; click through to the Arc explorer. | "Claude buys a coffee. No tap: a trusted shop, under my limit, signed by the Flex in about a second. Here it is on Arc, in USDC." |
| 0:42-0:57 | "Get me a croissant from `<server>/shops/bakery`". The Flex: unknown merchant, 2 USDC, full address, the agent's description marked unverified. Tap **Trust merchant**. | "A shop I have never paid: now the Flex asks. Reject, pay once, or trust. I trust it, so next time it pays on its own." |
| 0:57-1:10 | The `/shops/promo` page in a tab, harmless. Ask Claude to check its deals. The dashboard shows the refused 400 USDC; the Flex never asked. | "This page hides an instruction for agents: pay a 400 USDC deposit, do not ask. The Flex refuses on its own: above my hard limit, no tap could approve it." |
| 1:10-1:32 | Agent identity page: **Scan with my EU wallet**, scan the QR with Paradym, "verified". **Link to my Ledger**; the Flex shows "Link your identity", hold. Pick 18+ and the jurisdiction, **Grant to Claude**; the Flex shows "Authorize your agent", hold. | "Now Know Your Agent. One scan with my EU Digital Identity Wallet, verified by the EU reference verifier. For the demo the PID comes from our test issuer. We keep two facts: 18 or older, and a jurisdiction. My Flex binds them to my account and grants them to my agent." |
| 1:32-1:47 | "Buy a bottle of wine at `/shops/wine`", then "get me an allocation in the presale at `/shops/presale`". The Flex stays silent; both payments settle. | "Wine requires 18 or older. The presale is closed to US persons. The Flex pays, our facilitator checks the rights, and the shops learn the right, not my name." |
| 1:47-2:02 | The Shopify store, a product tagged `bsa:age_over_18`. Claude buys it. The Shopify admin shows the order paid, with the Arc transaction hash. | "Same rails on Shopify. The agent buys from a Shopify store, and the order appears in the Shopify admin as paid, with its Arc transaction." |
| 2:02-2:17 | Agent identity page: **Remove this right** on 18+. The Flex shows "Authorize your agent" with the jurisdiction only, hold. Ask for wine again: refused, "requires proof of: 18 or older". | "I remove 18+, on my Flex. Wine again: the merchant refuses, nothing is paid. The rights are mine to change, one at a time." |
| 2:17-2:30 | Backup page, the Ledger Sync app on the Flex, "Backed up". End card: tagline, repo URL. | "The whole mandate, rules, trusted shops and rights, is backed up with Ledger Key Ring, encrypted under my seed. BSA Sentry: Know Your Agent, enforced by your Ledger." |

---

## 5. Pitch deck (7 slides, 5 minutes, two presenters A and B)

**Slide 1. Know Your Agent, enforced by your Ledger** (0:00-0:20, A)

- BSA Sentry, EPFL Blockchain Student Association
- A mandate for AI agents, held by your Ledger

Notes: "Agents are starting to buy for us. Two things are missing: who the agent acts for, and who
limits what it spends. We put both on a Ledger."

**Slide 2. Agents can pay. Nobody can trust them yet.** (0:20-0:55, A)

- A hot wallet with limits: one prompt injection or server bug away
- Approving every payment: then it is not an agent
- Regulated shops cannot sell to an anonymous agent

Notes: show the promo page's hidden text. "Every limit that lives in software can be talked around.
And a wine shop cannot sell to a bot it knows nothing about."

**Slide 3. A mandate held by your Ledger** (0:55-1:30, B)

- Our own Flex app: the agent's wallet and policy engine
- Know Your Agent: rights from the EU Digital Identity Wallet
- x402 rails: our facilitator, any shop, Shopify, any MCP agent

Notes: "Not a confirm button. The Flex holds the keys and the rules and signs on its own. The EU
wallet proves 18 or older and a jurisdiction, never a name. Any x402 shop can accept it."

**Slide 4. The autonomy boundary** (1:30-1:55, B)

- Autonomous: trusted shops within limits; presenting granted rights
- Human on the Flex: new shops, over the limit, rules, rights, top-ups
- Never: above the hard limit, no session, rights not granted

Notes: "The Flex enforces the first three lines itself, our facilitator the last one. No tap can
override a hard refusal."

**Slide 5. Live demo** (1:55-4:00, B drives, A narrates)

- Coffee: silent. Bakery: Trust merchant. Promo: 400 USDC refused
- EU wallet scan, Bind, grant 18+; wine paid
- Remove 18+; wine refused

Notes: follow `DEMO.md`. Fallback if the network fails: `E2E=1 pnpm demo` (Speculos + Arc), or play
the recorded video.

**Slide 6. For merchants and for Arc** (4:00-4:30, A)

- Standard x402 middleware, our facilitator, `extra.requires`
- USDC on Arc, settled and checked by our facilitator
- Shopify: tag a product, get the order paid

Notes: show the ten-line snippet from `MERCHANTS.md`. "A merchant learns the right, not the person,
and keeps its stack."

**Slide 7. Why Ledger** (4:30-5:00, A)

- The device people trust becomes the agent's wallet
- A new daily use for the device: silent signing, Key Ring backup
- Next: member state PIDs, more rights, more shops

Notes: "Agents will spend. With BSA Sentry, your Ledger knows who they act for and how far they may
go. Know Your Agent, enforced by your Ledger."

---

## 6. Q&A prep

**1. Why not just a hot wallet with limits?**
Its limits are as strong as the machine that holds the key, and that machine runs the software a
prompt injection or a server bug can reach. On the Flex the keys never leave, the rules change only
after an on-device review, the agent session starts only on the device, and every digest is built
from raw fields, so not even our server can get anything outside the rules signed.

**2. What if your server is compromised?**
It cannot sign, start the session, change the rules or exceed the hard limit. It can only request
payments the Flex would accept anyway, which the agent can already do. Plainly: the same server
hosts our verifier and the facilitator, so it could attest false rights, ignore a revocation, or
settle without checking rights. In production the verifier key goes to an HSM in a separate
service, and revocations are published so any facilitator can check them.

**3. Privacy: what does a merchant learn?**
With no rights required: the agent's address and the payment. With rights: the rights (18 or
older, a country code), the agent's address and name, and the owner's Ledger account address,
which is the same across shops. Never a name, a birthdate, the nationality list or a document. We
store no personal data; the birthdate is read once in memory. Next step: one attestation per right
and per-merchant addresses, so a shop sees only what it asked for.

**4. Why Arc?**
USDC is the gas token, so the agent and the facilitator hold a single asset (we measured about
0.002 USDC of gas per payment). USDC on Arc supports EIP-3009, which the x402 `exact` scheme uses,
and x402 supports Arc testnet. Rights checks at the facilitator are the compliance layer that
regulated shops need before they sell to agents.

**5. How does a merchant integrate?**
The standard x402 middleware, our facilitator URL, and `extra.requires` on the routes that need
rights: about ten lines, in `MERCHANTS.md`. No SDK. Shopify stores tag products instead.

**6. What is real and what is demo in the identity flow?**
Real: the EU Digital Identity Wallet reference verifier checks an SD-JWT VC PID presented by
Paradym on a phone, over OpenID4VP 1.0 with DCQL (issuer signature, key binding, nonce). Demo: the
PID itself comes from our test issuer, because the EU test issuer only issues to wallets with
Android key attestation. Production uses a member state PID; nothing else changes.

**7. What about Key Ring?**
We use the Ledger Key Ring protocol in the browser with the Ledger Sync app on the Flex. The whole
mandate, rules, trusted merchants and rights, is encrypted under a key derived from the seed; our
server stores only ciphertext, and only from the account that owns it. A wiped Flex with the same
seed restores it after one on-device review. Verified on the real Flex.

**8. What if the agent lies about the merchant?**
The Flex shows the full address and the amount; the agent's description is marked unverified.
Merchants are matched on the address, never on the label, and "Pay once" never adds a merchant.

**9. Does the user need to run anything locally?**
No daemon: one Chrome tab with the Flex plugged in (WebHID). The agent is remote, over MCP with
OAuth. The limit is a sleeping laptop, which disconnects the Flex; the agent then gets a clear
"open the BSA Sentry tab" message.

**10. Why not a smart-contract wallet with session keys?**
A session key is a hot key with on-chain limits: it cannot show you a screen or ask before a new
merchant, and it needs a deployment and gas on every chain. The Flex does it with a key you
already own, and the rights travel with the payment. The two can combine: the Flex as the signer
of a smart account.

---

## 7. Developer experience feedback (summary; full report in `DX_NOTES.md`)

1. **An N-choice NBGL screen with a built-in timeout.** Deny by default is the agent approval
   primitive; today it costs about 130 lines of `unsafe` on the C layout API, and the layout ticker
   pauses while the screen is touched.
2. **NBGL draws overflowing text underneath the buttons.** It hid the "(unverified)" caveat on our
   confirmation screen. On a confirmation screen that is a security bug.
3. **The SDK bakes derivation paths in at build time** and produces an app that crashes on first
   derivation after a manifest change.
4. **Speculos swipes are undocumented** (`x2`/`y2` on `/finger`); every touch device CI needs them.
5. **No pattern for remote agents.** Hosted assistants talk to a server, not to the user's machine;
   the human step has to live in a browser next to the device.

What worked well: Speculos, on-device EIP-712 matching viem and the chain on the first try, silent
signing, and the DMK in Vite with no polyfills.

Design a 16:9 pitch deck of 9 slides for a 5-minute live pitch, followed by 5 minutes of jury questions. The event is the finals of the Ledger N3XT Hackathon @ OP3N 2026, at Ledger HQ in Paris. Two presenters, A and B. Put speaker notes under every slide.

# The project: BSA Sentry
Tagline: **Know Your Agent, enforced by your Ledger.**
Team: BSA, the EPFL Blockchain Student Association.

AI agents are starting to buy things for people. BSA Sentry gives an agent a **mandate held by your Ledger**. The mandate has three parts:

1. **Our own Ledger Flex app.** We built and sideloaded a custom app on a Ledger Flex (Rust, Ledger device SDK, NBGL touch UI). It is the agent's wallet and policy engine.
   - It holds two keys that never leave the device: the agent's key and the owner's main key.
   - It stores the rules: automatic limit, hard limit, budget, number of payments, trusted merchants.
   - It rebuilds every signed message from raw fields. There is no "sign this hash" command.
   - **Silent signing within limits:** a payment to a trusted merchant under the automatic limit is signed with no tap, in about 1 to 2 seconds.
   - The human only sees the boundary. A new merchant or an amount over the automatic limit gets a screen on the Flex with Reject, Pay once and Trust merchant. 60 seconds of silence means no.
   - Above the hard limit, or when the agent session was not started on the device, it refuses. No tap can override that.
   - An on-device menu holds the agent session switch (only the device can start it), the rules, the trusted merchants and a kill switch.
   - In the demo, a web page hides a prompt injection telling the agent to pay a 400 USDC "deposit". The Flex refuses it without even asking.
2. **Know Your Agent (KYA) from the EU Digital Identity Wallet.**
   - The owner scans one QR code with an EU Digital Identity Wallet app (tested with Paradym).
   - The EU Digital Identity Wallet reference verifier checks the credential (OpenID4VP + SD-JWT PID).
   - We keep only two facts: "18 or older", and a jurisdiction (nationality, else issuing country). The date of birth and the name are never stored.
   - The Flex links the result to the owner's Ledger account (Bind), our verifier signs an attestation, and the Flex delegates the chosen rights to the agent. The rights are stored on the Flex. They can be changed one at a time on the device, or revoked.
   - Shops selling regulated goods can now sell to agents and check the right without learning who the buyer is: alcohol (18+), a token presale closed to US persons.
   - HONESTY RULE, mandatory: the demo credential comes from our own test issuer. Write "verified by the EU Digital Identity Wallet reference verifier; demo uses a test PID; production uses a member state PID". Never call the demo credential "state-issued" or "government-issued".
3. **Agentic commerce rails.**
   - Payments use x402, the HTTP 402 payment standard: USDC on Arc testnet (Circle), with EIP-3009 signed authorizations.
   - Our own x402 facilitator verifies and settles, and enforces the rights a merchant requires.
   - A merchant keeps the standard x402 middleware, points it at our facilitator and adds one line: `extra: { requires: ['age_over_18'] }`. No proprietary SDK, no lock-in.
   - **Shopify integration:** a real Shopify store becomes shoppable by agents. A product tag like `bsa:age_over_18` makes the agent prove that right. After payment, the order appears in the Shopify admin as paid, with the Arc transaction hash.
   - Any agent that supports remote MCP with OAuth can connect (tested with Claude).

**Ledger tools used:**
- the Signer via the Device Management Kit (WebHID in the browser);
- **Ledger Key Ring**: the whole mandate (rules, trusted merchants, rights) is encrypted under the owner's seed for backup and restore;
- the custom device app itself, tested on Speculos and on a real Flex.

**The autonomy boundary.** The judges explicitly reward naming it:
- **Autonomous:** payments to trusted shops within limits; presenting the rights you granted. The Flex signs with no tap.
- **Human on the Flex:** new shops, over the automatic limit or budget, setting rules, granting or changing rights, top-ups, starting the agent session.
- **Never:** above the hard limit, no session, wrong network or token (the Flex refuses). Rights not granted or revoked (our facilitator refuses).

# Audience and scoring
**Jury:**
- Ian Rogers, Chief Human Agency Officer at Ledger: human control over AI agents.
- Guillaume Mathias, VP Product at Ledger: product, UX, new uses for Ledger devices.
- Joshua Mo, DevRel Lead at Venice (private AI): privacy, developer experience.
- Drake Breeding, Director Ecosystem Arc at Circle: USDC on Arc, agentic commerce, compliance.

**Scoring:** technical execution 25%, usefulness for Ledger 20%, innovation 20%, user experience 15%, new use cases for Ledger 10%, clarity 10%.

**Positioning:** most student teams will show "the agent asks, the Ledger approves". Our deck must make it obvious within 10 seconds that this is bigger. We built our own device app that signs silently inside rules, an agent identity rooted in the EU Digital Identity Wallet, and the commerce rails (facilitator, Shopify) that let regulated shops sell to agents.

# Slides (timing for 5:00 total; at most 25 words of body text per slide except slide 6)

1. **Title (0:00 to 0:15, A).**
   - Large: "Know Your Agent, enforced by your Ledger."
   - Under it: "BSA Sentry" and "EPFL Blockchain Student Association".
   - Visual: a photo placeholder of a Ledger Flex showing our app's home screen ("BSA Sentry", "Agent: Claude", "Budget 17.00 / 20.00 USDC").
   - Notes: "Agents are starting to buy for us. Two things are missing: who the agent acts for, and who limits what it spends. We put both on a Ledger."
2. **The problem (0:15 to 0:45, A).** Title: "Agents can pay. Nobody can trust them yet."
   - Three short lines, each with a small icon (no clip art): "Limits in software can be talked around (prompt injection)". "Approving every payment kills the agent". "Regulated shops cannot sell to an anonymous bot".
   - Notes: mention the hidden 400 USDC instruction on a web page.
3. **What we built (0:45 to 1:10, B).** Title: "A mandate held by your Ledger".
   - Three columns: "Our own Ledger app" / "Know Your Agent" / "Agentic commerce rails", one line each (use the lines from the project section above).
   - Visual: a simple system diagram.
     - Agent (any MCP client), then BSA Sentry server, then the browser tab (WebHID), then the Ledger Flex (keys, rules, rights).
     - Merchant (x402 or Shopify), then our facilitator, then Arc (USDC).
     - EU Digital Identity Wallet, then the EU reference verifier, then the Flex.
   - Clean lines, no 3D, no gradients.
4. **Our own Ledger app (1:10 to 1:45, B).** Title: "Not a confirm button. A policy engine in the device."
   - Visual: three Flex screens side by side, colour-coded.
     - Green: "Signed silently, 1 to 2 s".
     - Amber: the 3-choice screen "Pay 2 USDC on Arc? Unknown merchant. Reject / Pay once / Trust merchant".
     - Red: "Refused: above your hard limit".
   - Small footer chips: "Rust + NBGL", "Keys never leave", "Digest built on device", "60 s deny by default", "Key Ring backup".
5. **Know Your Agent (1:45 to 2:20, A).** Title: "Prove what a shop needs. Never who you are."
   - A horizontal 5-step flow: Scan with EU wallet; Verified by the EU reference verifier; Keep only "18+" and "jurisdiction"; Flex binds and grants to the agent; Shop checks the right, revocable.
   - Place the EU Digital Identity Wallet logo (provided asset, placeholder if missing).
   - Small honest footnote: "Demo: test PID. Production: member state PID."
6. **Agentic commerce rails (2:20 to 2:45, B).** Title: "Any shop can sell to agents, compliantly."
   - Left: a short code block (monospace):
     ```js
     app.use(paymentMiddleware({
       'GET /wine': { accepts: { scheme: 'exact', price: '$4.5', network: 'eip155:5042002',
         payTo, extra: { requires: ['age_over_18'] } } },
     }, new x402ResourceServer(new HTTPFacilitatorClient({ url: BSA_SENTRY_FACILITATOR }))));
     ```
   - Right: a Shopify admin screenshot placeholder, "Order #1001, Paid, USDC on Arc, tx 0x...", and a product tagged "bsa:age_over_18".
   - Footer: "USDC on Arc, settled by our facilitator. Any MCP agent."
7. **The autonomy boundary (2:45 to 3:00, A).** Title: "Who decides what".
   - Three horizontal bands: green "Autonomous", amber "You, on the Flex", red "Never". Two short lines each, from the boundary section above.
8. **Live demo (3:00 to 4:35, B drives, A narrates).** Title: "Live".
   - A checklist the audience can follow: "Coffee: paid silently". "Bakery: Trust merchant". "Hidden 400 USDC: refused". "EU wallet scan, grant 18+". "Wine and presale: paid". "Shopify order: paid". "Remove 18+: wine refused".
   - Leave space for a live screen.
9. **Why Ledger, and next (4:35 to 5:00, A).** Title: "Your Ledger, the root of trust for agents".
   - Three lines: "The device people trust becomes the agent's wallet". "A new daily use: silent signing, KYA, Key Ring backup". "Next: member state PIDs, more rights, more shops".
   - End with the tagline, the repo URL `github.com/hliosone/bsa-sentry`, and a QR code placeholder.

# Visual direction
- **Mood:** precise, calm, technical, confident. It should feel like a hardware security product, not a crypto meme or a generic AI startup.
- **Palette:** near-black background `#050506`, off-white text `#f4f5f2`, graphite secondary text `#9a9ca3`. Colour only means something: green `#34d399` = signed or autonomous, amber `#fbbf24` = asks you, red `#f87171` = refused. No other accent colours, no gradients, no glow.
- **Type:** one modern grotesk (for example Inter Tight or Geist) with big, tight headlines and generous whitespace; monospace (Geist Mono or JetBrains Mono) only for code and addresses.
- **The device:** draw the Ledger Flex as a black device with a white E Ink touchscreen (black text on white, simple NBGL-style layout). Never invent other Ledger products or logos.
- **Layout:** one idea per slide, left-aligned, plenty of space, with numbers and diagrams over paragraphs.
- **Avoid:** robots, brains, shields with padlocks, glowing circuits, stock photos, and walls of text.
- Max 3 bullets per slide. Bullets are phrases, not sentences.
- English only. Do not use em dashes or en dashes anywhere; use commas, colons or periods.
- Do not invent numbers, customers, partnerships or metrics. Only use facts stated in this prompt.
- **Placeholders:** mark them clearly for the photos and screenshots we will add: the Flex home screen, the Flex 3-choice screen, the dashboard Activity, the Paradym share screen, and the Shopify admin order.

Revise the deck to 6 slides. The pitch is 5 minutes in total, including a 1:15 demo video. Keep the current visual style exactly: black background, off-white type, colour only for meaning (green = signed alone, amber = asks you, red = refused). No em dashes or en dashes. English only. Update the speaker notes to match the new timings.

**Slide 1. Title (0:10).** Keep as is.

**Slide 2. Problem (0:25).** Keep as is.

**Slide 3. "A mandate held by your Ledger" (1:00).** This slide carries the architecture.
- Keep the three column headers and the diagram, but make the diagram build in three steps, one row per click, and move the column headers into the rows. The final state shows all three rows.
  - Row 1, "Our own Ledger app": Agent (any MCP client), then BSA Sentry server, then the browser tab (WebHID), then the Ledger Flex. Caption: "Signs alone within your rules. Asks you at the boundary. Refuses beyond it."
  - Row 2, "Know Your Agent": EU Digital Identity Wallet (logo), then the EU reference verifier, then the Ledger Flex. Caption: "18+ and jurisdiction, granted to the agent by the Flex. Never your name."
  - Row 3, "Agentic commerce rails": a merchant (x402, or **our Shopify connector** with the Shopify logo), then **our x402 facilitator**, then Arc (USDC). Caption: "Any shop can sell to agents, compliantly."
- The Ledger Flex box on the right stays the anchor: "keys, rules, rights".
- Notes: name the autonomy boundary out loud ("signs alone, asks you, refuses"), and say the facilitator verifies the agent's rights before settling.

**Slide 4. Demo (1:15).** A full-bleed video placeholder titled "Live demo". Add a thin caption strip at the bottom showing the sequence, colour-coded:
- green "Coffee: signed alone"
- amber "New bakery: Trust merchant"
- red "Hidden 400 USDC: refused"
- "EU wallet scan, grant 18+"
- green "Wine and Shopify order: paid"
- red "18+ removed: wine refused"

**Slide 5. "What else your Ledger holds" (0:40).** Six equal tiles, each with an icon-free short title and one line:
1. "Key Ring backup": rules, merchants and rights, encrypted under your seed. Restored with one review.
2. "Top-up from your Ledger": your main account funds the agent. The Flex picks the recipient itself.
3. "Trusted merchants": added from the Flex screen, removed from the Flex menu.
4. "Rights, one by one": grant or remove each right on the Flex. Our facilitator verifies them before every payment.
5. "Our Shopify connector": tag a product `bsa:age_over_18`. The order appears in Shopify as paid. (Shopify logo.)
6. "Kill switch": the agent session only starts on the device and stops there.

**Slide 6. Team and thank you (0:15).**
- "Thank you", then three names: Stan Stelcher, Jules Delforge, Antoine Decorme. Under them, "EPFL Blockchain Student Association".
- Keep the tagline "Know Your Agent, enforced by your Ledger.", the repo `github.com/hliosone/bsa-sentry` with a QR code placeholder, and the live site `server-production-423c.up.railway.app`.

**Delete** the old slides 4 ("Not a confirm button"), 5 ("Prove what a shop needs"), 6 ("Any shop can sell to agents"), 7 ("Who decides what"), and 9 ("Your Ledger, the root of trust"). Their content now lives in slides 3, 4 and 5.

Revise the deck to exactly 6 slides. The pitch is 5 minutes in total, including a 1:15 demo video, so few slides and little context switching. Each slide carries more content, but stays clean.

Keep the current visual style exactly: black background, off-white type, colour only for meaning (green = signed alone, amber = asks you, red = refused). English only, no em dashes or en dashes. Rewrite the speaker notes for the new timings.

The jury scores "a concrete Ledger primitive actually implemented, not mentioned". The Ledger features we built must therefore be visible and named, never presented as optional extras.

**Slide 1. Title (0:10).** Keep as is.

**Slide 2. Problem (0:20).** Keep as is.

**Slide 3. "A mandate held by your Ledger" (0:45).** Keep the current diagram and column headers as they are. One change only: the merchant box becomes "Merchant (x402, or our Shopify connector)", with the Shopify logo next to it.
- Notes:
  - Walk the three rows.
  - Say the autonomy boundary out loud: "the Flex signs alone within your rules, asks you at the boundary, refuses beyond it".
  - Say "our facilitator verifies the agent's rights before it settles".

**Slide 4. "How the mandate works" (0:45).** Two halves on one slide.
- Top half, "Our own Ledger app":
  - Keep the three Flex screens from the old slide "Not a confirm button", with the same colours and labels:
    - green "Signed alone, 1 to 2 s";
    - amber "Asks you, on the Flex" (Reject / Pay once / Trust merchant);
    - red "Refused, no tap can override".
  - Under each screen, one small line saying what triggers it:
    - "Trusted merchant, under your automatic limit";
    - "New merchant, or over your limit";
    - "Above your hard limit, or no session".
  - Keep the chips row: "Sideloaded Flex app, Rust + NBGL", "Keys never leave", "Digest built on device", "60 s deny by default".
- Bottom half, "Know Your Agent":
  - One compact row of 5 steps:
    1. "Scan with your EU Digital Identity Wallet"
    2. "EU reference verifier checks"
    3. "Keep only 18+ and jurisdiction"
    4. "Your Flex signs the binding and grants the rights to the agent"
    5. "Our facilitator verifies, the shop learns the right, not your name"
  - Small EU Digital Identity Wallet logo.
  - Footnote: "Demo uses a test PID. Production uses a member state PID."

**Slide 5. Demo (1:15).** A full-bleed video placeholder titled "Live demo". Add a thin caption strip along the bottom, colour-coded:
- green "Coffee: signed alone"
- amber "New bakery: Trust merchant"
- red "Hidden 400 USDC: refused"
- "EU wallet scan, rights granted on the Flex"
- green "Wine and Shopify order: paid"
- red "18+ removed on the Flex: wine refused"

**Slide 6. "What your Ledger does" + Team (0:35).**
- **Left, two thirds of the width:** a grid of 8 compact tiles. Each tile has a bold title and one short line. Add a small label on the tiles that use a Ledger primitive: "Ledger device app", "Ledger Signer (DMK)" or "Ledger Key Ring".
  1. "Key Ring backup" (Ledger Key Ring): rules, trusted merchants and rights, encrypted under your seed. A wiped Flex is restored with one review.
  2. "Top-up from your Ledger" (Ledger device app): your main account funds the agent. The Flex picks the recipient itself.
  3. "Login with Ledger" (Ledger device app): the Flex signs the login. No password.
  4. "Trusted merchants" (Ledger device app): added from the Flex screen, removed from the Flex menu.
  5. "Rights, one by one" (Ledger device app): every grant or removal is signed on the Flex.
  6. "Kill switch" (Ledger device app): the agent session only starts on the device, and stops there.
  7. "One tab, any agent" (Ledger Signer, DMK): the browser bridges any MCP agent to the Flex over WebHID.
  8. "Our Shopify connector": tag a product `bsa:age_over_18`, and the paid order lands in Shopify. Shopify logo. Subline: "Any shop can sell to agents, compliantly."
- **Right, one third:** "Thank you", then Stan Stelcher, Jules Delforge, Antoine Decorme, then "EPFL Blockchain Student Association". Under them: the tagline "Know Your Agent, enforced by your Ledger.", `github.com/hliosone/bsa-sentry`, a QR code placeholder, and `server-production-423c.up.railway.app`.

**Delete** these old slides:
- "Prove what a shop needs" (now on slide 4);
- "Any shop can sell to agents" (its sentence is now on slide 6);
- "Who decides what" (slide 4 shows it);
- "Live" (replaced by slide 5);
- "Your Ledger, the root of trust" (replaced by slide 6).

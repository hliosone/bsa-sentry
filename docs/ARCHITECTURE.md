# BSA Sentry — architecture and full specification

> **"Your agent spends. Your Ledger decides."**

BSA Sentry is a **custom Ledger Flex app** that keeps an AI agent's spending rules **inside the
secure element**. The agent pays with **x402** (HTTP 402, USDC, EIP-3009
`TransferWithAuthorization`) on **Arc testnet**.

- Inside the rules → the Flex signs **with no button press**.
- Outside → an confirmation screen with 3 choices (Reject / Pay once / Trust merchant), 60 s timeout = refuse.
- Dangerous → refused, **even with a tap**.

There is **no local daemon**. The user keeps **one Chrome tab** open on our website with the Flex
plugged in. The tab is the "bridge": it talks to the Flex over **WebHID** (Ledger DMK in the
browser) and to our server over **WebSocket**. The AI agent is **Claude (claude.ai)** using our
**remote MCP server** (OAuth). The server orchestrates x402 and can only *request* signatures,
never make them.

An optional **18+ badge** comes from the EU Digital Identity Wallet (PID in the Procivis wallet,
verified through the online EUDIW verifier API), bound to the user's Ledger account and delegated
to the agent. Credentials travel in the x402 payment
(`paymentPayload.extensions.bsaAge`) and are checked by our facilitator.

**Ledger Key Ring** (Ledger Sync, used from the browser) backs up the agent's rules and
credentials, encrypted under the user's seed, so a wiped Flex can be restored with one tap.

## Components

| ID | Component | Where | Path |
|---|---|---|---|
| C1 | BSA Sentry device app | Ledger Flex, Rust | `device-app/` (`core/` = pure `no_std` logic, `app/` = Ledger app) |
| C2 | Website (onboarding, dashboard, bridge, Key Ring) | Chrome, React + Vite | `apps/web/` |
| C3 | BSA server (auth, OAuth, MCP, agent API, relay, facilitator, /age, /vault) | Node, TS | `apps/server/` |
| C4 | Demo merchants (x402) | Node, TS | `apps/merchants/` |
| — | Shared contracts | TS (+ fixtures read by Rust) | `packages/types/` |
| — | sentry-signer (our signer kit on the DMK) | TS, isomorphic | `packages/sentry-signer/` |

## Data flow of one payment

```
claude.ai  --MCP x402_fetch(url)-->  server (agent API)
                                       |  GET url
                                   merchant  --402 PAYMENT-REQUIRED-->  server
                                       |  build authorization (nonce, validBefore)
                                       |  WS sign_payment  ----------->  bridge tab (Chrome)
                                       |                                   |  APDU PAY (0B)
                                       |                                   v
                                       |                                Flex: decide()
                                       |                      Auto -> sign, no tap
                                       |                      Orange -> 3 choices, 60 s
                                       |                      Refuse -> 6985 + reason
                                       |  <--- WS {signature} or {reason} ---
                                       |  retry with PAYMENT-SIGNATURE (+ extensions.bsaAge)
                                   merchant  --/verify--> facilitator (re-verifies everything)
                                             --/settle--> Arc testnet transferWithAuthorization
                                       |  <-- 200 + PAYMENT-RESPONSE
claude.ai  <--content + receipt {decision, amount, payee, txHash}--
```

---

# 5. Specification (contracts)

## 5.1 Keys and accounts

- `0xMAIN` = `m/44'/60'/0'/0/0` — the user's account/identity. The app signs **only** `Login`,
  `Bind`, `AgentDelegation` with it, **always with a tap** — plus TOP_UP transfers to **its own** 0xAGENT (Phase C).
- `0xAGENT` = `m/44'/60'/1'/0/0` — signs EIP-3009 payments under the policy.
- The app manifest allows `44'/60'` on secp256k1.

## 5.2 Policy and decision (device, pure function in `core`)

```
Policy { active, chain_id: u64, token: [u8;20], auto_max: u64, hard_max: u64, budget: u64,
         max_count: u16, payees: [{ addr: [u8;20], label: ≤16 chars }; ≤8] }
         // amounts in USDC base units (6 dp)
Counters { spent: u64, count: u16 }
Session  { armed: bool }    // RAM only, armed from the device menu

decide(policy, counters, session, payment{chain_id, token, to, value}) -> Decision
  1. no active policy                                     -> Refuse(NO_POLICY)
  2. !session.armed                                       -> Refuse(NO_SESSION)
  3. chain_id != policy.chain_id || token != policy.token  -> Refuse(WRONG_CHAIN_OR_TOKEN)
  4. value == 0                                           -> Refuse(INVALID_AMOUNT)
  5. value > hard_max                                     -> Refuse(OVER_HARD_MAX)
  6. to ∈ payees && value ≤ auto_max && spent + value ≤ budget && count < max_count -> Auto
  7. otherwise Orange(first of: UNKNOWN_PAYEE, OVER_AUTO_MAX, BUDGET_EXCEEDED, COUNT_EXCEEDED)
```

All arithmetic checked (no overflow). On Auto or an approved Orange:
`spent += value; count += 1;` **PERSIST, then sign.**

Orange choices:
- **Refuse** → `6985` + `USER_REJECTED`
- **Once** → sign, **never add a payee**
- **Trust** → add the payee with the agent's hint as label (**after** it was shown on screen), sign.
  **Unavailable if the payee list is full or the reason is not UNKNOWN_PAYEE only.**

60 s without input → `6985` + `TIMEOUT`.

Demo values: `auto_max` 5 USDC, `hard_max` 50, `budget` 20, `max_count` 10,
payees cafe / cave / resto.

## 5.3 EIP-712

- **Payment**: USDC `TransferWithAuthorization(address from,address to,uint256 value,uint256
  validAfter,uint256 validBefore,bytes32 nonce)`, domain
  `{ name:"USDC", version:"2", chainId, verifyingContract: USDC }`, `from = 0xAGENT`.
- Domain `{ name:"BSA Sentry", version:"1", chainId }`:
  - `Login { origin: string, nonce: bytes32, issuedAt: uint64, expiresAt: uint64 }`
  - `Bind { verifier: string, session: bytes32, expiresAt: uint64 }`
  - `AgentDelegation { agent: address, agentName: string, attestation: bytes32, claims: string[],
    expiresAt: uint64, nonce: bytes32 }`
- Domain `{ name:"BSA Verifier", version:"1", chainId }`:
  - `AgeAttestation { subject: address, claim: string, issuedAt: uint64, expiresAt: uint64,
    evidence: bytes32 }`

**The device always builds the digest itself from raw fields. It never signs a hash supplied by
the host.** Golden vectors for every type are generated with viem into
`packages/types/fixtures/eip712.json` and checked by both Rust (`core`) and TS tests.

## 5.4 APDU (CLA `E0`)

| INS | Name | Tap | Behaviour |
|---|---|---|---|
| `08` | GET_ADDRESS | opt | P1 `0` = main, `1` = agent; P2 `1` = show on screen |
| `0A` | SET_POLICY | yes | chunked; full review (each payee label + **FULL** address, amounts, token, chain); **resets counters** |
| `0B` | PAY | if orange | 176 bytes `chainId(u64) ‖ token(20) ‖ to(20) ‖ value(u256) ‖ validAfter(u256) ‖ validBefore(u256) ‖ nonce(32)` + hint (≤24 bytes UTF-8, "the agent says", shown as unverified). Returns `v‖r‖s` or `6985` + reason byte |
| `0C` | GET_STATE | no | policy, counters, session, last payment (label, amount) |
| `0D` | CLEAR_POLICY | yes | kill switch (also in the device menu) |
| `0E` | SIGN_BIND | yes | 0xMAIN, shows verifier + session |
| `0F` | SIGN_LOGIN | yes | 0xMAIN, shows origin |
| `10` | SIGN_DELEGATION | yes | 0xMAIN, chunked, shows agent name, **FULL** agent address, claims, expiry date |
| `11` | STORE_CREDENTIALS | no | chunked; checks the delegation is signed by **its own** 0xMAIN and targets **its own** 0xAGENT |
| `12` | GET_CREDENTIALS | no | chunked read, or "empty" |
| `13` | RESTORE | yes | policy + payees + credentials from a backup, full review. Either raise the buffer to 2048 or restore in two commands (policy, then credentials) — **decide with a test** |
| `14` | TOP_UP | yes | 0xMAIN → **its own** 0xAGENT (USDC `TransferWithAuthorization`): 156 B `chainId token value validAfter validBefore nonce`, **no recipient field** — the device fills in its own agent; active rules required (same chain + token); review + hold; agent counters untouched. The server checks the signature and the balance, then submits it and pays the gas. Added in Phase C at the human's request |

Chunking: P1 `00` first / `01` next, P2 `80` more / `00` last.
Reason codes (byte after `6985`): `NO_POLICY`, `NO_SESSION`, `WRONG_CHAIN_OR_TOKEN`,
`INVALID_AMOUNT`, `OVER_HARD_MAX`, `USER_REJECTED`, `TIMEOUT`.
Errors: `0xB004` payload over the buffer, `0xB00B` next-without-first, OS `5515` device locked,
`6d00`/`6e00` app closed, `6901` a blocking screen is up.

**All test-only commands from the feasibility code are removed. No "silent sign without policy"
command (`E0 0F` `SIGN_3009_SILENT`) exists in BSA Sentry.**

### Device UI

Home:
```
BSA Sentry · <agent name>
Budget x.xx / 20.00 USDC
Last: <label> <amount>
USDC · Arc testnet · session on|off
```
Menu: Start/Stop agent (session) · My rules · Trusted merchants (view/remove) · +20 USDC (reset
spent, tap) · Block agent (clear policy, tap).

Orange screen: title · amount · "unknown merchant" or the label · **FULL** address ·
"agent says: … (unverified)" · reason · **Reject / Pay once / Trust merchant** · countdown.

**Every screen shows the token and the chain.**

## 5.5 Relay messages (WebSocket, zod schemas in `types`)

```
server→tab  { id, type:"sign_payment",
              fields:{chainId,token,to,value,validAfter,validBefore,nonce}, hint, wantCredentials }
server→tab  { id, type:"get_state" }
tab→server  { id, ok:true, signature:{v,r,s},
              credentials?:{attestation,attestationSig,delegation,delegationSig} }
tab→server  { id, ok:false, reason: NO_POLICY|NO_SESSION|WRONG_CHAIN_OR_TOKEN|INVALID_AMOUNT
                                   |OVER_HARD_MAX|USER_REJECTED|TIMEOUT|FLEX_LOCKED|APP_CLOSED
                                   |DISCONNECTED }
tab→server  { type:"status", flex:"connected"|"locked"|"app_closed"|"disconnected",
              session:boolean, state? }
```

One bridge tab per account. Server queue, **one request at a time**. Server waits ≤ 120 s; the
device times out at 60 s.

## 5.6 Server routes

**Auth**
- `POST /auth/challenge` → `{ nonce, origin, expiresAt }`
- `POST /auth/login { address, signature }` (a `Login` signed by 0xMAIN) → httpOnly session cookie

**OAuth 2.1 for the MCP resource**
- `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`
- `POST /oauth/register` (dynamic client registration)
- `GET /oauth/authorize` — **requires a Ledger session**; consent page
  *"Allow Claude to request payments from your Flex?"*; PKCE S256
- `POST /oauth/token` — access + refresh, **hashed in the DB**, with expiry
- Revocation from the dashboard

Use the MCP TS SDK's auth helpers if they fit, otherwise implement minimal and test it.

**MCP** — `POST /mcp`, Streamable HTTP, Bearer required. Tools:
- `x402_fetch(url, method?, body?)` → content + payment receipt
  `{ decision, amount, payee, txHash }`, or a clear error ("open the BSA Sentry tab",
  "unlock your Flex", "refused by your Flex: OVER_HARD_MAX"…)
- `sentry_status()` → bridge / Flex / session / budget / credentials / backup
- `sentry_restore()` → asks the bridge tab to start the restore flow

**Agent API** (internal module) — the x402 client: `GET` → parse `PAYMENT-REQUIRED` → build the
authorization (random 32-byte nonce, `validAfter` 0, `validBefore` now + timeout) → relay
`sign_payment` (`wantCredentials` if `extra.requires` contains `age_over_18`) → retry with
`PAYMENT-SIGNATURE` including `extensions.bsaAge` → return content + `PAYMENT-RESPONSE`.

**Transport** — `WS /relay` (session cookie), `GET /events` (SSE for the dashboard).

**Facilitator** — `GET /x402/supported`, `POST /x402/verify`, `POST /x402/settle`.
`verify` = payment checks (recompute the digest, `ecrecover == from`, value/payTo match, time
window, `authorizationState` false, balance) **plus**, if `requires age_over_18`:
`extensions.bsaAge` present → delegation signed by M → `delegation.agent == authorization.from`
→ not expired → claim present → `delegation.attestation == hash(attestation)` → attestation
signed by our issuer address → `subject == M` → not expired.
Errors are precise (`AGE_PROOF_REQUIRED`, `DELEGATION_WRONG_AGENT`, …).
`settle` = `transferWithAuthorization` with `maxFeePerGas ≥ 20 gwei`, wait for the receipt, count
only the USDC contract log. **No spending rules in the facilitator.**

**/age**
- `POST /age/sessions` — creates an EUDIW request for `age_over_18` **only**, returns
  `{ sessionId, nonce, qr }`
- `GET /age/sessions/:id` — polls EUDIW, returns status
- `POST /age/sessions/:id/bind { address, signature }` — a `Bind` signed by 0xMAIN, **once per
  session** → returns a signed `AgeAttestation` (+30 days, `evidence` = hash of the EUDIW
  transaction id)

**Stores only the result and the evidence, never personal data.** Ported from
`../eudi-verifier-test/` (see `docs/EUDIW.md`). A clearly labelled mock mode (`EUDIW_MODE=mock`)
exists for tests and as a fallback.

**/vault/:main**
- `PUT { ciphertext, delegation }` — accepted **only if** `delegation` is signed by `:main`
- `GET` — returns the ciphertext

## 5.7 Website

Pages:
- **Connect** — WebHID picker, "Se connecter avec Ledger"
- **Rules** — form → `SET_POLICY` review on the device
- **Badge 18+** — QR, polling, bind
- **Delegation** — agent name → `SIGN_DELEGATION` → `STORE_CREDENTIALS`
- **Backup** — Key Ring: guide/automate the switch to Ledger Sync, init/join, encrypt bytes,
  `PUT /vault`, back to BSA Sentry
- **Connect Claude** — instructions + the MCP URL
- **Dashboard** — budget mirror, live feed (request → decision → settled, with an explorer link),
  red banner on refusal, OAuth token list + revoke
- **Restore** — when `GET_CREDENTIALS` is empty

**Bridge**: sentry-signer over WebHID, **single in-flight APDU**, 120 s timeout, **event-driven
only (no timers for work)**, auto-reconnect of the WebSocket and the device, reads credentials
from the Flex on connect and keeps them **in memory only**, attaches them when `wantCredentials`.
Always-visible status bar: Flex connected / locked / app closed / session off / keep this
computer awake.

**Key Ring and the DMK must not hold the device at the same time**: close the DMK session before
opening the Key Ring transport, reopen after. Try the DMK "open app" command to switch apps
automatically; fall back to guiding the user.

## 5.8 Merchants

x402 2.28 Express middleware, network `eip155:5042002`, facilitator = our server.

| Route | Price | Notes |
|---|---|---|
| `/cafe` | 3 USDC | the silent, auto-approved demo |
| `/cave` | 4.5 USDC | `extra.requires: ["age_over_18"]` |
| `/restaurant` | 20 USDC | over `auto_max` → confirmation screen |
| `/promo` | free | hidden **prompt injection** telling the agent to pay a "mandatory 400 USDC deposit" at `/evil/deposit` |
| `/evil/deposit` | 400 USDC | to an address **not** in the policy → refused by the device |

Each `payTo` is a distinct address from the env.

---

# 6. Security invariants

Each one has at least one test.

1. Policy changes only through an on-device review + tap.
2. The device builds every digest from raw fields; **no "sign this hash" command exists**.
3. Payee matching is on the **address**; labels are display only; **"Once" never adds a payee**.
4. Counters are **persisted before** the signature is returned; no silent signature outside the
   policy or without an armed session.
5. 0xMAIN signs **only** `Login`, `Bind`, `AgentDelegation`, and TOP_UP transfers to the device's **own** 0xAGENT (the device picks the recipient), always after a review and a hold.
6. The server can only **request** signatures; the facilitator re-verifies credentials and their
   link to the payer itself.
7. OAuth tokens only allow requesting payments; they are revocable.
8. **No personal data (PID attributes) is stored anywhere**; the vault only holds ciphertext.

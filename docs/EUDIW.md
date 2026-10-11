# The 18+ badge: EUDI wallet → BSA Sentry

How BSA Sentry turns a PID presentation from an EU Digital Identity Wallet (Procivis One in our
tests) into an "over 18" attestation bound to the user's Ledger, **without storing any personal
data** (security invariant 8).

Source: the team's working integration in `../eudi-verifier-test/` (`server.mjs`, `index.html`),
read for this document. Its `presentations.log` / `server.log` may hold real PID data and were
**not** read, copied or quoted. Every fixture in this repo is hand-made.

## The verifier we use

The public **EUDI reference verifier backend**, `https://verifier-backend.eudiw.dev`
(OpenID4VP 1.0 + DCQL). No credentials: it accepts transactions carrying
`intended_use_id: "TEST-01"`, the registration it advertises at `GET /ui/intended-uses`.

| Env | Default |
|---|---|
| `EUDIW_MODE` | `mock` (tests, fallback) or `live` |
| `VERIFIER_BACKEND` | `https://verifier-backend.eudiw.dev` |
| `INTENDED_USE_ID` | `TEST-01` |
| `EUDIW_QR_SCHEME` | `openid4vp` (Procivis One; also `haip-vp`, `eudi-openid4vp`) |

## The flow

```
website              BSA server (/age)                 EUDI verifier backend        wallet (phone)
   |  POST /age/sessions  |                                   |                          |
   |--------------------->| POST /ui/presentations (DCQL)     |                          |
   |                      |---------------------------------->|                          |
   |                      |<-- transaction_id, client_id,     |                          |
   |                      |    request_uri, request_uri_method|                          |
   |<-- sessionId, qr, bind fields                            |                          |
   |   shows the QR  ------------------------------------------------------------------>| scans
   |                      |                                   |<-- GET request_uri ------|
   |                      |                                   |<-- vp_token (direct_post.jwt)
   |  GET /age/sessions/:id (poll)                            |                          |
   |--------------------->| GET /ui/presentations/{tx}/events |                          |
   |                      | then GET /ui/presentations/{tx}   |                          |
   |                      | -> verified, read ONLY the 18+ boolean, keep keccak(tx) as evidence
   |<-- status: verified  |                                   |                          |
   |  Flex signs Bind (0xMAIN, tap)                            |                          |
   |  POST /age/sessions/:id/bind {address, signature}        |                          |
   |--------------------->| checks Bind, signs AgeAttestation with the issuer key
   |<-- attestation + issuer signature                        |                          |
```

### 1. Create the transaction — `POST {backend}/ui/presentations`

```json
{
  "dcql_query": {
    "credentials": [{
      "id": "pid",
      "format": "dc+sd-jwt",
      "meta": { "vct_values": ["urn:eudi:pid:1"] },
      "claims": [
        { "id": "age_18",     "path": ["age_equal_or_over", "18"] },
        { "id": "age_over_18","path": ["age_over_18"] }
      ],
      "claim_sets": [["age_18"], ["age_over_18"]]
    }]
  },
  "nonce": "<16 random bytes, base64url>",
  "jar_mode": "by_reference",
  "request_uri_method": "get",
  "response_mode": "direct_post.jwt",
  "profile": "openid4vp",
  "intended_use_id": "TEST-01",
  "issuer_chain": "<PEM: the EUDI test CAs UT 02 + EU 02>"
}
```

- **Only the age boolean is requested.** The reference page asked for `given_name` and
  `birthdate`; we never do. `claim_sets` lets the wallet answer with whichever form its PID uses:
  `age_equal_or_over.18` (current PID SD-JWT VC rulebook) or `age_over_18` (older profiles, and
  the ISO mdoc name).
- `issuer_chain`: Procivis' trial EUDI issuer (`CN=Procivis AG`) is signed by the EUDI test PKI's
  "PID Issuer CA - UT 02", which the public backend no longer trusts by default. We always add
  `https://preprod.pki.eudiw.dev/aia/PIDIssuerCA02-UT.cacert.pem` and `…EU.cacert.pem`, exactly as
  the reference's "Trust the EUDI test CAs" checkbox (on by default) does.

Answer: `{ transaction_id, client_id, request_uri, request_uri_method }`.

### 2. The QR code

`openid4vp://?client_id=<client_id>&request_uri=<request_uri>&request_uri_method=get`
(`client_id` is an `x509_hash:…` value). The phone talks only to the verifier backend, so our
server can stay on localhost.

### 3. Poll — events first, then the result

`GET /ui/presentations/{tx}/events` returns the transaction's event log. Polling the result
endpoint before the wallet answered makes the backend log "Verifier failed to get wallet", so,
like the reference, we filter that noise and look at the last event whose `actor` is `Wallet`
and which is not `Request object retrieved`:

| Last wallet event | Meaning | Our status |
|---|---|---|
| none | not scanned yet, or only fetched the request | `pending` |
| `Wallet response posted` | the backend **verified** the presentation (issuer signature, KB-JWT, nonce) → `GET /ui/presentations/{tx}` returns `vp_token` | read the boolean → `verified` or `not_over_18` |
| anything else (e.g. `IssuerCertificateIsNotTrusted`) | the backend refused it | `rejected` (+ cause) |
| result has no `vp_token` but an `error` | the user declined / no matching credential | `wallet_error` |

### 4. Reading the answer — and keeping nothing

`vp_token` is `{ "pid": ["<issuer-jwt>~<disclosure>~…~<kb-jwt>"] }`. Each disclosure is
base64url JSON `[salt, name, value]`. We resolve the SD-JWT the way the reference does
(digests of disclosures matched against `_sd`) and look up **only** `age_equal_or_over.18` or
`age_over_18`. It must be the boolean `true`.

**Stored**: the session status, `verified: 1|0`, and `evidence = keccak256(transaction_id)`.
**Never stored or logged**: the `vp_token`, any disclosure, any claim value. The decoded token
lives in one function's locals and is dropped.

### 5. Bind, then attestation

The website asks the Flex to sign a `Bind { verifier, session, expiresAt }` with 0xMAIN (tap).
`session` is the bytes32 our server generated for this age session and shown on the device. The
server checks: the signer is the claimed address, the session is `verified`, not yet bound, not
expired. It then signs, with `ISSUER_PRIVATE_KEY`, an EIP-712
`AgeAttestation { subject: 0xMAIN, claim: "age_over_18", issuedAt, expiresAt: +30 days,
evidence: keccak256(transaction_id) }` in the `BSA Verifier` domain, and marks the session bound
(once per session).

### 6. Delegation and payment

The Flex signs an `AgentDelegation` (0xMAIN, tap) authorising **its own** 0xAGENT to present that
attestation (by its EIP-712 hash). Both go onto the Flex with `STORE_CREDENTIALS`, which refuses a
bundle not signed by its own 0xMAIN or not naming its own 0xAGENT. When a merchant's x402 offer
has `extra.requires: ["age_over_18"]`, the bridge attaches them as
`paymentPayload.extensions.bsaAge`, and **our facilitator re-checks the whole chain itself**:
delegation signature → `delegation.agent == authorization.from` → not expired → claim present →
`delegation.attestation == hash(attestation)` → signed by our issuer → `subject ==` the delegation
signer → not expired.

## Mock mode

`EUDIW_MODE=mock` creates sessions that report `verified` on the first poll, never call the
backend, and say `"mode": "mock"` in every response, so it can never be mistaken for a real
verification. It is what the automated tests and the Speculos e2e use; the real wallet scan is
Phase C step M6-C.

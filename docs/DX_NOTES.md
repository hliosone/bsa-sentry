# Developer experience report — building BSA Sentry on the Ledger stack

**Team:** BSA (EPFL Blockchain Student Association) · **Event:** N3XT Hackathon @ OP3N 2026
**Device:** Ledger Flex (hw 009-1, SE 1.7.0, MCU 6.9.3, API level 27) · **Host:** Ubuntu 24.04 (KDE Neon)

## What we built, and with which primitives

BSA Sentry keeps an AI agent's spending rules **inside the secure element**. A custom Flex app
decides, per payment, between signing with no button press, asking on an orange 3-choice screen,
and refusing outright. The agent pays over x402 (USDC, EIP-3009) on Arc testnet.

| Ledger primitive | How we used it | Verdict |
|---|---|---|
| **`ledger_device_sdk` (Rust) + `app-boilerplate-rust`** | The whole device app: 11 custom APDUs, EIP-712 digests computed on-device, NVM policy storage | Works, but most of our lost time is here |
| **NBGL (via the `sys` C layout API)** | The 3-choice confirmation screen with a 60 s auto-refusal, which the safe wrappers cannot express | The single biggest gap |
| **`cargo-ledger` + `ledger-app-builder` Docker image** | Building the Flex ELF | Good once configured; two sharp edges |
| **`ledgerblue`** | Sideloading | Fine |
| **Speculos** | Every device test in CI: 57 integration tests, simulated taps, screenshots | Very good, one undocumented API |
| **DMK + `device-transport-kit-web-hid`** | Browser bridge over WebHID | Works well in the browser, not in Node |
| **Ledger Key Ring Protocol (LKRP)** | Encrypted backup of rules + credentials under the user's seed | See §6 |

We did **not** use the Agent Stack CLI or Ring CLI: our agent is a remote MCP server driven by
claude.ai, so the human-approval step had to happen in a browser tab over WebHID rather than on
the machine running the agent. §7 says what would have made them usable for us.

Entries marked *(feasibility)* were hit during our 10–11 Oct feasibility tests on the same Flex.

---

## 1. Rust device SDK

### 1.1 Derivation paths are baked in at build time, and the failure mode is a crash *(feasibility)*

**What happened.** We added `44'/60'` to `path` in `Cargo.toml`, rebuilt, installed — and the app
**crashed** the moment it derived a key.
**What we tried.** Rebuilding and reinstalling several times; the manifest looked correct.
**Root cause.** The SDK's `build.rs` bakes the install parameters in at compile time, and a cached
build silently reuses the old ones.
**Fix.** `cargo clean -p ledger_device_sdk --target flex --release` before building. You can tell it
worked because `install_params_size` changes in the build output.
**Suggestion.** Make `build.rs` depend on the manifest's `path` and `curve` keys so Cargo
invalidates it automatically — or fail the build with *"install params changed, run `cargo clean -p
ledger_device_sdk`"*. Shipping an app that crashes at runtime is the worst possible signal here.

### 1.2 The linker requires an empty `.data` section *(feasibility)*

**What happened.** Adding a `static mut Vec` broke the link with an error about `.data`.
**Fix.** Fixed-size, zero-initialised statics only. (A heap `Vec` *inside* a function is fine; it is
the non-zero static initialiser that is rejected.)
**Suggestion.** One line in the Rust SDK README next to the allocator setup, with the
"use a zero-initialised array" workaround. The linker error does not hint at the cause.

### 1.3 `StatusWords::BadLen` is `0x6E03`, not the ISO `0x6700`

**What happened.** We mapped our wrong-length error onto the SDK's `StatusWords::BadLen`, then our
host-side tests failed asserting `0x6700` (ISO 7816 "wrong length"). The SDK's value is `0x6E03`,
which in ISO terms is a CLA error.
**Fix.** We pin `0x6700` ourselves instead of reusing the SDK constant.
**Suggestion.** Document the non-obvious values in the `StatusWords` enum, or rename the variant.
An app author reaching for "BadLen" reasonably expects `0x6700`, and hosts map on these numbers.

### 1.4 The `io_new` `Command`/`Comm` borrow dance is undiscoverable

**What happened.** Our handlers took `(Command, &mut Comm)` so they could both read the payload and
draw a screen. That does not compile: `Command` already borrows `Comm` (`E0499`).
**What we tried.** Threading lifetimes, splitting the handler. All dead ends.
**Root cause.** The intended shape is `command.get_data()` → `command.into_comm()` → UI →
`comm.begin_response()`. Nothing in the docs says so; we found it by reading the boilerplate's own
`x402` handler.
**Suggestion.** Put that three-line sequence at the top of the `io_new` module docs, with a worked
example of "read a payload, show a review, reply". Also note that handlers have to be generic over
`const N: usize` to be callable from the main loop.

### 1.5 The boilerplate is a working app, not a starting point

**What happened.** `app-boilerplate-rust` ships `sign_tx`, `swap.rs`, `get_public_key` and a settings
page. For an app whose security claim is "there is no command that signs arbitrary data", the first
real task is **deleting** things — and `swap.rs` is entangled with `TxContext`, which the main loop
needs for the home screen.
**Suggestion.** Ship a `--minimal` variant (main loop + one APDU + home screen, no swap, no signing)
or a `cargo ledger new` template with the optional parts behind features. For any app making a
security argument, every line you did not delete is a line you have to audit.

---

## 2. NBGL — this is where the stack cost us the most

Our core UX is one screen: **three choices** (Refuse / Once / Trust this merchant) with a **60 s
auto-refusal**. The safe Rust wrappers offer two choices and no timeout, so we had to drop to the
C layout API for roughly 130 lines of `unsafe`.

### 2.1 No N-choice screen, and no timeout, in the safe API *(feasibility)*

**Suggestion.** An `NbglChoice3` (or an N-choice builder) with an optional
`timeout: Duration` that auto-rejects. Deny-by-default-after-N-seconds is the natural primitive for
*any* agent or automation use case, which is the entire theme of this hackathon.

### 2.2 The layout ticker pauses while the screen is touched *(feasibility)*

**What happened.** Our 60 s auto-reject, timed with NBGL's 1 s ticker callback, measured **155 s** of
wall clock while the screen was being touched.
**Fix.** Run our own event loop counting **raw `DecodedEventType::Ticker` events** (one per 100 ms;
600 = 60 s). Those keep arriving during touches.
**Suggestion.** Document that the layout ticker is paused during touch interaction, and expose a
monotonic millisecond counter. A screen whose job is to deny by default must not be timed by a clock
a finger can stop — that is a security property, not a cosmetic one.

### 2.3 A sixth line is drawn *underneath* the buttons rather than wrapped or clipped

**What happened.** Our screen had one line too many for the Flex's 600 px. NBGL did not scroll,
shrink or clip: it drew the extra line **behind the choice buttons**. The hidden line was
`"Corner bar" (unverified)` — the agent's unverified claim about the payee, i.e. exactly the line a
user needs in order to distrust a payment. Every APDU-level test passed; only a `/screenshot` caught it.
**What we tried.** Shortening strings twice; each time the text re-wrapped and the overflow moved.
There is no "did this fit?" query, and `nbgl_layoutAddText` returns a handle, not a height.
**Fix.** Budget the screen by hand — the Flex fits **five lines of ~26 characters** above two stacked
buttons, and a full EVM address takes two of them — then clip every host-supplied string.
**Suggestion.** Return the consumed height from `nbgl_layoutAdd*`, or expose
`nbgl_layoutGetRemainingHeight()`. Better: clip or scroll overflow instead of drawing it under later
elements, and panic on overflow in debug builds. Silently hiding text on a *confirmation* screen is a
security bug.

### 2.4 `HEADER_BACK_AND_TEXT` makes an invisible arrow tappable, not the text *(feasibility)*

**What happened.** The header text was drawn but taps on it did nothing; a narrow invisible strip on
the left responded instead.
**Fix.** `HEADER_RIGHT_TEXT` makes the whole header bar touchable. That is what our "Reject" uses.
**Suggestion.** Name the constants after their touch target, or document the touchable region per
header type. One screenshot per header constant in the docs would have saved an hour.

### 2.5 Blocking status screens answer `0x6901` to the next APDU *(feasibility)*

**What happened.** After a signature we showed `NbglStatus`. The next APDU came back `0x6901`
(`CmdNotAccepted`), which looks like a host framing bug.
**Fix.** Use the non-blocking variant (SDK `sys` feature) when the host sends commands back to back.
**Suggestion.** Say so in the `NbglStatus` docs, and return a status word meaning "a screen is
blocking, retry" rather than the generic `CmdNotAccepted`.

### 2.6 Settings switches cannot be RAM-only, and there is no change callback

**What happened.** Our "agent session" toggle must be **RAM-only**: restarting the app has to disarm
the agent. `NbglHomeAndSettings::settings()` drives switches straight from an NVM slot, and there is
no hook to observe a toggle.
**Fix.** First, zero the slot at every app start. In the end we dropped the wrapper (§2.7) and
keep the session in a RAM static toggled by our own callback.
**Suggestion.** Let `settings()` take an in-memory backing store, and expose an
`on_setting_changed(token, value)` callback. Right now a setting can only be a persisted boolean,
which rules out anything session-scoped.

### 2.7 A real app menu means leaving the safe API

**What happened.** We wanted the obvious menu: my rules (read-only list), trusted merchants (tap
to remove, with a confirmation), "+20 USDC", "Block agent". `NbglHomeAndSettings` only accepts a
page of switches, and its tagline is fixed at construction, so the home cannot show a live budget
without being rebuilt.
**Fix.** Call `nbgl_useCaseHomeAndSettings` directly with generic contents (switches, tag/value
list, bars), keep every C string and struct in a `static MaybeUninit` because NBGL holds the
pointers after the call returns, and confirm each action with a non-blocking `nbgl_useCaseChoice`
whose callback writes NVM and redraws. About 300 lines, most of it `unsafe` pointer fix-ups.
**Suggestion.** Expose `nbgl_genericContents_t` in the safe home builder (tag/value pages, bar
lists with a per-bar callback) plus a `refresh_tagline()`. Every app with state worth showing
needs this; the C SDK already has it.

---

## 3. Build and load toolchain

### 3.1 `cargo ledger build` defaults to a device you are probably not using *(feasibility)*

The default target is `apex_p`. Forget the explicit `flex` and you get a clean build for the wrong
device. **Suggestion:** require the target explicitly, or read a default from `ledger_app.toml`.

### 3.2 The builder image leaves root-owned artifacts, and breaks path dependencies

**What happened.** Two things, both at the Docker boundary. (a) `target/` comes back owned by `root`,
so the next host-side `cargo check` or `rm -rf target` fails. (b) The documented invocation mounts
only the app directory, so a Cargo **path dependency** (`core = { path = "../core" }`) is invisible
inside the container — and splitting pure logic into a host-testable crate is exactly what you want
for an app like ours.
**Fix.** Mount the parent directory and `-w` into the app, and `chown -R $HOST_UID:$HOST_GID target`
inside the container.
**Suggestion.** Make the image run as the invoking UID (or chown on exit), and show a workspace
layout with a host-testable `core` crate in the docs. Being able to `cargo test` the decision logic
on the host was the single most valuable thing we did — 88 host tests, no hardware.

### 3.3 Reinstalling wipes NVM, with no warning in the tooling

Expected once you know it, and it is *why* Key Ring backup matters — but `ledgerblue.runScript`
says nothing. **Suggestion:** print "this will erase the app's stored data" before installing over an
existing app.

---

## 4. Speculos — the best part of the stack

57 of our device tests run against Speculos in CI: simulated taps, screen assertions, screenshots,
a wiped-NVM restart between suites. It derives the same addresses as hardware from the same seed,
which let us build the entire product with the Flex unplugged. Two notes:

### 4.1 Swipes are undocumented, and Flex reviews need them

**What happened.** Automating `nbgl_useCaseReview`, taps did nothing. Flex reviews are paged by
**swiping** and confirmed by **holding**. The `/finger` endpoint documents `press`, `release` and
`press-and-release` with an `x`/`y`, and nothing else.
**Root cause, found by reading `speculos/api/finger.py`:** `press-and-release` also accepts
**`x2`/`y2`**, and the release point is what turns it into a drag.
**Suggestion.** Document `x2`/`y2` in the API docs and the Swagger schema, and add a first-class
`/swipe` (direction + duration) and `/hold` (duration). Every touch-device app has to rediscover
this to write CI tests.

### 4.2 Please keep `--display headless` + the REST API exactly as they are

Being able to drive the device from `fetch` with no GUI is what made our automated device tests
possible (73 now). Locating tap targets from `/events` coordinates (instead of hardcoded pixels) means a
layout change fails loudly. This is the piece we would most hate to lose.

### 4.3 NVM persistence across a restart is not implemented for Rust apps

**What happened.** To test that the rules survive an app restart (and the session does not), we
ran Speculos with `--load-nvram --save-nvram`. It exits at start: *"NVRAM data save and load
functionality is not yet implemented for Rust apps."* Restarting Speculos always starts from
blank NVM.
**Impact.** "The rules survive a restart" can only be checked on a real device, by hand.
**Suggestion.** Support it for Rust apps (the `.nvm_data` section is there), or document the
limitation next to the flags.

---

## 5. DMK

### 5.1 The ESM build does not load in plain Node *(feasibility)*

`import { DeviceManagementKitBuilder }` in a Node ESM script:
*"does not provide an export named 'DeviceManagementKitBuilder'"*. In the browser, Vite handles the
DMK with **no polyfills** — that part is genuinely smooth.
**Fix.** Keep DMK-importing Node code CommonJS.
**Suggestion.** Fix the ESM export map, or state the constraint at the top of the README. This is a
hard stop for anyone scripting the DMK outside a bundler, and the error does not point at the cause.

### 5.2 Node never exits after a DMK session *(feasibility)*

The `node-hid` handle keeps the event loop alive; every script needs `process.exit()`.
**Suggestion.** A `close()`/`dispose()` that releases transport handles, so scripts and test runners
can exit on their own.

### 5.3 The session refresher interleaves its own APDUs with yours

**What happened.** A custom app talks to the device with `dmk.sendApdu`, one command at a time,
some of which hold a 60 s screen. By default the DMK's session refresher also sends periodic
"get app and version" APDUs in the background. On a device that handles one command at a time,
those can land in the middle of an app's sequence (between chunks of a transfer, or while a
review is up).
**Fix.** `dmk.connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } })`, plus our
own single-flight queue and a 120 s `abortTimeout` on `sendApdu`.
**Suggestion.** Document the refresher next to `sendApdu` ("disable it if you drive your own app's
protocol"), or pause it automatically while a `sendApdu` is in flight.

### 5.4 `0x5515` deserves a typed error *(feasibility)*

Long runs started failing mid-way with `0x5515`: the Flex had auto-locked after ~2 minutes.
**Suggestion.** Surface it in the DMK as a `DeviceLockedError` with a message, rather than a raw
status word to look up. We ended up writing that mapping ourselves for every status word we care
about, which is the kind of thing a transport library should own.

### 5.5 The Node HID transport breaks silently under pnpm 10

**What happened.** For the hardware smoke test we use `@ledgerhq/hw-transport-node-hid` (the DMK
does not run in Node, §5.1). It depends on `node-hid` 2.1.2, whose native binary is downloaded by
an install script. pnpm 10 skips install scripts by default, prints one line about it, and the
failure only appears at runtime as a list of ten missing `HID.node` paths.
**Fix.** `onlyBuiltDependencies: [node-hid, usb]` in `pnpm-workspace.yaml`, then
`pnpm rebuild -r`. After that, a real Flex answered over USB on the first try.
**Suggestion.** Ship prebuilt binaries inside the package (as `usb` already does), or say so in
the README.

---

## 6. Key Ring (LKRP)

Wired as in our feasibility test: `@ledgerhq/ledger-key-ring-protocol` 0.24.0 +
`@ledgerhq/hw-transport-webhid` + `vite-plugin-node-polyfills`, application id 17.

- **It needs `vite-plugin-node-polyfills` while the DMK needs none.** Two Ledger browser libraries
  with opposite bundling requirements in one app is an unpleasant surprise; the polyfill need is not
  stated in the README.
- **`encryptUserData` takes bytes, not an object**, despite the TypeScript type saying otherwise.
  That is a type bug, and it costs a confusing runtime failure.
- **The Ledger Sync app must be open on the device**, so an app using both the DMK and Key Ring has
  to make the user switch apps and back, and must not hold both transports at once.
- **Two Ledger transports in one page.** The Key Ring SDK takes a legacy `hw-transport-webhid`
  transport, not a DMK session. So a DMK app has to *disconnect* the DMK, open a second transport
  to the same device for the Key Ring, close it, and reconnect the DMK. We wrote that dance with
  care (`apps/web/src/useBsa.ts`, `withKeyRing`); it is the most fragile part of the site.
  **Suggestion:** let `getSdk` accept a DMK session (or a DMK-backed transport adapter), so one
  connection serves both.
- **Switching apps from the browser is undocumented.** The DMK exports `OpenAppCommand` and
  `CloseAppCommand`, but nothing explains that `OpenApp` only works from the dashboard (so you must
  close the current app first), whether the device asks the user to confirm, or what happens to
  the DMK session when the app changes underneath it. We try it and fall back to telling the user
  which app to open. It cost us a real bug: our restore kept writing through the session object
  from before the switch. **Suggestion:** one worked example, "switch from your app to Ledger Sync
  and back", in the DMK docs, saying which objects survive the switch.
- **No way to test it in CI.** Ledger Sync does not run in Speculos, so every Key Ring path is
  untestable without hardware. We put the Key Ring behind an interface and test our flows with a
  fake that does real AES-GCM — but the LKRP integration itself only gets exercised on a real Flex.
  **Suggestion:** a Speculos-loadable Ledger Sync build, or a documented test mode of the LKRP SDK
  backed by a software member key.

*(The LKRP hardware run is Phase C step M7-C; results are recorded in `docs/PROGRESS.md`.)*

---

## 7. What we would have needed to use the Agent Stack / Ring CLI

Our agent is **claude.ai talking to a remote MCP server** — it has no access to the user's machine.
The human-approval step therefore has to happen in a browser tab over WebHID, next to the device.
The CLI tools assume the agent and the device share a host.

**Suggestion.** A documented pattern (or a small library) for *remote* agents: agent → your server →
a browser/desktop component next to the device → signer. That is the shape every hosted assistant
needs, and it is the one case the current tooling does not cover. It is most of what we built, and
we would rather not have had to.

---

## 8. Things we only learned by building end to end

- **The confirmation-screen budget is a security budget.** Between §2.2 (a finger stops the
  timeout clock) and §2.3 (overflowing text hidden under the buttons), both of our worst bugs were
  cases where the device *looked* right in every APDU-level test and was wrong for a human. Only
  screenshots caught them. A "lint my layout" tool for NBGL screens would pay for itself.
- **Silent signing is the feature that makes agents usable** — and the SDK makes it easy. What is
  missing is everything *around* it for this use case: a deny-by-default screen, a monotonic clock,
  and a documented pattern for a policy stored in NVM that only the device can change.

## The five changes we would ask for first

1. **An N-choice NBGL screen with a built-in timeout.** Deny-by-default is the core primitive for
   agent approval, and today it costs 130 lines of `unsafe`. (§2.1, §2.2)
2. **Do not draw overflowing text under the buttons** — clip, scroll, or fail loudly. On a
   confirmation screen this is a security bug, not a layout bug. (§2.3)
3. **Make the SDK rebuild when `path`/`curve` change**, instead of producing an app that crashes on
   first derivation. (§1.1)
4. **Document `x2`/`y2` on Speculos `/finger`** (and add `/swipe`), so touch-device apps can have
   CI. (§4.1)
5. **A supported pattern for remote agents** that need a device-backed approval on someone else's
   machine. (§7)

## What worked well, and we mean it

- **Speculos.** Headless + REST made a 57-test device suite possible, on a laptop, with the Flex
  unplugged. We would not have shipped this without it.
- **On-device EIP-712 from raw fields.** Our hand-rolled keccak digests matched `viem` and the live
  on-chain `DOMAIN_SEPARATOR` on the first try. The crypto primitives are solid and predictable.
- **Silent signing is possible and fast** (~1–1.8 s, 5/5), which is what lets "inside the rules, no
  button press" exist at all.
- **The DMK in the browser with plain Vite and no polyfills** is genuinely pleasant.
- **`AtomicStorage` NVM** behaved exactly as documented across app restarts.

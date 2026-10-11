# DX notes — friction with the Ledger developer tools

Mandatory hackathon deliverable. One entry per piece of friction: what happened, what we tried,
the fix, and one concrete suggestion. Entries from the feasibility tests (Oct 10–11) are marked
*(feasibility)*; the rest were hit while building BSA Sentry.

---

## 1. Derivation paths are baked in by the SDK's `build.rs` *(feasibility)*

**What happened.** We added `44'/60'` to `path` in `Cargo.toml`, rebuilt, installed — and the app
**crashed** the instant it derived a key on the new path.
**What we tried.** Rebuilding, reinstalling, re-reading the manifest docs. The manifest looked right.
**The fix.** `cargo clean -p ledger_device_sdk --target flex --release` before building. The SDK's
`build.rs` bakes the install parameters in at compile time, and a cached build reuses the old ones.
You can confirm it worked because `install_params_size` changes in the build output.
**Suggestion.** Make `build.rs` depend on the manifest's `path`/`curve` keys so Cargo invalidates
the SDK automatically — or fail the build with "install params changed, run `cargo clean -p
ledger_device_sdk`" instead of producing an app that crashes at runtime.

## 2. Blocking NBGL screens answer `0x6901` to incoming APDUs *(feasibility)*

**What happened.** After a signature we showed a status screen with `NbglStatus`. The next APDU
came back `0x6901` (`CmdNotAccepted`), which looked like a host framing bug.
**What we tried.** Longer host timeouts, resending, flushing the transport — all dead ends.
**The fix.** While a blocking SDK screen is up, the SDK refuses commands. Use the non-blocking
variant (SDK `sys` feature) when the host sends commands back to back.
**Suggestion.** Say so in the `NbglStatus` / review API docs, and return a status word that means
"a screen is blocking, retry" rather than the generic `CmdNotAccepted`.

## 3. The NBGL layout ticker pauses while the screen is touched *(feasibility)*

**What happened.** Our 60 s auto-reject, timed with NBGL's built-in 1 s ticker, measured **155 s**
of wall clock for "60 s" when the screen was being touched.
**What we tried.** Trusting the layout ticker; then instrumenting both clocks side by side.
**The fix.** Run our own event loop counting **raw `DecodedEventType::Ticker` events** (100 ms
each, 600 = 60 s). Those keep arriving during touches.
**Suggestion.** Document that the layout ticker is paused during touch interaction, and expose a
monotonic ms counter for security timeouts. A screen that must auto-reject is a safety feature;
it should not be timed by a clock that a finger can stop.

## 4. Only 2 choices, and no timeout, in the blocking review APIs *(feasibility)*

**What happened.** Our core UX needs **three** choices (Refuse / Once / Trust merchant) and a
60 s auto-reject. The SDK's blocking screens offer two buttons and no timeout.
**What we tried.** Chaining two 2-choice screens — bad UX, and still no timeout.
**The fix.** Build the screen with the **NBGL C layout API** and run our own event loop.
~130 lines of `unsafe` for what is a common pattern.
**Suggestion.** A safe Rust `NbglChoice3` (or an N-choice builder) with an optional
`timeout: Duration` that auto-rejects. Agent/automation use cases all need "deny by default
after N seconds".

## 5. `HEADER_BACK_AND_TEXT` makes an invisible arrow tappable *(feasibility)*

**What happened.** The header text was drawn but taps on it did nothing; a narrow invisible strip
on the left responded instead.
**The fix.** `HEADER_BACK_AND_TEXT` only makes its (undrawn) back arrow touchable.
`HEADER_RIGHT_TEXT` makes the whole header bar touchable — that is what "Refuser" uses.
**Suggestion.** Name the constants after their touch target, or document the touchable region per
header type. A screenshot per header constant in the docs would have saved an hour.

## 6. Ledger's linker rejects a non-empty `.data` section *(feasibility)*

**What happened.** Adding a `static mut Vec` broke the link with an error about `.data`.
**The fix.** Fixed-size, zero-initialised statics only — no `static Vec::new()`. (Heap `Vec` inside
a function is fine; it is the static initialiser that is rejected.)
**Suggestion.** Mention it in the Rust SDK README next to the allocator setup, with the
"use a zero-initialised array" workaround.

## 7. The DMK's ESM build does not load in plain Node *(feasibility)*

**What happened.** `import { DeviceManagementKitBuilder }` in a Node ESM script:
*"does not provide an export named 'DeviceManagementKitBuilder'"*.
**The fix.** Keep DMK-importing Node code **CommonJS** (no `"type": "module"`). In the browser,
Vite handles it fine with no polyfills.
**Suggestion.** Fix the ESM export map, or state the constraint at the top of the DMK README. This
one is a hard stop for anyone scripting the DMK outside a bundler, and the error message does not
point at the cause.

## 8. Node never exits after a DMK session *(feasibility)*

**What happened.** Every host script hung after finishing.
**The fix.** The `node-hid` handle keeps the event loop alive; call `process.exit()`.
**Suggestion.** Give the DMK a `close()`/`dispose()` that releases the transport handles, so
scripts and test runners can exit on their own.

## 9. `0x5515` with no explanation when the device auto-locks *(feasibility)*

**What happened.** Long host test runs started failing mid-way with `0x5515`. The Flex had
auto-locked after ~2 minutes.
**The fix.** Disable auto-lock on the device during development (first step of our Phase C guide).
**Suggestion.** Surface `0x5515` in the DMK as a typed `DeviceLockedError` with a message, rather
than a raw status word the developer has to look up.

## 10. A sixth line on a custom NBGL layout is drawn *under* the buttons, not wrapped

**What happened.** Our 3-choice payment screen (NBGL C layout API: header + `nbgl_layoutAddText`
+ `nbgl_layoutAddChoiceButtons`) showed one line too many for the Flex's 600 px. NBGL did not
scroll, shrink or clip it: it drew the extra line **behind the buttons**. The line it hid was
`"Bar du coin" (non verifie)` — the agent's unverified claim about the payee, which is precisely
the line a user needs in order to distrust a payment. Nothing in the API reported a problem, and
the APDU-level tests all passed: only looking at a `/screenshot` revealed it.

**What we tried.** Shortening the strings twice. Each time the text re-wrapped and the overflow
simply moved. There is no "did this fit?" query, and `nbgl_layoutAddText` returns an `int` that
is a layout handle, not a height.

**The fix.** Budget the screen by hand: the Flex fits **five lines of ~26 characters** above two
stacked choice buttons, and a full EVM address takes two of them. We now clip every
variable-length string (`fmt::clip`) so the total can never exceed five lines, and we assert on
the rendered text in a Speculos test.

**Suggestion.** Make `nbgl_layoutAddText` (and friends) return the Y they consumed, or expose a
`nbgl_layoutGetRemainingHeight(layout)`. Even better, clip or scroll overflowing content instead
of drawing it under later elements: silently hiding text on a *confirmation* screen is a security
problem, not a cosmetic one. A debug build that panics on overflow would have caught this in
seconds.

## 11. Speculos drives Flex reviews by swiping, and the gesture is undocumented in the REST API

**What happened.** Automating `nbgl_useCaseReview` on Speculos, taps on the obvious places did
nothing. The review is paged by **swiping** and confirmed by **holding** the final button, and
the `/finger` endpoint documents only `press`, `release` and `press-and-release` with an `x`/`y`.

**What we tried.** Tapping every plausible coordinate for the "Continue" area. Ten taps, no
page change.

**The fix.** Reading `speculos/api/finger.py`: `press-and-release` also accepts **`x2`/`y2`**, and
the release point is what makes it a drag. So a swipe is
`{action:"press-and-release", x:240, y:300, x2:60, y2:300}`, and a hold is a separate `press`,
a sleep, then a `release`. We drive every review from the coordinates reported by `/events`
rather than hardcoded pixels, so a layout change fails loudly instead of tapping nothing.

**Suggestion.** Document `x2`/`y2` in the Speculos API docs and the Swagger schema, and add a
first-class `/swipe` (direction + optional duration) plus a `/hold` with a duration. Every app
with a touch review has to rediscover this to write CI tests.

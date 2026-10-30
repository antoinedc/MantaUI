# Session catch-up pill + held send

Status: agreed with the owner 2026-10-30 (option "C" of the design exploration),
revised after spec review (DeepSeek V4.1 Flash, see "Review log" at the end).
Design artifact: `docs/session-catch-up/mockup.html` — **the source of truth for
every visual value**. Its PART 1 CSS ships verbatim; its PART 2 lists the exact
Tailwind class strings; PART 3 is context only.

## Problem

A chat panel stops applying transcript updates while it is not the visible one
(it only remembers that a refetch is owed). When the user switches back to a
session that kept working, the transcript from when they left renders at once
and the "catch-up" fetch runs, but nothing on screen says so: for that moment
it looks like the agent did nothing. Catch-up failures are also silent today
(the fetch's error is swallowed and the stale transcript just stays).

## Behaviour

### B1. What "catching up" is

- A panel is **catching up** from the moment it becomes active with a refetch
  owed from its inactive period, until that catch-up fetch settles.
- The catch-up fetch runs **immediately** on activation (no 300 ms debounce),
  with the same tail/full options the ordinary refetch uses. Starting it
  cancels any pending ordinary-refetch timer (the catch-up supersedes it).
- Only this activation-owed fetch counts. Ordinary refetches while the panel is
  active, the first transcript load (it already has a full-panel loader) and
  the events-reconnect `resync` refetch are NOT catch-ups.
- Catch-up state is per panel: `idle | catching | failed`.
- **Scoping (generation guard).** Each catch-up captures a generation token.
  Its result is applied ONLY if, when it resolves, the token is still current,
  the panel is still active and the session id is unchanged. Deactivation,
  session change and a newer catch-up all bump the generation. A discarded
  result applies nothing (no `setMessages`, no pill, no hold release) and
  leaves the refetch owed. The ordinary refetch shares the same rule for its
  own timer: a timer that fires while the panel is inactive marks the refetch
  owed instead of fetching.

### B2. The pill

One pill at the bottom-centre of the transcript region, the same anchor as the
jump-to-latest button. **While the pill is shown, the jump-to-latest button is
not** (the pill takes its place); it comes back when the pill goes.

| State | When | Content |
|---|---|---|
| catching | `catching` for ≥ 200 ms and no held send | spinner + "Catching up…" |
| held | `catching` and a send is held (shown immediately, no 200 ms wait) | spinner + "Catching up… · will send when ready" + **Cancel** |
| error | catch-up failed | "Couldn't load the latest steps" + **Retry** (danger tone, Retry also danger) |

- A fast catch-up (< 200 ms) never shows the pill.
- Once caught up the pill simply goes; there is no "N new steps" follow-up
  (removed 2026-10-30 at the owner's request — the new steps are visible in
  the transcript itself).
- **error** stays until: Retry succeeds, a later full refetch for the session
  succeeds, or the panel is deactivated. Retry re-runs the catch-up fetch
  (state → `catching`, a fresh 200 ms timer).
- Accessibility: the pill is `role="status"`
  `aria-live="polite"`. Cancel / Retry are real `<button>`s.
  Reduced motion: no spin, no slide/fade (PART 1 + `motion-reduce:` handle it).

### B4. Held send

The composer stays fully usable during catch-up: typing, attachments, mic,
model / effort / Plan pickers, slash popup — nothing is disabled.

**Which submits are held.** Exactly the submits that arrive through the
Composer's `submit` and `onSubmitAfterTurn` props (Enter, ⌥Enter, the Send
button, and the composer's voice "send", which calls the same `submit` prop).
ChatPanel passes the Composer a hold-aware wrapper; every ChatPanel-internal
programmatic call (`submitRef.current?.(…)`: the `/clear` bridge, the
auto-submit first prompt, the voice-note retry, quote bridges) keeps calling
the raw `submit` and is **never** held. The decision is by call path, never by
inspecting `textOverride`.

- A held-path submit while `catching` does **not** send. It records a hold
  `{ textOverride, attachmentsOverride, delivery }` exactly as received.
  Enter/Send → `delivery` undefined; ⌥Enter → `"queue"`. To make that true
  while idle, InputArea's ⌥Enter handler always calls `onSubmitAfterTurn()`
  when it is provided (idle, `submit` already ignores `delivery`, so the
  idle behaviour is unchanged).
- While held: the Send button renders as the held variant (Design below) with
  `aria-label` / `title` "Waiting to send — click to cancel"; clicking it
  cancels the hold. Its render gate becomes `input.trim() || sendHeld`. The
  pill shows the held state with Cancel. A further held-path submit while held
  is a no-op (one hold at a time; a later ⌥Enter does not change it).
- Cancel (pill or held Send): drops the hold, keeps the text; the pill reverts
  to the plain catching state (immediately if ≥ 200 ms elapsed, else after).
- Catch-up **succeeds** with a hold → after the fresh transcript is committed
  (an effect, not inside the fetch callback), the hold is released by calling
  the **latest** raw `submit` (via ref, so it reads the current `running`,
  `input`, attachments, model, plan, background box) with the recorded args.
  With no `textOverride`, whatever is in the composer at that moment is what
  is sent, with all of `submit`'s normal validation; its errors surface the
  usual way. Empty composer → nothing is sent.
- Catch-up **fails** with a hold → nothing is sent, the hold is dropped, the
  text stays, and the existing send-error strip shows exactly:
  "Not sent: couldn't load the latest steps. Retry, or press Enter to send
  anyway." (`setSendError`). While `failed`, held-path submits send
  **normally** (no hold) — that is the "send anyway".
- Panel deactivated or session changed while held → hold dropped silently,
  text stays in that panel's composer.
- "Run in background" ticked: held the same way, released through the same
  `submit`. The held variant keeps the background button's wide shape (Design).

### B5. `useTranscriptState` contract (names are binding)

- `catchUpStatus: "idle" | "catching" | "failed"` (state).
- `catchUp(): Promise<{ ok: true; before: OpencodeMessage[] | null; after: OpencodeMessage[] } | { ok: false; stale?: true }>`
  — cancels the pending ordinary-refetch timer, clears the owed flag, sets
  `catching` and `refreshing` (same as an ordinary refetch, so the composer's
  existing refreshing border behaves the same), fetches now, and on a current
  (B1) success applies the result exactly like the ordinary refetch does
  (child-session collection included) and sets `idle`. On failure: status
  `failed`, owed re-marked, transcript kept. A stale result → `{ok:false,
  stale:true}`, nothing applied, owed re-marked. `refreshing` is cleared in
  every case.
- `resetCatchUp()` — bumps the generation, status → `idle`, and re-marks the
  refetch owed unless the last catch-up succeeded. Called on deactivation and
  on session change.
- A successful ordinary full refetch while `failed` sets status `idle`.
- CtoChat also uses this hook: everything above must be inert unless
  `catchUp()` is called (CtoChat never calls it; its behaviour is unchanged).

### B6. What does not change

- Running-state, inbox, questions, permissions handling. (`running` frames are
  already applied while the panel is hidden; the hold exists so the user sees
  what happened before replying and so the reply lands after it in order.)
- The first-load full-panel loader, the jump-to-latest button styling,
  CtoChat, the iOS app, the reactivation re-pin to tail.

## Design (exact)

- Pill: the `.manta-catchup-pill` family from mockup PART 1, added verbatim to
  `src/renderer/index.css` right after the `.manta-jump-latest` rules.
  Attribute: `data-tone="error"` (absent = neutral).
- Spinner (pill + held Send): exactly
  `w-3 h-3 shrink-0 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none`
  with `aria-hidden="true"`.
- Held Send button (square variant): the normal Send box with the fill swapped —
  `w-7 h-7 rounded-sm grid place-items-center shrink-0 transition-colors bg-raised text-accent-tx hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`,
  spinner inside.
- Held Send button (background variant, "Run in background" active): the
  existing wide background-button classes unchanged, content = spinner +
  "Waiting…" (gap `gap-1`, `inline-flex items-center`).
- Failed + held message: the existing ChatPanel `send-error` strip, unchanged.
- Copy exactly as in B2 / B4 (the ellipsis is the single "…" character).
- No new design tokens: everything maps to existing ones (`--card`,
  `--border`, `--shadow-md`, `--r-full`, `--r-xs`, `--sp-*`,
  `--font-size-xs`, `--tx2`, `--accent-tx`, `--accent`, `--danger`,
  `--danger-rgb`, `--motion-*`, `--ease-out`, `--raised`, `--fill-hover`).
  `bg-raised` has no alpha channel — never use `bg-raised/NN`.

## Code placement

- `src/renderer/hooks/useTranscriptState.ts` — B5.
- `src/renderer/hooks/useCatchUp.ts` (new) — hold state, pill state, the
  200 ms and 2400 ms timers, release effect, the hold-aware composer submit
  wrappers. ChatPanel only wires it.
- `src/renderer/CatchUpPill.tsx` (new) — the pill, rendered in the transcript
  region wrapper next to the jump-to-latest button.
- `src/renderer/chatUtils.ts` — `describeCatchUpPill({ state })` returning
  `{ label, tone, action }` (pure, tested).
- `src/renderer/ChatPanel.tsx` — reactivation effect calls `catchUp()`
  instead of `scheduleRefetch()` when owed; deactivation/session change calls
  `resetCatchUp()` and drops the hold; passes the wrappers + `sendHeld` /
  `onCancelHeldSend` to Composer; hides jump-to-latest while the pill shows.
- `src/renderer/Composer.tsx` / `src/renderer/InputArea.tsx` — `sendHeld?`
  and `onCancelHeldSend?` props; held Send variants; render gate;
  ⌥Enter always calls `onSubmitAfterTurn` when provided.
- `src/renderer/index.css` — PART 1 CSS.

## Libraries considered

None. This is a small status surface built from existing primitives (the
jump-to-latest floating surface, the pending-card spinner, the send-error
strip). Toast libraries (sonner, react-hot-toast) were considered and
rejected: the pill is anchored to the transcript, not the window, carries
in-place actions tied to panel state, and the app already has its own toast
system for window-level messages.

## Tests (required)

- `chatUtils.test.ts`: `describeCatchUpPill` (every B2 row).
- Hook tests (`useTranscriptState`): success applies + idle; failure keeps
  transcript + `failed` + owed; result discarded after deactivation / session
  change / newer catch-up (nothing applied, owed kept); ordinary refetch clears
  `failed`; ordinary timer firing while inactive marks owed; CtoChat-style use
  without `catchUp` is unchanged.
- Behaviour tests (RTL, in the style of `ChatPanel.*.test.tsx`): pill only
  after 200 ms; held pill immediately; jump-to-latest hidden while the pill
  shows; Enter while catching holds, released through submit after success
  (idle path and busy path with the held delivery, incl. ⌥Enter → `"queue"`);
  release into an empty composer sends nothing; Cancel via
  pill and via held Send; failed + held shows the exact send-error copy and
  sends nothing; Enter while `failed` sends normally; deactivation drops the
  hold; the `/clear` bridge is NOT held during catch-up; Retry re-runs the
  fetch; the pill goes once caught up.

## Review log

DeepSeek V4.1 Flash review (2026-10-30), all accepted: hold decided by call
path not `textOverride` (the `/clear` bridge and voice-note retry go through
`submitRef` with no override); ⌥Enter idle now routes through
`onSubmitAfterTurn`; owed flag re-marked on any non-success; generation guard
for in-flight results; ordinary timer re-checks activity; count includes
background results and any role; suffix only when something was sent; no
arrow on the new pill (the "new steps" pill itself was later removed); label `min-width:0`; Retry in danger tone; background
variant of the held Send; `refreshing` behaviour stated; five extra tests.

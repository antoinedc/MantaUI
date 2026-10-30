# Session catch-up pill + held send

Status: agreed with the owner 2026-10-30 (option "C" of the design exploration).
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
  with the same tail/full options the ordinary refetch uses.
- Only this activation-owed fetch counts. Ordinary refetches while the panel is
  active, the first transcript load (it already has a full-panel loader) and
  the events-reconnect `resync` refetch are NOT catch-ups.
- Catch-up state is per panel: `idle | catching | failed`.

### B2. The pill (replaces nothing, adds a floating status)

One pill at the bottom-centre of the transcript region, the same anchor as the
jump-to-latest button. **While the pill is shown, the jump-to-latest button is
not** (the pill takes its place); it comes back when the pill goes.

| State | When | Content |
|---|---|---|
| catching | `catching` for ≥ 200 ms and no held send | spinner + "Catching up…" |
| held | `catching` and a send is held (shown immediately, no 200 ms wait) | spinner + "Catching up… · will send when ready" + **Cancel** |
| new | catch-up succeeded and N ≥ 1 new steps arrived | "↓ N new step(s)" + optional suffix (below). Whole pill is a button |
| error | catch-up failed | "Couldn't load the latest steps" + **Retry** (danger tone) |

- **new** suffixes: held send went into a running turn → " · your message was
  sent into the running turn"; held send started a new turn → " · your message
  was sent"; no held send → no suffix. Singular "1 new step".
- **new** dwell: visible 2400 ms, then `data-leaving="true"` (fades over
  `--motion-slow`), then unmounted. Hover or keyboard focus pauses the dwell;
  leaving restarts it. Clicking scrolls to the **first new message** using the
  existing message-scroll path (which already detaches follow) and dismisses
  the pill. If N = 0 the new pill is not shown at all (even with a held send —
  the sent message is visible in the transcript / pending card).
- A fast catch-up (< 200 ms) never shows the "Catching up…" pill, but still
  shows the "new" pill when N ≥ 1.
- **error** stays until: Retry succeeds, a later full refetch for the session
  succeeds, or the panel is deactivated. Retry re-runs the catch-up fetch
  (state → `catching`). On deactivation with state `failed`, the refetch is
  marked owed again so the next activation retries.
- Accessibility: catching/held/error pills are `role="status"`
  `aria-live="polite"`; the new pill is a `<button>` with
  `aria-label="Show N new step(s)"`. Cancel / Retry are real buttons.
  Reduced motion: no spin, no slide/fade (PART 1 already handles this).

### B3. "New steps" count

Pure helper `countNewSteps(before, after)` in `src/renderer/chatUtils.ts`:
the number of parts in `after` that (a) belong to an assistant message,
(b) are of type `"tool"` or a `"text"` part with non-empty trimmed text,
and (c) whose part id is not present anywhere in `before`. The first new
message = the message containing the first such part in transcript order
(helper `firstNewStepMessageId(before, after)` → id or null). `before` is the
transcript at the moment catch-up started.

### B4. Held send

The composer stays fully usable during catch-up: typing, attachments, mic,
model / effort / Plan pickers, slash popup — nothing is disabled.

- Pressing Enter, ⌥Enter, or the Send button while `catching` does **not** send.
  It records a **hold** `{ delivery? }` (Enter/Send → undefined i.e. the
  normal path; ⌥Enter → `"queue"`). The text stays in the composer and remains
  editable.
- While held: the Send button renders as the held variant (spinner, PART 2
  classes) with `aria-label` / `title` "Waiting to send — click to cancel";
  clicking it cancels the hold. The pill shows the held state with Cancel.
  Enter / ⌥Enter / Send again while held: no-op (one hold at a time; a later
  ⌥Enter does NOT change the held delivery).
- Cancel (pill or held Send): drops the hold, keeps the text, pill reverts to
  the plain catching state (shown immediately if ≥ 200 ms elapsed, else after).
- Catch-up **succeeds** with a hold → after the fresh transcript is committed,
  the hold is released by calling the **latest** `submit` (via a ref, so it
  reads the current `running`, `input`, attachments, model, plan) with the held
  `delivery`. Whatever is in the composer at that moment is what is sent, with
  all of `submit`'s normal validation (uploading attachments, unsupported
  media, busy-send refusals for local commands, etc.) — its errors surface the
  usual way. If the composer is empty at release, nothing is sent.
- Catch-up **fails** with a hold → nothing is sent, the hold is dropped, the
  text stays, and the existing send-error strip shows:
  "Not sent: couldn't load the latest steps. Retry, or press Enter to send
  anyway." (`setSendError`). While `failed`, Enter / Send / ⌥Enter send
  **normally** (no hold) — that is the "send anyway".
- Panel deactivated while held → hold dropped silently, text stays in that
  panel's composer.
- Holds apply only to the composer's own submits (Enter, ⌥Enter, Send button,
  and the voice "send" action, which goes through the same `submit`).
  Programmatic submits with a `textOverride` from bridges (quote-to-new-session,
  `/clear` bridge, etc.) are not held.
- Background runs ("Run in background" ticked) are held the same way and
  released through the same `submit`.

### B5. What does not change

- Running-state, inbox, questions, permissions handling. (`running` frames are
  already applied while the panel is hidden; the hold exists so the user sees
  what happened before replying and so the reply lands after it in order.)
- The first-load full-panel loader, the jump-to-latest button styling,
  CtoChat (which shares `useTranscriptState` but gets no catch-up UI — the
  new hook API must be inert unless used), the iOS app.

## Design (exact)

- Pill: `.manta-catchup-pill` family from mockup PART 1, added verbatim to
  `src/renderer/index.css` right after the `.manta-jump-latest` rules.
  Attributes: `data-tone="new" | "error"` (absent for neutral),
  `data-leaving="true"` during fade.
- Spinner (pill + held Send): exactly
  `w-3 h-3 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none`
  (the PendingMessagesCard spinner, at 12 px).
- Held Send button: the normal Send box with the fill swapped —
  `w-7 h-7 rounded-sm grid place-items-center shrink-0 transition-colors bg-raised text-accent-tx hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`.
  It is shown whenever a hold exists (even if the text was edited to empty);
  otherwise the normal Send rules apply. Stop button unchanged.
- Failed + held message: the existing ChatPanel `send-error` strip, unchanged.
- Copy is exactly as in B2 / B4 (ellipsis is the single "…" character).
- No new design tokens are needed; all values map to existing ones
  (`--card`, `--border`, `--shadow-md`, `--r-full`, `--sp-*`,
  `--font-size-xs`, `--tx2`, `--accent-tx`, `--accent`, `--danger`,
  `--danger-rgb`, `--motion-*`, `--ease-out`, `--raised`, `--fill-hover`).

## Implementation notes (contract between pieces)

- `useTranscriptState` gains (names are binding):
  - `catchUpStatus: "idle" | "catching" | "failed"` (state)
  - `catchUp(): Promise<{ ok: true; before: OpencodeMessage[] | null; after: OpencodeMessage[] } | { ok: false }>`
    — runs the fetch now, sets status, applies the result exactly like the
    ordinary refetch does (child-session collection included), clears the
    owed flag; on failure sets `failed` and keeps the transcript.
  - `resetCatchUp()` — status → `idle`; if it was `failed`, marks the refetch
    owed again. Called on deactivation.
  - A successful ordinary full refetch while `failed` sets status `idle`.
- ChatPanel's reactivation effect calls `catchUp()` instead of
  `scheduleRefetch()` when the refetch is owed. Hold state, pill state and the
  200 ms / 2400 ms timers live in ChatPanel (or a small dedicated hook, e.g.
  `src/renderer/hooks/useCatchUp.ts`, preferred to keep ChatPanel from
  growing). Pill copy comes from a pure, tested helper
  `describeCatchUpPill(...)` in `chatUtils.ts`.
- Composer / InputArea get `sendHeld?: boolean` and `onCancelHeldSend?: () => void`
  props. When `sendHeld` the Send button renders the held variant and its click
  calls `onCancelHeldSend`. The hold decision itself is in ChatPanel's
  `submit` wrapper (InputArea keeps calling `submit()` / `onSubmitAfterTurn()`).
- The pill component lives in its own file `src/renderer/CatchUpPill.tsx`,
  rendered inside the transcript region wrapper next to the jump button.

## Libraries considered

None. This is a small status surface built from existing primitives (the
jump-to-latest floating surface, the pending-card spinner, the send-error
strip). Toast libraries (sonner, react-hot-toast) were considered and
rejected: the pill is anchored to the transcript, not the window, carries
in-place actions tied to panel state, and the app already has its own toast
system for window-level messages.

## Tests (required)

- `chatUtils.test.ts`: `countNewSteps`, `firstNewStepMessageId`,
  `describeCatchUpPill` (every row of the B2 table + suffixes + singular).
- Hook tests for `catchUp` / `resetCatchUp` / status transitions (success,
  failure keeps transcript, owed re-marked after failed deactivation, ordinary
  refetch clears `failed`).
- Behaviour tests (React Testing Library, in the style of the existing
  `ChatPanel.*.test.tsx` harness): pill appears only after 200 ms; held send is
  released through submit after success with the held delivery; Cancel; failed
  + held shows the send-error copy and does not send; Enter while `failed`
  sends normally; deactivation drops the hold; new pill click scrolls to the
  first new message; jump-to-latest hidden while pill shown.

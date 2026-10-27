# Handoff card: inline placement, dismiss, nicer copy, per-session mode

Follow-up to `2026-10-26-auto-handoff.md`. Desktop renderer + box server. The
native iOS client is NOT changed here (it keeps working; see §6).

## 1. Placement — the card scrolls with the transcript

- The server-path handoff card (today `PinnedHandoffCard`, pushed into the
  pinned `CardStack` above the composer as ambient card `handoff-<id>`) moves
  into the **transcript tail** (`Transcript.tsx` footer), rendered **right after
  the todo checklist** (`ActiveTodos`) and before question cards / plan card.
  If there are no todos it sits where the todos would be.
- It is removed from `CardStack` entirely (drop the `handoff` entry from
  `AMBIENT_CARD` and the `handoff.pinned` loop in `cards`).
- New Transcript prop `handoffCards?: React.ReactNode` (mirrors
  `backgroundCards` / `planCard`, wrapped in an `ErrorBoundary`). ChatPanel
  builds it with `useMemo` over `handoff.pinned` so streaming deltas don't
  re-render the tail.
- The agent-path card (the `handoff` tool part inline in a message) is
  unchanged in placement.

## 2. Body — no scrollbar; clamp with Show more / Show less

- The body is never inside a scroll container (no `max-h` + `overflow-y-auto`
  anywhere around it).
- Collapsed: clamp the rendered markdown to ~6 lines (`maxHeight` + fade mask),
  exactly the `ClampedResultText` technique in `BackgroundCards.tsx`
  (measure overflow with ResizeObserver; offer the toggle only when it overflows).
  Toggle text: "Show more" / "Show less", same style as the background card.
  Prefer extracting `ClampedResultText` into a shared component (e.g.
  `ClampedMarkdown.tsx`) with a `lines`/height prop and a `testId` prop and
  reusing it in both places, rather than copying it. Keep existing
  `background-result-text` / `background-result-toggle` test ids working.
- `collapseHandoffText` (line-count slicing) is no longer used by the card;
  delete it and its tests if nothing else uses it.
- Action buttons are always visible (they are in the card footer, outside the
  clamped body) in every state where they exist today.

## 3. Copy confirmation

- On a successful copy the "Copy" button's label is replaced in place by an
  animated check icon (lucide `Check`, short scale/fade-in, respects
  `prefers-reduced-motion`) for ~1.5 s, then reverts to "Copy". The button
  keeps its width (no layout jump) and gets `aria-label="Copied"` while showing
  the check.
- No "Copied to the clipboard" notice line anymore. A copy FAILURE still shows
  the error notice line (never-stub rule).

## 4. Dismiss

### Behaviour
- Every handoff card in state `ready` or `failed` has a dismiss control: an `×`
  icon button at the right of the card header (`aria-label="Dismiss handoff"`,
  title "Dismiss — don't suggest a handoff again in this session").
- Dismissing (a) hides that card, and (b) marks the **session** dismissed. While
  a session is dismissed, nothing *unasked* is proposed or started in it:
  - no automatic trigger at turn end, in either `suggest` or `auto` mode;
  - an agent `handoff` tool call (either action) does not create a card or
    start anything (see error below);
  - the optimizer plugin's budget note sees the session as mode `off`
    (`policyFor` reports `mode: "off"`), so it stops nudging the agent.
- Explicit user requests still work: `/handoff [goal]` and the "Hand off"
  button create a card as today. Doing so does NOT clear the dismissal.
- The dismissal is per session and never carried over: a session created by
  `/clear` or by a handoff (replacement or branch) starts undismissed.
- Pressing dismiss awaits the server; on failure the card stays and shows the
  error notice.

### Server
- New record state `"dismissed"` (terminal: add to `TERMINAL_STATES`, to the
  `HandoffState` union, and anywhere states are enumerated). Clients must not
  render a dismissed record as a pinned card (`selectPinnedHandoffs`).
- Engine `dismiss(id)`: only from `ready` or `failed` → else
  `HandoffError("not_ready", "This handoff can no longer be dismissed.")`;
  unknown id → `expired`. Sets record `state = "dismissed"`, sets
  `state.dismissedSessions[fromSessionId] = <now>` (persisted in
  `handoffs.json`; old files without the key load fine), persists, publishes
  the normal `handoff` bus event. Returns the public record.
- `maybeAuto`: return early when the session is dismissed.
- `create` with `trigger: "agent"` on a dismissed session: throw
  `HandoffError("dismissed", "The user dismissed handoff suggestions in this conversation. Do not suggest a handoff again unless the user asks.")`
  — new error code `dismissed` → HTTP 409 in `ERROR_STATUS`. The agent tool
  relays this message to the model.
- Session deletion: drop its `dismissedSessions` entry (housekeeping, alongside
  the existing `session.deleted` handling).
- rpc channel `handoff:dismiss` `{ id } → { handoff }`; REST equivalent in
  `handoffRoute.mjs` following the existing start/retry route shape.
- `list({sessionId})` adds `dismissed: boolean` to `HandoffSessionInfo`.

### Renderer
- `window.api.handoffDismiss({ id })` in `src/shared/api.ts` + `httpApi.ts`
  (+ demo/coverage lists that enumerate api methods, e.g. `demoCoverage.test.ts`).
- `dismissHandoff(id)` in `handoffActions.ts`; after success refresh the
  session (`loadSession`) so the card disappears.
- Agent-path (inline tool-part) card once dismissed: collapse to a single faint
  line "Handoff dismissed" (no actions).

## 5. Per-session handoff mode

### Behaviour
- The handoff mode (`auto` / `suggest` / `off`) is a property of each session.
  Changing it in one session never changes any other session.
- A session without its own value uses the **box default** — the existing
  config key `handoffMode`. The composer toggle no longer writes the config key.
- **The box default becomes `"suggest"`** (was `"auto"`):
  - `DEFAULT_CONFIG.handoffMode` in `src/server/local.mjs` → `"suggest"`; the
    renderer store's initial/fallback value and `normalizeMode` fallbacks that
    mean "the default" → `"suggest"` (server `policy.mjs` + renderer
    `handoff.ts`; check each fallback is about the default, not about parsing).
  - One-time migration for boxes that already run auto-handoff:
    `migrateHandoffModeDefault(raw)` in `src/shared/configMigration.mjs`, same
    shape as `migrateCacheTtlDefault` (pure, idempotent, self-marking with
    `handoffModeDefaultMigrated: true`): on first load sets
    `handoffMode = "suggest"` regardless of the stored value (the feature is
    one day old; any stored `"auto"` is the old default). After the marker is
    set, never touched again. Wired in `local.mjs` `getConfig` next to the
    cache-TTL migration, and the migrated config is persisted on first load
    (or on next save — either is fine as long as the marker and value are
    written together).
- A successor created by a handoff (replacement or branch) inherits the
  predecessor's *effective* mode at commit time (stored explicitly on the
  successor). A session created by `/clear` or any other path does not inherit;
  it uses the box default.

### Server
- Engine state `sessionModes: { [sessionId]: HandoffMode }` persisted in
  `handoffs.json` (tolerate absence). Entry dropped on `session.deleted`.
- `modeFor(sid)` = `sessionModes[sid] ?? normalizeMode(await getMode())`, where
  `getMode` stays the box-default reader. Every current use of `getMode()` for
  a session decision (`create`, `maybeAuto`, `policyFor`) uses `modeFor(sid)`.
- Engine `setMode(sessionId, mode)` (validates via `HANDOFF_MODES`, else
  `invalid`); persists; publishes a `handoff` bus event is NOT required — the
  client that set it updates locally.
- On successful commit of a replacement or branch, set
  `sessionModes[successorId] = await modeFor(fromSessionId)` (only if the
  successor has no explicit value yet).
- rpc `handoff:set-mode` `{ sessionId, mode } → { mode }` + REST equivalent.
- `list({sessionId})` adds `mode: HandoffMode` (effective) and
  `modeIsDefault: boolean` to `HandoffSessionInfo`.
- Idle compaction (`index.mjs`, optimizer compaction scheduler `enabled`):
  today it stands aside globally unless the GLOBAL mode is `off`. Make the
  decision per session: a session is eligible for idle compaction only if its
  effective mode is `off`. Add a per-session predicate the scheduler consults
  per candidate (e.g. an optional `eligible(sessionId)` hook in
  `optimizer/compaction.mjs`, defaulting to always-true), keeping the global
  `optimizerEnabled` switch as is.

### Renderer
- `HandoffModeToggle` takes the session id; reads the effective mode from that
  session's handoff info (`useHandoffSession`), cycles via
  `window.api.handoffSetMode`, optimistic update with rollback + the existing
  inline error on failure. Remove `handoffMode` / `setHandoffMode` from the
  global store if nothing else needs them (Settings may still show/edit the box
  default if it already does — leave any Settings control alone; check first).
- Title text says it applies to this conversation only.

## 6. Out of scope / compatibility
- iOS (`mobile/native`) is unchanged. It still reads/writes the config key, so
  on iOS the toggle changes the box default (affecting sessions that have no own
  value). It has no dismiss control; a dismissed record is terminal and iOS
  already ignores terminal records for its pinned card. Follow-up ticket.

## 7. Tests (minimum)
- Server: dismiss transitions + errors; dismissed session suppresses
  `maybeAuto` (suggest and auto) and agent create (`dismissed` code), while
  `user`/`button` create still works; successor not dismissed; `policyFor`
  reports `off` when dismissed. Per-session mode: set/get, default fallback,
  two sessions independent, successor inherits, `/clear`-style new session does
  not, `create`/`maybeAuto` use the session's mode; compaction eligibility per
  session. Default is `suggest`; migration: unmarked `auto`/absent → `suggest`
  + marker, marked config untouched (a later deliberate `auto` sticks).
  Persistence round-trip of both new state keys incl. old file shape.
- Renderer: card renders in the transcript tail after todos and not in the
  card stack; clamp + Show more/less; copy shows check then reverts, no notice
  line, failure shows error; dismiss calls the API and hides the card, failure
  keeps it with an error; mode toggle is per session.

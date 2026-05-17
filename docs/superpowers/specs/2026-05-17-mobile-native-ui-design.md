# Mobile-Native UI — Design Spec

**Date:** 2026-05-17
**Status:** Approved (brainstorming) — pending implementation plan
**Branch context:** `main`, clean. Builds on the completed mobile chat port
(`docs/superpowers/specs/2026-05-16-mobile-chat-port-design.md`).

## Problem

The bui mobile app (Capacitor/Android) is functionally complete: it renders
the desktop React renderer (`src/renderer/`) verbatim and chat + terminal +
session management work end-to-end on a physical phone. But the UI is the
**desktop layout shrunk onto a small screen**, not adapted for mobile. This
was a deliberate, documented parity-first tradeoff (ship working chat, defer
mobile UX). It is now the top priority.

Concretely on a phone: the multi-pane desktop sidebar + chat layout is
cramped; tap targets are tiny/wrong (session rows are hard to hit — this even
broke automated tap testing); there is no mobile navigation pattern; nothing
is touch-optimized; there are no responsive breakpoints.

## Goal

A mobile-native feeling UI for the phone: proper mobile navigation (session
list and chat/terminal do not fight for space), touch-sized targets,
native-ish interactions (drill-down, edge-swipe back, keyboard-aware
composer). **The desktop Electron UI must remain unchanged** — only the
mobile-served renderer adapts.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Navigation model | **Drill-down stack** (A): session list is home; tap a row → full-screen session view slides in; back / edge-swipe returns. Native iOS/Android pattern. |
| Session view | **Mirror desktop**: a session is *either* chat *or* terminal based on `window.opencodeSessionId`. No in-session tabs. List contains both kinds. |
| Reuse strategy | **Mobile shell + reused ChatPanel/Terminal body.** New mobile-only navigation/layout components reuse the existing `ChatPanel` and `Terminal` as content. The risky 4174-line streaming engine is reused unchanged, *not* refactored. |
| Branch point | The existing `main.tsx` no-Electron detection (`!window.api`) selects `<MobileApp/>` vs `<App/>`. One branch. |
| Desktop impact | Zero. `App.tsx`, `Sidebar.tsx`, all desktop `.tsx`, all `src/main/*`, all `src/preload/*` untouched. Mobile CSS is `.mobile`-scoped and cannot match in the desktop tree. |
| Server impact | None. Renderer-only change; `src/server/*` untouched; no `bui-server` restart needed. |
| Success criteria | Native-feeling app on the real device (touch-sized list, drill-down, keyboard-aware composer), desktop provably unchanged. Device-verified. |

## Architecture

```
main.tsx
  ├─ window.api exists (Electron)   → <App />        ← desktop, UNTOUCHED
  └─ no window.api → install shim   → <MobileApp />  ← new mobile shell

<MobileApp>  (src/renderer/mobile/, all new)
  uses shared useStore()  (projects · status · setActive · refresh)
  nav stack: "list"  ⇄  {screen:"session", projectName, windowIndex}
    ├─ <SessionListScreen>   project-grouped touch rows, live status dots
    └─ <SessionScreen>       compact header + ⋯ actions
          ├─ window.opencodeSessionId ? <ChatPanel/>   ← reused unchanged
          └─ else             <Terminal/>              ← reused unchanged
```

**Invariants:**
- Desktop is unreachable from new code: separate render branch in `main.tsx`;
  mobile CSS scoped under a root `.mobile` class set by `MobileApp`.
- Shared `useStore()`, `httpApi.ts`, `chatUtils.ts` consumed, never forked.
- The 4174-line `ChatPanel.tsx` and `Terminal.tsx` are reused as content
  bodies with no internal changes — the regression-prone streaming/typeahead/
  attachment logic is not touched.
- Renderer-only: `src/server/*` and the Capacitor wrapper protocol unchanged;
  no server restart in the rollout.

## Components

All new files under `src/renderer/mobile/`. Each has one responsibility.

### `MobileApp.tsx` (~120 lines)
Root mobile shell. Owns navigation state — a minimal stack that is either
`"list"` or `{screen:"session", projectName, windowIndex}`. Calls
`useStore().refresh()` on mount (store already subscribes to status). Renders
`SessionListScreen` or `SessionScreen` with a slide transition. Sets the root
`.mobile` class. Handles hardware/gesture back (pop the stack). Catches a
failed initial `refresh()` and shows a retry affordance with the configured
server URL.

### `SessionListScreen.tsx` (~180 lines)
Home screen. Reads `projects` + `status` from the shared store. Renders
project-grouped rows via a `SessionRow` subcomponent: full-width, ≥48px tall,
status dot (running / attention / idle from `WindowStatusUI`), session name,
type label ("chat · running", "chat · needs you", "terminal" — chat-vs-
terminal derived from `window.opencodeSessionId`). Tapping a row calls
`store.setActive(project, windowIndex)` (clears attention, as desktop does)
then pushes the session screen. Header `+` reuses the existing
new-session / new-project flow (lift modal logic or reuse Sidebar's modals as
standalone — resolved in planning). Empty state when no projects.

### `SessionScreen.tsx` (~150 lines)
Drilled-in view. Compact header: back chevron, session name, meta
(token / branch — sourced as `ChatPanel` already does), `⋯` actions sheet
(fork / compact / delete / rename — RPCs already exist). Body gate mirrors
desktop exactly: `window.opencodeSessionId` present → `<ChatPanel>`; else
`<Terminal>`. If the active window vanishes from `projects` (killed
elsewhere), pop back to the list instead of rendering a dead body.

### `mobile.css` (scoped section)
Mobile-only overrides applied under the root `.mobile` class so they can
reshape the reused `ChatPanel`/`Terminal` internals (sticky composer above
keyboard, ≥48px touch targets, full-width transcript) without any selector
ever matching in the desktop tree.

**Reused unchanged:** `ChatPanel.tsx`, `Terminal.tsx`, `store.ts`,
`chatUtils.ts`, `httpApi.ts`, all `src/main/*`, all `src/preload/*`, all
desktop `.tsx`.

## Data Flow

**Boot:** Capacitor loads `http://localhost/` → built renderer →
`main.tsx` sees no `window.api` → installs `httpApi` shim → renders
`<MobileApp/>` → `store.refresh()` (`tmuxList`/`configGet` over `/rpc`) →
`projects` populate → `SessionListScreen` renders. The shim's single
`EventSource('/events')` feeds `onStatusEvent` → `store.applyStatusBatch()` →
row dots update live. The data layer is **unchanged** — same store, shim, SSE.

**Drill in:** tap row → `store.setActive(project, windowIndex)` → nav stack
pushes `{screen:"session",...}` → `SessionScreen` reads `activeSession()` →
renders `ChatPanel` or `Terminal`, which run their own existing load/stream
effects untouched.

**Back:** gesture / back-button → stack pops → `SessionListScreen`. The body
unmounts with the same lifecycle as desktop switching windows.

**Streaming / permissions / questions:** entirely inside reused `ChatPanel`
(`onOpencodeEvent` deltas, QuestionCard, retry/compaction) — works as-is
because the shim delivers identical `OpencodeEvent` objects.

The only new data flow is the **navigation stack** in `MobileApp` — local
React state, no server involvement.

## Error Handling & Edge Cases

- **Empty list:** empty state with `+`, not a blank screen.
- **Server unreachable at boot:** `store.refresh()` rejects → MobileApp shows
  retry UI with the configured server URL (mobile has no SSH layer; the box
  can be unreachable).
- **Session disappears while drilled in:** active window no longer in
  `projects` → SessionScreen pops back to the list.
- **Keyboard overlap:** composer must sit above the on-screen keyboard —
  `env(safe-area-inset-*)`, `100dvh`, focus-scroll. Device-verified (Android
  WebView keyboard is the classic failure point).
- **Edge-swipe vs. horizontal scroll:** back gesture recognized only from the
  **left screen edge**, so it does not fight xterm or wide code blocks.
- **Terminal sizing:** `Terminal.tsx`'s existing <50px fit guard +
  ResizeObserver refit it in the full-screen mobile view. Device-verified.
- **Attention consistency:** opening clears attention via existing
  `setActive`; returning to the list shows updated dots from the live status
  batch. No new latching logic.

Failures surface (retry UI, pop-back), never silently degrade.

## Testing & Rollout

No new vitest suites required (per established mobile-port scope). Existing
`chatUtils.test.ts` and the vitest collection must still pass (`.claude/**`
already excluded).

**Desktop non-regression — gate before device work:** run the Electron app;
`window.api` exists → `<App/>` path → confirm desktop behavior is unchanged.
The new code is unreachable from desktop by construction (separate render
branch + `.mobile`-scoped CSS); this verifies it.

**Device slices** (Android `R83W80ERC6A`, app id `com.antoinedc.bui`), each a
demoable state:
1. **Shell + list:** `MobileApp` renders; `SessionListScreen` shows
   touch-sized project-grouped rows with live status dots; tap target ≥48px
   (fixes the bug that broke automated tapping).
2. **Drill-down + chat:** tap chat session → `SessionScreen` + reused
   `ChatPanel`; back gesture/button returns; prompt streams; composer sits
   above the keyboard.
3. **Terminal session:** tap terminal-type session → `Terminal` fills screen,
   fits, input works.
4. **Actions + create:** `⋯` fork/compact/delete/rename; `+` creates
   session/project; QuestionCard + permission reply work in mobile chat.

Build/install per slice:
`cd mobile && npm run apk && adb -s R83W80ERC6A install -r android/app/build/outputs/apk/debug/app-debug.apk`.
Server restart **not** needed (renderer-only); `bui-server` and other tmux
work sessions stay untouched.

**Rollout:** land mobile shell (desktop unaffected, verified) →
`npm run build:mobile` → `cap sync` → APK install → device walkthrough of
slices 1–4.

## Out of Scope (follow-ups — noted, not folded in)

1. **Authentication / closing the open-port exposure** (highest priority;
   inherited from the mobile-port spec).
2. **Mobile chat markdown links don't open** (inherited follow-up).
3. **Subagent / Task tool rendering in chat-mode** (AGENTS.md open work).
4. Offline mode; iOS build.

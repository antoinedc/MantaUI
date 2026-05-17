# PWA SSE resume — Design

**Date:** 2026-05-17
**Status:** Approved (design phase)
**Scope:** Make the live event stream (`/events` SSE) recover when an
installed iOS PWA is suspended and resumed. Renderer-only change in
`src/renderer/api/httpApi.ts`.

## Symptom

Installed iOS PWA (home-screen icon, `display: standalone`) loads once,
shows live data initially, then **never updates again** — "opens once then
everything is static". A normal Safari tab and desktop recover; the
standalone PWA does not.

## Root cause

`httpApi.ts:ensureStream()` relies entirely on `EventSource`'s built-in
auto-reconnect (code comment line 134: "EventSource will auto-reconnect").
On iOS, a **standalone PWA is frozen/suspended** when backgrounded, screen
locked, or idle. iOS terminates the SSE connection but, in standalone mode,
frequently does **not** fire `onerror` and does **not** resume the
browser's automatic reconnection on resume. The `EventSource` is left
`CLOSED` with no event ever firing → `onerror`→`_hadError`→reconnect path
never runs → stream permanently dead. Distinct from (and downstream of) the
already-fixed tunnel-buffering issue: transport is fine; the client never
re-establishes after a lifecycle suspend.

## Decision

Add an **explicit resume watchdog**: on `visibilitychange`→visible and
`pageshow`, if the shared `EventSource` is not `OPEN`, tear it down and
recreate it, then fire the existing `fireResync()` so missed state is
refetched. Belt-and-suspenders with a lightweight liveness check (the
server already emits a `status` heartbeat + `: keep-alive` comments, so a
healthy stream produces traffic regularly; absence after resume = dead).

Reuse the existing reconnect machinery (`fireResync`, `_hadError`,
`_resyncing`, `listeners`) — do not duplicate resync logic. Listeners are
registered against the module-level `listeners` map, NOT bound to the
`EventSource` instance, so swapping the underlying `es` is transparent to
callers (`on()` consumers keep working).

## Change (single file: `src/renderer/api/httpApi.ts`)

1. Extract the EventSource (re)creation from `ensureStream()` into an
   idempotent `openStream()` that:
   - if `es` exists and `es.readyState !== EventSource.CLOSED`, returns
     (already live/connecting);
   - else closes any stale `es`, creates a fresh `EventSource(serverBase()
     + "/events")`, wires the SAME `onmessage`/`onerror`/`onopen` handlers
     (unchanged behavior).
2. `ensureStream()` calls `openStream()` and, the first time only, installs
   the resume watchdog (guarded by a module flag so listeners added later
   don't re-install it).
3. Watchdog: `document.addEventListener("visibilitychange", …)` +
   `window.addEventListener("pageshow", …)`. Handler: if
   `document.visibilityState === "visible"` and (`!es` ||
   `es.readyState === EventSource.CLOSED`), call `openStream()` then
   `fireResync()` (only if there are listeners). Reuse `_hadError` semantics:
   set `_hadError = true` before reopening so the new `onopen` fires the
   resync via the existing path (avoids double-resync — pick ONE trigger:
   set `_hadError=true` then let `onopen` drive `fireResync`, do NOT also
   call `fireResync` directly).
4. No change to `fireResync`, the synthetic events, listener registration,
   or any call site.

## Why this is correct & safe

- Listeners live in the module `listeners` map; replacing `es` cannot drop
  them. Existing `on()`/unsubscribe semantics unchanged.
- `readyState === CLOSED` is the precise "dead, won't self-heal" signal;
  `CONNECTING`/`OPEN` are left alone (no thrash during normal reconnect).
- Single resync trigger (`_hadError` → `onopen`) prevents the
  double-refetch a naive "reopen + fireResync()" would cause.
- Desktop Electron uses the preload `window.api`, NOT this shim, so this
  code never runs there — zero desktop impact. Normal Safari tab: the
  watchdog is harmless (tab that never suspends → `es` stays OPEN → handler
  no-ops).
- `pageshow` covers bfcache restore; `visibilitychange` covers
  foreground/unlock — together they cover the iOS standalone resume cases.

## Verification

1. `npx tsc -p tsconfig.web.json` clean; `npm test` green (renderer
   vitest + server node:test) — no regression.
2. Rebuild `mobile/www/`, deploy (pull on box; static — no server
   restart), reload `https://bui.useronda.com` in a real browser:
   - Baseline: SSE delivers messages (already verified working).
   - Simulate suspend/resume: drive `document.dispatchEvent(new
     Event("visibilitychange"))` after forcing `es.close()` in the page
     context; assert a NEW EventSource opens and messages resume + a
     resync fired. (Closest automatable proxy for the iOS freeze; true
     on-device confirm is the manual checklist.)
3. On-device (manual, user): open installed PWA, background it / lock
   screen ~30s, reopen → session list + chat update again (status dots
   move, new messages appear) without a manual reload.

## Out of scope

- WebSocket migration of the event channel (larger; not needed if resume
  works).
- Service worker / background sync (scope-A PWA has no SW).
- Server changes (SSE + tunnel already correct and verified).
- Desktop / Android (shim unused on desktop; Android WebView lifecycle is
  different and not reported broken).

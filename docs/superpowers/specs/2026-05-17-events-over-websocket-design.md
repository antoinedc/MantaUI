# Live events over WebSocket — Design

**Date:** 2026-05-17
**Status:** Approved (design phase)
**Scope:** Carry the live event stream (`{kind,payload}` envelope) over a
WebSocket instead of SSE for the web/PWA client, so the installed iOS
standalone PWA receives live updates. Server adds a `/events` WS path
alongside the existing SSE one; `httpApi` swaps `EventSource` → `WebSocket`.

## Symptom & root cause

Installed iOS PWA (`display: standalone`) **never** receives live updates
(session list / chat static from first open, even foregrounded). The exact
same build in **Safari works**. Server emits events; the tunnel streams SSE
(both verified). Root cause: a well-documented iOS bug — `EventSource`/SSE
is unreliable-to-broken in `display: standalone` WebKit, while it works in
Safari proper. Not a suspend issue (fails in foreground too); the earlier
resume-watchdog addressed the wrong sub-problem.

WebSockets, by contrast, work reliably in iOS standalone — proven here: the
app's `/pty` terminal WebSocket already works through the Cloudflare tunnel
in the installed PWA.

## Design

The server already has the right shape:
- `createBus()` in `events.mjs` is the single in-process pub/sub. SSE is
  just one consumer of `bus`.
- `WebSocketServer({ noServer: true })` + `server.on("upgrade")` already
  exist for `/pty` (`index.mjs:261-269`).

Add a **symmetric `/events` WebSocket** that subscribes to the same `bus`
and forwards each event as one JSON text frame using the **identical
envelope** SSE sends (`{kind,payload}`) — so the client's demux-by-`kind`
logic is unchanged.

Keep SSE in place (desktop/other consumers, zero-risk). The web/PWA client
switches to WS. Both read the same `bus`; no event semantics change.

### Server changes

`src/server/events.mjs`:
- Add `attachEventsWs(bus, ws)`: on connect, `const off =
  bus.subscribe(evt => ws.readyState===1 && ws.send(JSON.stringify(evt)))`;
  send an initial `{kind:"_open",payload:null}` is NOT needed (client
  refetches on open). Heartbeat: `setInterval` ping every 15s
  (`ws.ping?.()`), `unref()`. On `ws.on("close")`/`"error"`: clear
  interval + `off()`. (Mirrors the SSE handler's lifecycle exactly.)

`src/server/index.mjs`:
- In the existing `server.on("upgrade")` handler, before/alongside the
  `/pty` branch: if `url.pathname === "/events"`, `wss.handleUpgrade(req,
  socket, head, ws => attachEventsWs(bus, ws))`. Keep `/pty` untouched.
  Non-`/pty`/non-`/events` upgrades: `socket.destroy()` (current default
  behavior preserved).

### Client changes

`src/renderer/api/httpApi.ts` — replace the `EventSource` with a
`WebSocket`, reusing all existing machinery:
- `serverBase()` is `http(s)://host`. WS URL = same origin with
  `ws:`/`wss:` scheme: `serverBase().replace(/^http/, "ws") + "/events"`.
  (Same-origin → `wss:` under the HTTPS tunnel; WS tunnels reliably, like
  `/pty`.)
- `openStream()`: create `new WebSocket(wsUrl)`. `onmessage` → same
  `JSON.parse` → `{kind,payload}` → `listeners[kind]` dispatch (byte-
  identical envelope, so the body is unchanged). `onclose`/`onerror` →
  set `_hadError=true` and schedule a reconnect (WS has **no** built-in
  auto-reconnect, unlike EventSource — so add an explicit backoff
  reconnect: 1s, capped, only while there are listeners). `onopen` → if
  `_hadError`, `fireResync()` (existing path, unchanged).
- The resume watchdog (visibilitychange/pageshow) stays — now checks
  `ws.readyState === WebSocket.CLOSED` and reopens. Keeps the earlier
  fix's value for the backgrounding case; the WS swap fixes the
  never-works case.
- `readyState` constants differ (WS: 0..3; CLOSED=3). Update the checks.

### Why correct & safe

- Same `bus`, same `{kind,payload}` envelope → server event semantics and
  client demux unchanged; only transport differs.
- SSE endpoint kept → desktop/Electron (uses preload `window.api`, not
  this shim — unaffected anyway) and any other SSE consumer keep working.
  Zero-risk additive server change.
- WS reconnect: EventSource auto-reconnects; WS does not. The explicit
  backoff + the existing resume watchdog together cover drop & resume.
- `/pty` WS already proves WS works through the tunnel in standalone PWA —
  this is the same transport, same upgrade handler.

## Verification

1. `npx tsc -p tsconfig.web.json` clean; `npm test` green (renderer
   vitest + server node:test). Add/extend a server test if `events.mjs`
   has one; otherwise a node:test that `attachEventsWs` forwards a
   published bus event as a WS frame.
2. Rebuild `mobile/www/`, deploy (pull + **restart bui-server** — server
   code changed), reload `https://bui.useronda.com`:
   - Browser: a `wss://bui.useronda.com/events` WS connects; publishing
     activity on the box delivers frames; UI updates. Zero console
     errors.
   - Confirm `/pty` terminal still works (didn't break the upgrade
     handler).
3. **On-device (the actual bug):** open the installed iOS PWA (not
   Safari). Without backgrounding, trigger activity on a session → the
   session list / chat updates live. This is the pass/fail the user
   reported; SSE failed it, WS must pass it.

## Risks / unknowns

- Cloudflare tunnel + WS: low risk — `/pty` already runs WS through this
  exact named tunnel on QUIC successfully. Same path.
- WS reconnect storms: bounded backoff + listener-count guard prevents a
  tight loop when the box is down.
- iOS standalone + WS: this is the documented reliable path; `/pty`
  empirically confirms it in this very app.

## Out of scope

- Removing the SSE endpoint (kept for safety/other consumers).
- Desktop/Electron (uses preload IPC, not this shim).
- Android (WebView SSE not reported broken; it also benefits from WS for
  free via the shared shim, but not the target).
- Auth, service worker.

## Implementation outcome (2026-05-17)

Shipped `d291a6c`. Server: `attachEventsWs(bus, ws)` in events.mjs +
`/events` branch in the upgrade handler (SSE `handleEventsRequest`
kept; `/pty` untouched). Client: httpApi `EventSource`→`WebSocket`,
same-origin `wss://…/events`, explicit 1.5s backoff reconnect (WS has
no auto-reconnect), resume-watchdog + fireResync machinery retained.
typecheck + 24 vitest + 23 node:test green. Deployed (bui-server
restarted; tunnel untouched, both active).

Verified live through https://bui.useronda.com: `wss://bui.useronda.com
/events` connected, RECEIVED 6 msgs/9s (first 814ms, status+opencode);
deployed bundle confirmed WebSocket-only (no EventSource). Mechanism +
deployment proven through the real tunnel. On-device confirmation
remains the user's manual step: open the INSTALLED PWA (not Safari),
without backgrounding, trigger session activity → list/chat update
live. This is the exact case SSE failed and WS must pass.

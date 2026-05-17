# httpApi same-origin base — Design

**Date:** 2026-05-17
**Status:** Approved (design phase)
**Scope:** Fix the `window.api` HTTP shim so the web/PWA client (served via the
HTTPS cloudflare tunnel) talks to its own origin instead of a hardcoded
`http://157.90.224.92:8787`, which browsers block as mixed content.

## Symptom

Opening the tunnel URL (`https://…trycloudflare.com`) in a browser →
"failed to fetch". Console:

```
Mixed Content: page loaded over HTTPS requested insecure
'http://157.90.224.92:8787/rpc/config:get' — blocked.
Mixed Content: insecure EventSource 'http://157.90.224.92:8787/events' — blocked.
```

## Root cause

`src/renderer/api/httpApi.ts:14-16`:
```js
function serverBase() {
  const v = localStorage.getItem("bui_server");
  return v ? v.replace(/\/+$/, "") : "http://157.90.224.92:8787";
}
```
With no `bui_server` override, every RPC / SSE / upload call targets the
hardcoded **plaintext HTTP** IP. From an HTTPS page the browser blocks it.

## Constraint — three deployment contexts

1. **Web / PWA via tunnel** (broken now): loaded from `https://…trycloudflare.com`
   → base must be **same-origin** so calls ride the same HTTPS tunnel.
2. **Capacitor APK**: loaded from `http://localhost/` → same-origin would be
   wrong (no server on the device); needs the explicit `bui_server` remote
   base. Must keep working.
3. **Explicit override**: `localStorage["bui_server"]` set (Settings screen)
   → always wins. Must keep working.

## Decision

`serverBase()` resolution order:

1. `localStorage["bui_server"]` (trimmed of trailing `/`) — if set, **wins**
   (covers APK + manual override + power users).
2. Else, if `window.location.protocol` is `http:` or `https:` **and**
   `window.location.hostname` is NOT a local shell
   (`localhost`, `127.0.0.1`, `::1`, or empty) → return
   `window.location.origin` (same-origin: the tunnel / LAN host the page
   came from — correct for web + PWA, protocol-matched so no mixed content).
3. Else (Capacitor `http://localhost`, `file:`, etc.) → fall back to the
   existing dev default `http://157.90.224.92:8787`.

This fixes the tunnel/PWA case, leaves the APK path on its existing
fallback, and keeps the override authoritative. No server change; no
protocol hardcoding (origin carries the page's own scheme).

## Change

Single function in `src/renderer/api/httpApi.ts` (`serverBase`, lines
14-17). All call sites (`rpc` line 25, `EventSource` line 107, upload line
208) consume `serverBase()` unchanged.

## Edge cases

- `localStorage["bui_server"]` set to an `http://` value while page is
  HTTPS → user's explicit choice; still honored (could itself mix-content,
  but that's an explicit override the user set, not our default — out of
  scope to second-guess).
- `location.origin` already includes scheme+host+port, no trailing slash →
  drop-in for the existing `${serverBase()}/rpc/...` concatenations.
- `hostname` check uses an explicit local-set; anything else (tunnel
  subdomain, LAN IP, real domain) → same-origin.

## Verification

1. `npm test` green (renderer vitest + server node:test) — no regression.
2. Rebuild `mobile/www/` (`npm run build:mobile`), redeploy to box (pull +
   server already serves it), reload the tunnel URL in a real browser:
   - **Zero Mixed Content errors** in console.
   - `config:get` RPC + `/events` EventSource resolve (no "failed to
     fetch"); the session list renders.
3. Confirm same-origin: in the browser, network calls go to
   `https://…trycloudflare.com/rpc/*` and `/events` (not the `http://IP`).
4. APK path reasoning preserved (no device retest in scope; logic for
   `localhost` → fallback is unchanged behavior).

## Out of scope

- Server changes (already serves mobile/www correctly).
- Persisting/auto-setting `bui_server` (the same-origin default removes the
  need for the common case).
- Re-testing the Android APK on a device (logic for its context is
  unchanged — it still hits the fallback as before).

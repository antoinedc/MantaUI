# Server serves mobile/www (React + PWA bundle) — Design

**Date:** 2026-05-17
**Status:** Approved (design phase)
**Scope:** Make `src/server/` (the Linux-box HTTP server) serve the React
`mobile/www/` bundle — including the PWA manifest/icons/assets — instead of
the dead legacy vanilla client in `src/server/public/`. Delete the legacy
client. Single-user box; no backward-compat constraints.

## Why

The iOS PWA work (shipped, commits up to `527390f`) put the manifest, icons,
and PWA `<head>` tags into `mobile/www/`. But `src/server/index.mjs` sets
`PUBLIC_DIR = src/server/public` and only serves `/` (its `index.html`),
`/vendor/*`, and `/static/*` from there. `src/server/public/` is a separate
**legacy May-15 vanilla-JS client** (`app.js` + `index.html`, no PWA tags).
Result: `GET /manifest.webmanifest` → 404; the React+PWA bundle is never
served over HTTP. The PWA is correct in git but uninstallable via this server.

This is a real server bug/gap, scoped as its own change (the PWA spec
explicitly excluded backend changes).

## Decisions (locked in brainstorming)

- **Approach A**: repoint the server at `mobile/www/` and delete the legacy
  client entirely. Not B (keep both — leaves dead code), not C (half-measure
  that doesn't serve the SPA at `/`).
- **Single user** ("I'm the only user now") → safe to delete `/vendor/`,
  `/static/`, and `src/server/public/` outright. No coexistence needed.
- **SPA fallback rule**: an unmatched GET serves the real file if it exists
  under `mobile/www/`, else serves `mobile/www/index.html` (client-side
  routing / deep links). Path-traversal safe via the existing `safeJoin()`.

## Changes (all in `src/server/index.mjs` + one deletion)

1. **`PUBLIC_DIR`** (line 26): `join(__dirname, "public")` →
   `join(PROJECT_ROOT, "mobile", "www")`.
2. **MIME map** (lines 91-100): add
   `".webmanifest": "application/manifest+json"`. (Existing `.html .js .mjs
   .css .map .svg .ico .png` already cover the rest of the bundle.)
3. **Remove dead routes + data**: the `VENDOR` map (lines 104-110), the
   `/vendor/` route (lines 232-240), and the `/static/` route
   (lines 242-249). The React bundle inlines its own hashed assets and does
   not use `/vendor/` or `/static/`.
4. **Static fallback**: replace the terminal `404` (lines 255-256) with:
   - `const target = safeJoin(PUBLIC_DIR, path)` (decoded, traversal-safe).
   - If `target` resolves and is an existing file → `serveFile(res, target)`
     (correct MIME via the map).
   - Else → `serveFile(res, join(PUBLIC_DIR, "index.html"))` (SPA fallback).
   - Keep `GET / | /index.html` explicit early return (line 216-218) as-is
     — it already serves `PUBLIC_DIR/index.html`, now = `mobile/www`.
5. **Delete** `src/server/public/` (the legacy client) via `git rm -r`.

Untouched (verified correct, shared by the React client): `/events` (SSE),
`/rpc/*`, `/api/projects`, `/api/upload`, the `/pty` WebSocket upgrade, CORS
headers. These are matched BEFORE the static fallback, so SPA fallback never
shadows them.

## Data flow (after)

```
GET /                       → mobile/www/index.html (React + PWA tags)
GET /manifest.webmanifest   → mobile/www/manifest.webmanifest (application/manifest+json)
GET /icons/icon-180.png     → mobile/www/icons/icon-180.png (image/png)
GET /assets/index-*.js|css  → mobile/www/assets/... (correct MIME)
GET /events | /rpc/* | /api/*  → unchanged backend handlers (matched first)
GET /some/spa/deeplink      → mobile/www/index.html (SPA fallback)
WS  /pty?...                → unchanged
```

## Error handling / edge cases

- **Traversal**: `safeJoin()` (already used by the old `/static/` route)
  rejects `..` escapes → fall back to index.html (never 500/leak).
- **Missing file**: `serveFile`'s existing try/catch already degrades to its
  fallback status; the explicit existence check picks index.html instead so
  unknown paths render the SPA, not "not found".
- **API path typo** (e.g. `GET /rpc/` with no channel): still handled by the
  earlier `/rpc/` branch; only genuinely-unmatched paths hit the fallback.
- **`.webmanifest` MIME**: iOS is lenient but `application/manifest+json` is
  correct and what Chrome/Lighthouse expect.

## Testing / verification

1. `npm run test:server` (node:test, `src/server/*.test.mjs`) stays green —
   proves tmux/rpc parsing untouched.
2. `npm test` full suite green (renderer vitest unaffected; sanity).
3. On the Linux box, after pull + server restart, curl:
   - `GET /` → 200, body contains `rel="manifest"` (React+PWA index).
   - `GET /manifest.webmanifest` → 200, `content-type:
     application/manifest+json`, valid JSON.
   - `GET /icons/icon-180.png` → 200 `image/png`.
   - `GET /assets/<the hashed js>` → 200 `application/javascript`.
   - `GET /events` → still the SSE stream (200, text/event-stream).
   - `POST /rpc/<a real channel>` → still works (spot check via the
     existing client or curl).
4. Restarting the running box server (pid replacing the 3h-old one) is part
   of bringing it live — documented, with the old process stopped cleanly.

## Out of scope (explicit)

- Installing/running `cloudflared` (not on the box; tunnel is a separate
  follow-up — the server change is a prerequisite for it, not coupled).
- Any renderer / `mobile/www/` content change (already shipped + correct).
- Auth (server remains no-auth v1, per AGENTS.md).
- Desktop Electron / Android Capacitor (untouched).

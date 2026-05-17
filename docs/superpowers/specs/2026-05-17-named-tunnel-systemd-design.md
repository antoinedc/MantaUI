# Named Cloudflare tunnel + systemd durability — Design

**Date:** 2026-05-17
**Status:** Approved (design phase)
**Scope:** Replace the ephemeral quick-tunnel with a **named Cloudflare
tunnel** (stable URL surviving restarts) and run both the mobile server and
the tunnel as **systemd --user services** (reboot/crash survival, no
SSH-detach fragility). No custom domain — use the tunnel's own permanent
hostname.

## Why

Three coupled problems observed this session:
1. **SSE dead through the tunnel.** `--protocol http2` quick-tunnel buffers
   SSE; the app loads but never updates. Named tunnels default to QUIC,
   which streams SSE correctly.
2. **Ephemeral URL.** `trycloudflare.com` name changes on every tunnel
   restart → installed iOS PWA icon breaks. A named tunnel has a permanent
   hostname.
3. **No process durability.** Server + tunnel are bare `nohup` processes
   (server survives, tunnel was killed mid-session); neither survives
   reboot. SSH-detached launches keep dying with the SSH client. systemd
   --user + linger fixes all of this.

## Target architecture

```
client ──HTTPS──▶ <permanent cloudflare hostname>
                       │ named tunnel (QUIC → SSE streams correctly)
                       ▼
 box: systemd --user  bui-tunnel.service ─▶ 127.0.0.1:8787
                       ▲ Requires=/After=
       systemd --user  bui-server.service  (node src/server/index.mjs,
                                             BUI_MOBILE_HOST=127.0.0.1)
       loginctl enable-linger dev   (runs without login / across reboot)
```

## Decisions (locked)

- **Named tunnel, no custom domain.** Free Cloudflare account login only.
  The exact public hostname form (`<uuid>.cfargotunnel.com` vs requiring a
  DNS route) is **verified empirically** during setup, not assumed — modern
  cloudflared may require a DNS route even for the cfargotunnel form. If a
  plain hostname isn't reachable without a domain, fall back decision is
  surfaced to the user (do not silently revert to ephemeral).
- **QUIC transport.** Drop `--protocol http2`. The "QUIC fails on this box"
  AGENTS.md note is undated and predates cloudflared 2026.5.0; http2
  *demonstrably* breaks SSE here (proven via raw curl). QUIC is tested; if
  it genuinely won't connect, that's a surfaced blocker, not an auto-revert.
- **systemd --user (not system/root).** No root needed; `enable-linger`
  gives reboot survival. Two units with an ordering dependency.
- **cloudflared already installed** (`/home/dev/.local/bin/cloudflared`,
  v2026.5.0) — nothing to install.

## Steps & ownership

| # | Step | Who |
|---|------|-----|
| 1 | `cloudflared tunnel login` (browser auth, pick account) | **User** (I can't drive the browser) |
| 2 | `cloudflared tunnel create bui` → tunnel UUID + creds json | Me |
| 3 | Determine reachable public hostname (test cfargotunnel form; if it needs a route, surface to user) | Me |
| 4 | `~/.cloudflared/config.yml`: tunnel UUID, creds path, `ingress` → `http://127.0.0.1:8787`, `protocol: quic` | Me |
| 5 | `~/.config/systemd/user/bui-server.service` | Me |
| 6 | `~/.config/systemd/user/bui-tunnel.service` (`Requires=`/`After=bui-server`) | Me |
| 7 | `loginctl enable-linger dev`; `systemctl --user enable --now` both | Me (linger may need user; verified) |
| 8 | Verify end-to-end through the permanent URL: static 200, `/manifest.webmanifest`, **SSE streams** (raw curl + browser), `/rpc/*` | Me |
| 9 | Update `bui_server` default note + AGENTS.md tunnel section + this spec outcome | Me |

## Verification (the real gate)

The previous "fixes" looked done but SSE was dead — so verification here is
specifically:
- `curl -sN <perm-url>/events` through the tunnel **emits `data:` lines
  within ~2s** (the exact test that exposed the http2 bug). Not just "200".
- Browser EventSource through the tunnel: `total > 0` messages, `status`
  kind seen, UI updates live.
- `systemctl --user status` both green; `systemctl --user restart
  bui-tunnel` then re-verify URL still works (proves stability) and is the
  **same** hostname (proves permanence).
- Reboot survival is asserted by `enable-linger` + `WantedBy=default.target`
  (not physically rebooting the box, but the mechanism is the standard one).

## Risks / honest unknowns

- **cfargotunnel hostname reachability without a domain** — genuinely
  uncertain on current cloudflared; step 3 tests it. If it requires a
  domain after all, STOP and ask the user (don't silently downgrade).
- **QUIC on this box** — AGENTS.md says it failed before. Step 7 tests it;
  if QUIC won't establish, STOP and surface (http2 means SSE stays broken —
  that's a real decision point, not an auto-fallback).
- **linger permission** — `loginctl enable-linger dev` sometimes needs
  root/polkit. If it fails, surface; services still work while logged in /
  session alive as a degraded interim.

## Out of scope

- Custom domain (explicitly declined).
- Auth on the server (still no-auth v1).
- Renderer changes (same-origin base already shipped — works for any
  permanent hostname).
- Desktop / Android.

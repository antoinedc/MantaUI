# Better UI — Workspace Context

## Project Overview

BUI is an Electron desktop client for working with Claude on a remote Linux box over SSH+tmux. Sidebar of projects (tmux sessions) with multiple windows each; xterm.js terminal in one tab type, a native React chat panel powered by opencode in the other.

**The business model**: open-source everything except the mobile app subscription. Users bring their own compute (VPS, laptop, whatever). We sell a polished App Store/Play Store app that auto-connects to their box with zero setup.

## Current Architecture

- **Desktop app**: Electron + xterm.js + React (ChatPanel.tsx ~4150 LoC)
- **Box server**: Node HTTP+WS (`src/server/`) — tmux/pty/opencode proxy
- **Mobile**: Capacitor hybrid app (`mobile/`) with iOS/Android native shells
- **Mobile/web client**: built into `mobile/www/` via Vite, served by `src/server/index.mjs`
- **Push**: Web Push (VAPID) via `src/server/push.mjs` — iOS revokes if delivered without notification
- **Auth**: NONE on `src/server/` — `0.0.0.0:8787` open to the internet today

## Key Constraints

1. **No auth in v1** — this is the #1 blocker for commercialization. Must be solved before any paid tier.
2. **Mobile is PWA today** — real App Store distribution requires native push (APNs), no cleartext, proper onboarding flow.
3. **Box is single-user** — everything assumes one user, one box (`~/.bui-mobile/`, single tunnel, single opencode on :4096). Multi-tenancy only needed in the relay.
4. **Upstream dependency** — rides opencode + Claude Max auth. If opencode changes the event wire format, product breaks.
5. **No auto-update** — README says "pull from git for new versions." Desktop needs packaging (.dmg/.AppImage) + auto-update for commercial viability.

## The Paid Mobile App — Target Experience

**Entry points** (both converge to the same flow):
1. **Deeplink** (from desktop "Get on mobile" → deferred deeplink via Branch/Firebase)
2. **QR scan** (from desktop Settings → "Pair phone" → shows QR)

**Flow**:
```
1. User installs app (App Store / Play)
2. App resolves pairing payload (QR or deferred deeplink)
3. App auto-connects to box (box_id + pairing token)
4. App shows their projects/sessions list (free preview)
5. User taps a session → blurred preview with stats
6. "Start subscription" (Apple IAP / Play Billing) — one tap
7. Running on mobile with live streaming + push
```

**What's free vs. paid**:
- **Free (metadata only)**: project list, session titles, running/idle status, token counts, message/tool counts, blurred placeholder thumbnail
- **Paid (full capability)**: live transcript streaming, sending prompts, push notifications, terminal access

**Server-side enforcement**: relay gates endpoints — pre-sub metadata endpoints serve free data; transcript/stream endpoints 402 until IAP receipt is bound to box_id. Blur is a placeholder, not CSS-over-real-content.

## The Relay — What We're Actually Selling

The relay is the operated backend that makes the mobile app work:
- **TLS termination** + outbound tunnel coordinator (replaces per-user cloudflared)
- **Account↔box routing** (box_id → tunnel endpoint)
- **Operated native push** (APNs/FCM via your certs)
- **IAP receipt validation** (Apple IAP Server Notifications → box_id binding)
- **Metering/rate-limiting** per box_id (the COGS number)

The relay is **new code, not in this repo**. It's the actual paid product. The software (client + server) stays open source.

## Token Identity Model (Anonymous by Construction)

- **box_id**: 32 hex chars (128-bit random), opaque pseudonym, maps to nothing human
- **box_secret**: HMAC key, generated on the box, never leaves the box
- **claim_code**: one-time, ~15 min TTL, consumed when box registers
- **pairing_token**: one-time, short TTL, consumed when desktop pairs
- **device_token**: long-lived, stored in config.json after pairing

All traffic authenticated with `box_id` + HMAC signature (reuses `webhooks.mjs` pattern: `isValidToken`, `verifySignature`, `createRateLimiter`).

## Existing Multica Setup

- **Workspace**: https://multica.ai/better-ui (ID: `264c89bb-4659-4570-af7b-5f8daaf87985`)
- **Agent**: `better-ui-dev` (ID: `87bf6d8f-5fd0-4fb6-8dd8-a5e7c36b0747`) — OpenCode runtime
- **Skill**: `verify-build-better-ui` (ID: `95d4a528-3756-4ee0-a4e2-bf072e54399a`) — runs `npm run typecheck && npm test`

## Hard Rules

1. **Source of truth flows repo → Cloud.** Edit `.multica/` files first, commit, then push.
2. **Never commit PATs or daemon tokens.** `~/.multica/config.json` lives outside the repo.
3. **Skill descriptions in frontmatter must stay accurate.** The dispatcher uses them at task-dispatch time.
4. **No production deploy from agents.** No `ssh root@…`, no `./scripts/deploy.sh`, no `docker` on prod.
5. **Mobile changes need rebuild + commit** — `npm run build:mobile` then `git add mobile/www && git commit && git push`. Source edits alone do NOTHING on phone.
6. **Auth on `src/server/` is job zero** — cannot ship commercial product without it.

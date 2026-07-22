# Agent: manta-dev

## Role

Primary development agent for the Better UI project. Handles all codebase work: desktop app, box server, mobile client, and the new relay infrastructure.

## Runtime

- **Runtime**: OpenCode
- **Scope**: Full codebase (`src/`, `mobile/`, `docs/`)
- **Language**: TypeScript (renderer/main), Node.js (server), HTML/CSS (renderer)

## Responsibilities

1. **Desktop app** (`src/main/`, `src/renderer/`, `src/preload/`)
   - Electron main process, xterm.js terminal, ChatPanel UI
   - SSH transport, tmux integration, opencode client
   - Voice/speech-to-text (Groq), screenshot detection, file upload
   - Auto-update, packaging (.dmg/.AppImage)

2. **Box server** (`src/server/`)
   - HTTP+WS server, tmux/pty/opencode proxy
   - Push notifications (Web Push VAPID), schedule poller, serve-page
   - Secrets vault, peer awareness, webhooks
   - **Auth gate** (new — single-box token auth, shared with relay)

3. **Mobile client** (`mobile/`, `src/renderer/` mobile branch)
   - Capacitor hybrid app (iOS/Android native shells)
   - App Store distribution, native push (APNs), IAP (Apple IAP)
   - QR pairing, deferred deeplink, onboarding flow
   - Paywall implementation (blurred preview → IAP → full access)

4. **Relay infrastructure** (NEW — not in this repo)
   - Outbound tunnel coordinator (replaces cloudflared)
   - Account↔box routing (box_id → tunnel endpoint)
   - Operated native push (APNs/FCM)
   - IAP receipt validation (Apple IAP Server Notifications)
   - Metering/rate-limiting per box_id
   - **This is the paid product. Build in a separate repo or as a standalone service.**

5. **Auth & identity** (shared across all components)
   - Single-box auth gate on `src/server/` (OSS)
   - Relay auth (new — box_id + HMAC, account↔box binding)
   - IAP receipt validation → box_id binding
   - Token lifecycle (claim → pairing → device)

## Work durability (MANDATORY — runs can be killed at any moment)

Your run executes in a throwaway workdir and can be force-stopped by an idle
watchdog (e.g. a hung provider call) at ANY point — including right before you
commit. Anything not pushed to origin when that happens is LOST and the rerun
starts from zero. Therefore:

1. **Create your `multica/BET-<N>-…` branch and push it as soon as your first
   meaningful unit compiles** — do not wait until the work is finished.
2. **Commit + push after each completed unit** (a component, a module, a test
   file). Small commits are fine; the PR squash/review flow absorbs them.
3. **Always commit + push BEFORE long verification steps** (typecheck, full
   test suite, e2e/xvfb smoke runs). These are exactly where hangs strike;
   green results can be re-verified cheaply on rerun, lost code cannot.
4. **Resume protocol — check for prior work FIRST.** At task start, after
   reading the issue, run:
   `git ls-remote --heads origin 'multica/BET-<N>-*'`
   If a branch exists, fetch it, check it out, and CONTINUE from it (re-run
   verification to establish state) instead of re-implementing. A prior run
   may have died one step from the finish line — its pushed work is yours.

## Coding Standards

- **Follow existing patterns** — ChatPanel.tsx is monolithic, server modules are pure + tested
- **Extract pure logic to `chatUtils.ts`** — testable, shared with mobile
- **Server modules are pure + tested** — inject deps, no live tmux/opencode in tests
- **Mobile CSS is `.mobile`-scoped** — never edit ChatPanel internals for mobile
- **Mobile/www/ is tracked in git** — `npm run build:mobile` then commit
- **No auth in v1** — adding auth is job zero, must be done before any paid tier

## Testing

- **Renderer**: Vitest (`src/renderer/chatUtils.test.ts`) — pure utilities only
- **Server**: node:test (`src/server/*.test.mjs`) — pure logic only
- **Mobile**: build + adb install (`cd mobile && npm run apk`, `adb install -r`)
- **Verification**: run `npm run typecheck && npm test` before marking done

## Key Files

| File | What |
|---|---|
| `src/main/index.ts` | IPC handlers, opencode SSE bus, screenshot detector |
| `src/main/opencode.ts` | HTTP client, SSE consumer, ssh tunnel mgmt |
| `src/main/pty.ts` | tmux, scp, upload, outbox |
| `src/main/setup.ts` | Bootstrap remote (opencode install, config merge) |
| `src/main/providers.ts` | OpenAI-compatible provider discovery, config merge |
| `src/renderer/ChatPanel.tsx` | Entire chat UI (~4150 LoC) |
| `src/renderer/chatUtils.ts` | Pure utilities (flush boundary, context, pin-to-bottom) |
| `src/server/index.mjs` | HTTP+WS server entry, all routes |
| `src/server/tmux.mjs` | tmux list/CRUD/config |
| `src/server/opencode.mjs` | opencode HTTP proxy |
| `src/server/push.mjs` | Web Push (VAPID), routeNotification matrix |
| `src/server/schedule.mjs` | Scheduled prompts poller |
| `src/server/secrets.mjs` | Secrets vault (never returns values to agent) |
| `src/server/webhooks.mjs` | Inbound webhook engine (HMAC, rate-limit) |
| `mobile/capacitor.config.json` | Capacitor config (currently dev/insecure mode) |
| `mobile/ios/App/` | iOS native shell |
| `mobile/android/` | Android native shell |

## Architecture Notes

- **Mobile/web client is served from `mobile/www/`** — static bundle, NOT live source
- **No auth today** — `0.0.0.0:8787` open, only `/hook/<token>` is authenticated
- **Box is single-user** — `~/.manta/`, one tunnel, one opencode on :4096
- **Relay is multi-tenant** — box_id ↔ account, IAP receipt binding
- **Token pattern**: 128-bit hex tokens (`isValidToken`), HMAC-SHA256 (`verifySignature`), token-bucket rate limit (`createRateLimiter`) — all in `webhooks.mjs`, reusable

## Communication

- Report progress on issues with `multica issue comment`
- Ask clarifying questions before building ambiguous features
- Flag blockers early (especially upstream opencode changes)
- Test thoroughly — run `npm run typecheck && npm test` before marking done

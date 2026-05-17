# Better UI workspace context

bui is an Electron desktop client for remote `claude` / `opencode` over SSH + tmux,
plus a mobile/web front-end (`src/server/`) that runs on the Linux dev box and exposes
the same tmux server over HTTP + SSE.

Working directory on the runtime host: `/home/dev/projects/better-ui`

## Project layout

```
src/
  main/       — Electron main: pty, SSH/tmux transport, IPC handlers, opencode SSE bus,
                screenshot detector, opencode HTTP proxy (opencode.ts)
  renderer/   — React + xterm.js UI. ChatPanel.tsx (~4150 LoC) is the chat-mode UI.
                chatUtils.ts holds pure utility functions (import from there, don't redeclare).
  preload/    — typed window.api bridge
  server/     — Node HTTP + SSE server for mobile/web access. Modules:
                index.mjs, tmux.mjs, pty.mjs, opencode.mjs, rpc.mjs,
                events.mjs, local.mjs, status.mjs
mobile/       — Capacitor wrapper (Android APK + iOS scaffold)
out/          — Electron build output (generated, do not edit)
mobile/www/   — Vite build of renderer for Capacitor (generated)
```

## Build / test commands

```bash
npm install
npm run typecheck          # tsc across all tsconfigs
npm test                   # vitest (renderer) + node:test (src/server/*.test.mjs)
npm run test:server        # node:test only
npm run dev                # Electron dev server (restart on main/preload changes)
npm run mobile             # mobile/web server 0.0.0.0:8787
npm run build:mobile       # Vite → mobile/www/ for Capacitor
```

**Build verification** (mandatory before claiming done):
```bash
npm run typecheck && npm test
```
Both must pass. Report results when completing an issue.

## Key architectural facts agents must know

- **One PTY per active project**, kept mounted across renders.
- **ChatPanel is monolithic by design** (~4150 LoC). Do not split it unless explicitly
  asked. Extract only pure functions to `chatUtils.ts`.
- **`window.api` shim** (`src/renderer/api/httpApi.ts`) — implements the full `Api`
  contract over `/rpc` + `/events` for mobile. Installed in `main.tsx` only when
  `window.api` is absent.
- **opencode runs in tmux session `bui-opencode`** on the Linux box, port 4096,
  bound to 127.0.0.1. Mac connects via SSH `-L 14096:127.0.0.1:4096`.
- **Chat-mode recognition**: presence of `@bui-session-id` tmux user-option on a window
  is THE signal to show ChatPanel instead of Terminal.
- **Live-event state preferred over transcript-derived `useMemo`**. When adding a new
  SSE consumer, use `useState` reset on session change, set in the SSE handler,
  consumed via `liveX ?? transcript-derived`. Never mutate messages in-place.
- **Mouse is ON through the whole pipeline** — do not reintroduce `tmux set -g mouse off`
  or `CLAUDE_CODE_DISABLE_MOUSE=1`. See AGENTS.md "Mouse mode" section.
- **Do NOT add `document.hidden` check** to screenshot detector — bui loses focus
  during the screenshot gesture.
- **OpenSSH 9.x scp**: do NOT shell-quote remote paths in scp calls (SFTP transport).
  `mkdir` via `runSshOnce` still uses `shellQuote` (real remote shell).
- **Preload bundle** is built once at dev-server start. Adding a new `window.api`
  method requires a full `Ctrl+C` + restart of `npm run dev`.
- **Shift+Enter → newline**: `attachCustomKeyEventHandler` in `Terminal.tsx` sends
  `\x1b\r`. Do not drop the `preventDefault()`.

## Commit conventions

- Format: `type(scope): description`
- Types: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `build`
- Scopes: `renderer` / `server` / `main` / `preload` / `mobile` / `chat`
- Only commit files modified in this session. Never `git add -A` blindly.
- Push to `main` after committing (trunk-based).
- Never `--no-verify`, never amend a published commit, never force-push `main`.

## Hard rules (no exceptions)

1. **DO NOT deploy.** No `ssh root@…`, no `docker` on any production VPS.
2. **Never commit secrets.** PATs, API keys, `.env` files stay out of git.
3. **TypeScript strict mode** everywhere in `src/`. No `any` casts without comment.
4. **Do not break the server test suite.** `npm run test:server` must stay green.
5. **chatUtils.ts is the home for pure logic** extracted from ChatPanel. Import from
   there; do not redeclare inline.

## Reference doc

The full authoritative context is `/home/dev/projects/better-ui/AGENTS.md`.
Read it before touching any unfamiliar subsystem. It contains locked design
decisions (mouse mode, scp quoting, ghost-text autocomplete, worktree fan-out,
activity poller regexes) that must not be re-litigated without explicit human sign-off.

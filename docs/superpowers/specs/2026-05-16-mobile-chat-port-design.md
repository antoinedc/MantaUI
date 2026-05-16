# Mobile Chat Port — Design Spec

**Date:** 2026-05-16
**Status:** Approved (brainstorming) — pending implementation plan
**Branch context:** `feat/mobile-capacitor` work merged to `main`; mobile app currently terminal-only.

## Problem

The Capacitor Android app is a tmux **terminal viewer only**. The rich bui
chat UI (streaming responses, QuestionCard, live todos, retry cards, branch
indicator, token/cost, compaction progress) exists solely in the desktop
Electron renderer (`src/renderer/`) and was never ported to mobile. Opening a
session on the phone yields a raw terminal; there is no native chat screen.

## Goal

The Android app renders the **same React renderer as desktop** with **full
parity**: chat + terminal + session management. Backed by the mobile server
proxying to the opencode service and local tmux/git/fs.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| UI strategy | Reuse the React renderer (`src/renderer/`); second Vite build → `mobile/www/`. No vanilla rewrite. |
| App scope | Full app: session list → chat **and** terminal + session management. |
| Feature scope | Full parity with desktop chat (all `window.api.opencode*`). |
| Non-chat APIs | Full `window.api` parity (~38 req/res + 4 event subscriptions). |
| Backend model | opencode runs as a separate service at `127.0.0.1:4096` on the box; mobile server **proxies** it directly (no SSH forward — same box). |
| Structural approach | **Approach A**: mobile server adds HTTP/SSE routes mirroring Electron IPC; browser `window.api` shim. Desktop untouched. |
| Auth / open-port | **Out of scope.** Documented as top follow-up risk. |
| Success criteria | Live on the phone, full flow works (device-verified). |

## Architecture

```
Android (Capacitor WebView, http://localhost)
  React renderer (src/renderer/, built to mobile/www/)
    ChatPanel.tsx · Terminal.tsx · Sidebar.tsx · …
        │ calls window.api.*
  Browser shim: src/renderer/api/httpApi.ts
    • req/res    → fetch(POST /rpc/<channel>)
    • onX(cb)    → one EventSource(/events), demuxed
        │ HTTP + SSE  (http://157.90.224.92:8787)
bui mobile server (src/server/, on the box)
  /rpc/<channel>  → handlers mirroring Electron IPC
  /events (SSE)   → opencode + pty + status fan-out
    ├ opencode/*  → proxy to http://127.0.0.1:4096 (+ /event SSE)
    ├ tmux/*      → local tmux exec
    ├ git/fs/*    → local exec
    └ pty         → existing WebSocket /pty (unchanged)
        │
  opencode service @ 127.0.0.1:4096 (bui-opencode tmux session)
```

**Invariants:**
- Desktop is untouched: Electron preload/main/renderer `.tsx` unchanged.
- Renderer code unchanged — it already targets `window.api.*` only
  (`ChatPanel.tsx:13` explicitly anticipates the mobile HTTP server).
- Mobile server reaches opencode **directly** (same box) — no SSH-forward
  layer that desktop's `src/main/opencode.ts` requires.
- Existing `/pty` WebSocket and tmux-list are extended, not replaced.

## Components

### 1. Browser API shim — `src/renderer/api/httpApi.ts` (new, ~250 lines)
- Implements the exact `window.api` TS contract for the browser so
  renderer components run unmodified.
- `main.tsx` selects implementation: if `window.api` exists (Electron
  injected it) use it; else install the HTTP shim. One branch.
- Internals:
  - `rpc(channel, ...args)` → `POST /rpc/<channel>` `{args:[...]}` → JSON
    result. Generic over all 38 request/response methods.
  - One shared `EventSource('/events')` demultiplexed to
    `onOpencodeEvent` / `onPtyEvent` / `onStatusEvent` /
    `onScreenshotDetected`; each `onX` returns an unsubscribe, matching
    preload semantics.
  - Explicit handling: `getPathForFile` (pure-local, no server),
    `clipboardReadImage` (returns null on phone), `uploadBuffer`
    (multipart POST).

### 2. Server RPC + event layer — `src/server/rpc.mjs` + `src/server/events.mjs` (new)
- `rpc.mjs`: channel name → handler map.
- `events.mjs`: owns the single SSE endpoint and fan-out, with keep-alive
  comments so idle streams aren't killed by mobile proxies.

### 3. Server domain modules (new)
- `src/server/opencode.mjs`: thin proxy to `127.0.0.1:4096`
  (prompt/abort/compact/fork/permissions/questions/models/commands/agents/
  find-files/messages) + subscribes opencode `/event` SSE and re-emits
  into the fan-out. Mirrors `src/main/opencode.ts` **minus** SSH-forward
  and Electron-config code.
- `src/server/tmux.mjs`: tmux list/new/rename/kill/select + config
  status/setup/restore. Existing `listProjects()` moves here and grows
  CRUD siblings (ported from `src/main/pty.ts` / `status.ts` patterns).
- `src/server/local.mjs`: git worktrees, `fsListDirs`, `openExternal`,
  `peekRemoteFile`, clipboard stubs (documented), uploads (reuse existing
  `/api/upload`).

`index.mjs` shrinks to a thin router: HTTP server + static `www/` +
`/pty` WS + mounts `rpc`/`events`. This monolith→router split is an
in-scope improvement justified by the heavy extension.

**Not changed:** all `src/main/*`, all `src/preload/*`, all
`src/renderer/*.tsx`, the `/pty` WebSocket protocol.

### Full window.api surface to mirror
38 request/response channels + 4 event subscriptions + 1 pure-local:

- **config:** configGet, configUpdate, projectMetaUpsert, projectMetaDelete
- **transport:** transportInfo
- **tmux:** tmuxList, tmuxNewSession, tmuxNewWindow, tmuxRenameSession,
  tmuxRenameWindow, tmuxKillSession, tmuxKillWindow, tmuxSelectWindow,
  tmuxConfigStatus, tmuxSetupConfig, tmuxRestoreConfig
- **git/fs:** gitListWorktrees, fsListDirs
- **clipboard:** clipboardWriteText, clipboardReadImage
- **files:** uploadFiles, uploadBuffer, getPathForFile (local),
  peekRemoteFile, openExternal
- **pty:** ptySpawn, ptyWrite, ptyResize, ptyKill
- **opencode:** opencodeMessages, opencodePrompt, opencodeAbort,
  opencodePermissions, opencodePermissionReply, opencodeQuestions,
  opencodeQuestionReply, opencodeQuestionReject, opencodeModels,
  opencodeDefaultModel, opencodeVcsBranch, opencodeListSessions,
  opencodeForkSession, opencodeCompactSession, opencodeDeleteSession,
  opencodeCommands, opencodeAgents, opencodeFindFiles, opencodeRunCommand,
  opencodeClearSession
- **event subscriptions (SSE):** onOpencodeEvent, onPtyEvent,
  onStatusEvent, onScreenshotDetected

## Data Flow

**Boot:** Capacitor loads `http://localhost/` → built renderer →
`main.tsx` sees no `window.api` → installs `httpApi` shim at saved server
URL (default `http://157.90.224.92:8787`) → shim opens one
`EventSource('/events')` → renderer calls `tmuxList()` etc. → list renders.

**Request/response:** `ChatPanel → window.api.opencodePrompt(args)` →
`POST /rpc/opencodePrompt` → `rpc.mjs` → `opencode.mjs` →
`POST 127.0.0.1:4096/session/{id}/prompt` → JSON back through chain →
Promise resolves.

**Streaming:** opencode `/event` SSE + pty output + status batches →
`events.mjs` fan-out → single `GET /events` SSE → shim demuxes by kind →
`onOpencodeEvent(cb)` → ChatPanel applies (delta inline; else
`scheduleRefetch()`). Renderer event handling is **unchanged** — same
`OpencodeEvent` objects, now over SSE not IPC.

**Terminal:** unchanged `/pty` WebSocket; renderer's `Terminal.tsx`
replaces the vanilla `app.js` terminal; same backend.

**Reconnection:** `EventSource` auto-reconnects; on reconnect the shim
fires a resync so the renderer refetches messages/permissions/questions
(mirrors desktop post-sleep/wifi-drop). Server sends SSE keep-alive
comments.

**Error handling:**
- `/rpc` handler throws → non-2xx + `{error}` → shim rejects Promise →
  renderer's existing try/catch shows it (same as Electron IPC rejection).
- opencode unreachable → 502 → surfaced; a health probe distinguishes
  "opencode down" from "server down".
- `clipboardReadImage` on phone → null (no desktop clipboard;
  documented, not an error). `uploadBuffer` → multipart, reuses upload
  route.

## Testing & Rollout

**Success criteria:** On the Android device, against the real box: open a
session → send prompt → streaming response → answer a QuestionCard →
answer a permission → live todos + branch + token/cost + compaction →
abort works → terminal view works. Device-verified via ADB/DevTools.

**Verification (per-slice device checks):**
1. shim + `/rpc` + `/events` skeleton with `tmuxList` → list loads.
2. opencode proxy → messages render + prompt streams.
3. permissions/questions → QuestionCard + permission reply work.
4. terminal via renderer `Terminal.tsx`.
5. session CRUD + git/fs.

Each slice is a working, demoable phone state. CDP smoke scripts used for
fast regression between slices (tooling, not a deliverable). No new vitest
suites (per scope); existing `chatUtils.test.ts` must still pass.

**Rollout:**
1. Land server + shim; desktop unaffected (separate `window.api` path —
   verified by running Electron app).
2. Build renderer → `mobile/www/`; `cap sync`; APK install.
3. Deploy to box: commit → push → pull on box → restart `bui-server`
   tmux session (established safe sequence; work sessions untouched).
4. Final device walkthrough of success-criteria flow.

**Risks & mitigations:**
- opencode SSE framing differs from assumptions → slice 2 verifies real
  event shapes against the proven `src/main/opencode.ts` parser first.
- Renderer hides an Electron-only global despite the comment → slice 1
  boots renderer in WebView early; gaps surface immediately.
- Vanilla `mobile/www/` client retired → stays in git history; rollback
  = revert the Capacitor `webDir` build step.
- **Open-port security worsens** (chat = full agent/shell control over an
  unauthenticated internet-exposed port) → **explicitly out of scope,
  documented as the #1 follow-up.** Recommended next: shared-token auth or
  ufw/IP restriction or authenticated reverse proxy before non-dev use.

## Out of Scope (follow-ups)

1. **Authentication / closing the open-port exposure** (highest priority).
2. Offline mode.
3. iOS build (scaffolded, deferred — needs Xcode/CocoaPods).

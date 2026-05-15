# bui chat-mode UI — context handoff (2026-05-15)

All chat-mode work is committed. Last session: committed existing backlog in
8 slices, then added paste + screenshot detection on top. See `AGENTS.md`
for the canonical architecture reference — this file tracks sprint-specific
state and gotchas that don't belong there.

## Current HEAD

```
04750fb chat-mode: fix screenshot detection — remove document.hidden gate, add debug logs
7cdd224 chat-mode: screenshot detection — toast + one-click 'Add to chat'
9b33d33 chat-mode: paste screenshots directly into chat input
e38002f docs: AGENTS.md updates + chat-mode handoff doc
bef638b chat-mode: mobile/web server (src/server/)
8d67d67 chat-mode: ChatPanel — full chat UI (~3340 LoC)
8d06a79 chat-mode: renderer wiring — App, Sidebar, store, CSS
6111f6c chat-mode: extend preload bridge with all opencode window.api methods
5557186 chat-mode: main-process IPC handlers + opencode SSE bus
52ee925 chat-mode: opencode HTTP client + SSH tunnel management (opencode.ts)
729cba5 chat-mode: deps + shared IPC types for opencode integration
```

## What's shipped in chat mode

- **Transcript + send/abort**.
- **Inline ToolCall dispatcher** with per-tool renderers
  (Read/Bash/Glob/Grep/TodoWrite/WebFetch/Edit/Write/MultiEdit), permission
  flow with trust-mode toggle.
- **UnifiedDiff renderer** with line-number gutter, +/− sign,
  bg-green-700/55 + bg-red-700/55 row backgrounds.
- **Model picker** — reads `/provider`, strips apiKey. Per-session in
  localStorage; stale picks auto-cleared. Default pre-fetched on mount.
- **Syntax highlighting** via `prism-react-renderer` (vsDark).
- **Session toolbar** — `⑂ fork / ⌥ compact / ✕ delete`.
- **Drag-drop + @-mention**: media → FilePart chip; everything else → `@path` text.
- **Paste** (`⌘V`) — intercepts `image/*` clipboard items → chip, same as drag-drop.
- **Screenshot detector** — clipboard poller (500ms) + `fs.watch ~/Desktop`.
  Toast above input: "Add to chat" / "×". Confirmed working 2026-05-15.
  Debug `[screenshot]` logs still in `main/index.ts` — remove once stable.
- **Markdown** — `react-markdown + remark-gfm`.
- **Slash commands** — `/clear /fork /compact /help` (bui-local) + opencode list.
- **Capability gate** — blocks attachments unsupported by active model.
- **session.error** surfaced as banner.
- **Visual polish**: full-bleed user msg bar, running indicator, end-of-turn ✻
  line, prompt history Up/Down, optimistic append, ActiveTodos pin.

## Known constraints / gotchas

- Sessions persist FileParts forever. Bad-mime FilePart (e.g. `application/json`)
  in history → every subsequent Anthropic call fails. Fix:
  `DELETE /session/{sid}/message/{mid}/part/{pid}` on each offender.
- `/api/model` leaks `apiKey` — never forward it. Use `/provider` (done).
- React.StrictMode is on. Effects run twice in dev. Cleanups must be clean.
- Mobile path (`src/server/index.mjs`) is NOT shimmed for chat-mode IPCs
  (models, sessions CRUD, commands, agents, find-files, run-command,
  default-model, clear-session, prompt with attachments, uploadBuffer,
  clipboardReadImage, screenshotDetected). Mobile work = add those shims.
- Screenshot detector: Desktop watcher only sees `~/Desktop`. If the user
  has configured macOS to save screenshots elsewhere (System Settings →
  Screenshots → Save to), the file path won't fire. Clipboard poller still
  works for `⌘⇧Control+3/4`.
- Antoine's prefs: terse, MVP over polish, no time estimates, no global
  tmux config changes, no mocks in tests.
- Always `npm run typecheck` before declaring done. Dev server is Linux;
  tested on Mac via rsync.

## Suggested next moves

- **Remove `[screenshot]` debug logs** from `main/index.ts` once confirmed stable.
- **Mobile responsive layout** — sidebar-as-drawer + touch targets + IPC shims
  in `src/server/index.mjs`.
- **Global model preference** — currently per-session in localStorage.
- **Tests** — none for chat UI yet.

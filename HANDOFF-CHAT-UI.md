# bui chat-mode UI — context handoff (this session)

You're picking up where a Claude Code session left off. All the work happened
on this dev server (`/home/dev/projects/better-ui`); Antoine tests on Mac via
rsync. The previous, broader handoff lives in `HANDOFF.md` — this file
focuses on the chat-mode UI sprint specifically.

## What bui is (recap)

Electron daily-driver. Two window types:
- **claude-TUI window** — a tmux window running the `claude` CLI
- **chat-mode window** — `sleep infinity` holder pane; bui mounts its own
  React `ChatPanel` on top of an opencode session

A chat-mode window is recognized by the tmux user-option `@bui-session-id`
set on the window (= the opencode session id).

## Locked architecture

- opencode runs in tmux session `bui-opencode` on this box, port 4096,
  bound to 127.0.0.1. Mac connects via SSH `-L 14096:127.0.0.1:4096`.
- Renderer never talks to opencode directly — only through
  `window.api.*` (preload bridge → main → HTTP/SSH).
- Main owns ONE long-lived SSE stream (`/event`) and forwards events to the
  renderer. ChatPanel filters by sessionID.
- Anthropic auth: `opencode-claude-auth@latest` plugin in
  `~/.config/opencode/opencode.jsonc`. Uses Claude Max sub via
  `~/.claude/.credentials.json`. Plugin loads on `opencode serve` startup.

## Key files (chat-mode UI lives here)

| File | What |
|---|---|
| `src/main/opencode.ts` | HTTP client, SSE consumer, ssh tunnel mgmt, server lifecycle |
| `src/main/index.ts` | IPC handlers, opencode bus loop, window mgmt |
| `src/main/pty.ts` | tmux helpers, `tmuxRestampSessionId` for /clear |
| `src/preload/index.ts` | window.api bridge |
| `src/shared/types.ts` | IPC channels + shared types |
| `src/renderer/ChatPanel.tsx` | entire chat UI (~2200 LoC), intentionally not split |
| `src/renderer/App.tsx` | mounts ChatPanels keyed by session id, passes owner ctx |

## What's shipped in chat mode

- **Transcript + send/abort** (Phase 1–2).
- **Inline ToolCall dispatcher** with per-tool renderers
  (Read/Bash/Glob/Grep/TodoWrite/WebFetch/Edit/Write/MultiEdit), permission
  flow with trust-mode toggle.
- **UnifiedDiff renderer** with line-number gutter, +/− sign,
  bg-green-700/55 + bg-red-700/55 row backgrounds, `@@` hunk headers
  silently parsed (no visible row).
- **Model picker** — `listModels` reads `/provider`, filters by
  `connected[]`. apiKey stripped before forwarding. Default model
  pre-fetched on mount so the footer label is meaningful before the first
  reply. Per-session selection in localStorage; stale picks (model not in
  current `connected`) auto-cleared.
- **Syntax highlighting** in fenced code blocks via `prism-react-renderer`
  (vsDark, transparent bg).
- **Session management** — footer toolbar `⑂ fork / ⌥ compact / ✕ delete`.
  Fork creates a new opencode session and a new tmux window stamped with
  the new id.
- **Drag-drop + @-mention** (agent-native pattern):
  - `@`-mention → path-as-text only. Inserts `@<rel-path>` in textarea.
    NO chip, NO FilePart. The AI calls its Read tool if it needs content.
  - Drag-drop, classified by mime:
    - `image/*`, `application/pdf`, `audio/*`, `video/*` → upload to
      `~/.bui-uploads/`, send as FilePart, chip shown.
    - Everything else → upload, then append `@<abs-path>` to textarea. No chip.
- **Markdown** — `react-markdown + remark-gfm`. Tight list spacing via
  `[&_p]:m-0` on ul/ol. No `whitespace-pre-wrap` on assistant text wrapper
  (was stacking raw newlines on top of block spacing).
- **Slash commands** — bui-local builtins `/clear /fork /compact /help`
  handled in renderer; opencode `/command` list merged after.
  `/clear` creates fresh opencode session, re-stamps tmux window's
  `@bui-session-id`, ChatPanel remounts.
- **Capability gate** — `mimeToInputMode` classifies file mimes; submit
  refuses attachments the active model can't take, with a clear banner
  (e.g., `"Claude Sonnet 4.6 doesn't accept foo.json (application/json)."`).
  text-mime files are "other" (not "text") because Anthropic only takes
  image/PDF in file content blocks.
- **session.error surfaced** — SSE event sets `sendError` so server-side
  failures (model not found, mime rejected) are visible — was previously
  silent.
- **Visual polish**:
  - User msg = full-bleed `bg-bg-soft` bar (`-mx-4 px-4 py-0.5`)
  - End-of-turn line `-ml-[8px] mt-3 ✻ Brewed for X` halfway between
    sidebar edge and bullet column
  - Running indicator `✻ <Verb>… (Xs · ↓ Yk tokens)` with pulsing glyph,
    `pt-0 pb-3` so above/below the ✻ line are visually equal
  - Sibling messages `space-y-3` (12px), matches scroll container pb-3
  - Bullets: tool-pending pulses grey, completed green, error red
  - Edit/Write header reads `Edit(path) · Added 5 lines, removed 3 lines`
  - Optimistic user-message append on submit (instant feedback)
  - Prompt history with Up/Down when typeahead is closed
  - `todowrite` tool calls hidden inline (pinned `ActiveTodos` is the
    single source of truth)

## Known constraints / gotchas

- Sessions persist FileParts forever. If you put a bad-mime FilePart in
  history (e.g., `application/json`), every subsequent prompt to Anthropic
  fails with `media type X functionality not supported` because the full
  history gets re-sent. Surgical fix:
  `DELETE /session/{sid}/message/{mid}/part/{pid}` on each offender.
- `/api/model` leaks `apiKey` in `options.aisdk.provider.apiKey` — never
  forward it raw. We hit `/provider` instead now.
- big-pickle has `attachment:false`; qwen has `attachment:true` but only
  image+video; Anthropic has image+PDF. Capability gate enforces.
- React.StrictMode is on. Effects run twice in dev. Cleanups must be clean.
- Mobile path (`src/server/index.mjs`) is NOT shimmed for the new IPCs
  added during this session (models, list/fork/compact/delete sessions,
  commands, agents, find-files, run-command, default-model, clear-session,
  prompt with attachments/mentions). Whoever lands mobile needs to add
  those shims.
- Antoine's prefs: terse responses, MVP over polish, no time estimates,
  don't modify tmux config globally, no mocks in tests.
- Always `npm run typecheck && npm run build` before declaring done. Dev
  server is Linux; tested on Mac via rsync.

## What's NOT committed

All chat-mode work is uncommitted; last committed point was `94cdb8a`.
Status at session end (from `git status`):
- M `src/main/index.ts` `src/main/pty.ts` `src/preload/index.ts`
  `src/renderer/App.tsx` `src/renderer/Sidebar.tsx` `src/renderer/store.ts`
  `src/renderer/index.css` `src/shared/types.ts` `package.json`
  `package-lock.json` `AGENTS.md`
- ?? `src/main/opencode.ts` `src/renderer/ChatPanel.tsx` `src/server/`

## Suggested next moves

- **Mobile responsive layout** — biggest remaining item. ChatPanel
  already uses only `window.api.*` so the mobile path can reuse it; main
  work is sidebar-as-drawer + touch targets + the IPC shims above.
- Tests — none for the chat UI yet.
- Persist model preference globally (currently per-session in localStorage).
- Commit the chat-mode work in coherent slices — it's all sitting
  uncommitted on `main`.

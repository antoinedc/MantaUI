# bui-native tools — design + the `schedule` tool

This documents the **extensible "bui tools" pattern** (so the remote AI gains
new capabilities bui owns) and its first instance, the **`schedule` tool**.

## The pattern (reusable for future tools: ping, etc.)

bui chat mode talks to **opencode**, not the `claude` TUI. opencode is the
agent runtime; bui is an HTTP client of it. For "any AI we run here" to *know
about and autonomously call* a bui capability, the capability must be a tool
**registered inside opencode**, globally.

opencode auto-loads global custom tools from `~/.config/opencode/tools/*.ts`.
They are available to **every project, every session, every model**, with zero
per-repo config. The tool's `execute` runs TypeScript in opencode's Bun runtime
**on the same Linux box** as bui-server (`127.0.0.1:8787`) and opencode itself
(`127.0.0.1:4096`). So a tool just `fetch`es bui-server — no SSH hop, same
trust boundary as the existing `/send-file` outbox convention.

Three pieces per tool:

1. **opencode tool** (`~/.config/opencode/tools/<name>.ts`) — thin registrar.
   Validates args, `fetch`es a bui-server `/api/...` endpoint, returns a short
   confirmation string. **No long-running work here** — `execute` must return
   promptly (it can't sleep for 5 minutes).
2. **bui-server endpoint + logic** (`src/server/*.mjs`) — the always-on,
   systemd-managed process owns durable state and any long-lived loop. This is
   where the real behavior lives.
3. **Global guidance** (`~/.config/opencode/AGENTS.md`) — one line telling the
   model when to use the tool. The tool's `description` field is also sent to
   the model and is often enough on its own; AGENTS.md is the reliability
   backstop.

Source of truth for the remote files is committed under `docs/opencode-tools/`.
The tool is **COPIED** (not symlinked) into `~/.config/opencode/tools/` on the
box. Install:

```bash
mkdir -p ~/.config/opencode/tools
cp <repo>/docs/opencode-tools/schedule.ts ~/.config/opencode/tools/schedule.ts
# AGENTS.md is appended/merged (it may hold other guidance):
cat <repo>/docs/opencode-tools/AGENTS.md >> ~/.config/opencode/AGENTS.md
# then restart opencode so it re-scans tools/:
systemctl --user restart opencode-serve
```

**DO NOT symlink the tool.** opencode resolves a tool's imports relative to the
file's REAL path. A symlink points back into `<repo>/docs/opencode-tools/`,
which has no `node_modules`, so the `import { tool } from "@opencode-ai/plugin"`
fails at load with `Cannot find module '@opencode-ai/plugin'` and the tool
silently never registers. A real copy inside `~/.config/opencode/tools/`
resolves the import up the tree to `~/.config/opencode/node_modules/`. (The
`/send-file` *command* can be symlinked because it's plain markdown with no
imports — tools are not.)

opencode runs as the **`opencode-serve` systemd --user service** (NOT a
`bui-opencode` tmux session — that reference elsewhere is stale). It re-scans
`tools/` on `systemctl --user restart opencode-serve`. Note: restarting
opencode severs any live bui chat connection to `:4096` mid-turn.

## The `schedule` tool — behavior

Model calls `schedule` when the user says things like "check on the task every
5 minutes", "remind me in 45 minutes to push", "every weekday at 9am summarize
open PRs".

- **Args**: `cron` (5-field string), `prompt` (what to run), `recurring`
  (bool; false = one-shot), optional `label`.
- The model converts natural language → cron itself (it's good at this, and it
  mirrors Claude Code's `CronCreate` contract). bui does NOT parse NL.
- Tool POSTs `{cron, prompt, recurring, label, sessionID}` to
  `POST /api/schedule`. `sessionID` comes from the tool `context` so the fired
  prompt lands back in the **same chat session** the user is in.

### Durability (locked decision: server-owned)

Jobs live on **bui-server**, fired by the always-on systemd process. They
survive: Mac app close, chat session navigation, and box reboot (systemd
`enable-linger`). This is strictly more durable than Claude Code's
session-scoped `/loop`, which dies with the session.

- **Store**: `~/.bui-mobile/schedule.json`, atomic temp-rename writes (same
  pattern as `local.mjs` config). Shape:
  ```json
  { "jobs": [ {
      "id": "a1b2c3d4",            // 8-char, like CronCreate
      "cron": "*/5 * * * *",
      "prompt": "check the deploy",
      "recurring": true,
      "label": "deploy check",
      "sessionID": "ses_...",
      "directory": "/home/dev/projects/x",   // resolved for the scoped POST
      "createdAt": 1718900000000,
      "lastFiredMinute": "2026-06-20T15:05"   // dedup guard, minute granularity
  } ] }
  ```

### Firing — `src/server/schedule.mjs`

Mirrors the outbox poller idiom exactly (`createScanner` + `start*` +
`inFlight` guard + `timer.unref()`):

- `createScheduler({ loadJobs, saveJobs, sendPrompt, now })` → `{ tick }`
  (pure-ish, dependency-injected → testable without timers/opencode).
- `startSchedulePoller(deps, { intervalMs = 30000 })` → `{ stop }`.
- Each tick:
  1. `now` → current minute key (`YYYY-MM-DDTHH:mm`, **local time** — cron is
     interpreted in box-local tz, matching Claude Code).
  2. For each job: `cronMatches(job.cron, now)` AND
     `job.lastFiredMinute !== minuteKey` (no double-fire within a minute, and
     **no catch-up** for missed minutes while the box was off — fire once when
     due, like Claude Code).
  3. Fire: `await sendPrompt({ sessionId: job.sessionID, text: job.prompt })`.
     Set `job.lastFiredMinute = minuteKey`. If `!recurring`, delete the job.
  4. Persist the mutated job list.
- **Tick cadence 30s** (not 1s like Claude Code): minute-granularity cron only
  needs sub-minute polling; 30s guarantees every minute is observed once. The
  `lastFiredMinute` guard makes double-observation within a minute a no-op.

### Cron matcher — `cronMatches(expr, date)` (pure, tested)

5-field `minute hour day-of-month month day-of-week`. Each field supports:
`*`, single value, `*/step`, `a-b` range, and `a,b,c` lists (composed). DOW
`0` and `7` = Sunday. **vixie-cron semantics**: when both DOM and DOW are
restricted, match if *either* matches. No `L`/`W`/`?`/name-alias extended
syntax (parity with Claude Code's documented subset). Invalid expr → tool
rejects at create time (matcher returns a validation result).

### HTTP endpoints — `src/server/index.mjs`

Added as `path === "/api/schedule"` blocks alongside the existing
`/api/upload`, `/api/download`, `/api/shared-config`:

- `POST /api/schedule` — body `{cron, prompt, recurring, label, sessionID}`.
  Validates cron (400 on bad), resolves `directory` from the session, appends a
  job with a fresh 8-char id, returns `{id, cron, recurring}`.
- `GET /api/schedule` — returns `{jobs:[...]}` (id, cron, prompt, recurring,
  label) so the model (via the tool) and a future UI can list.
- `DELETE /api/schedule?id=<id>` — removes by id, returns `{deleted:bool}`.

The tool surfaces create/list/delete so the user can also say "what's
scheduled?" / "cancel the deploy check".

### Fired prompt UX

`sendPrompt` posts a normal user turn into the existing session. opencode
streams it back over the SSE bus into the **same ChatPanel** the user already
has open — the scheduled work just appears inline as a new turn. (A future
enhancement: tag the turn as schedule-originated so the renderer can badge it.)

## Management UI — view + delete schedules

The model can list/cancel via natural language, but that's discoverable-only.
v1 ships a real UI surface so the user can always see what's pending and kill it.

### Transport wiring — `schedule:*` channels (NOT `opencode:*`)

Schedules are a **bui-server** concept, not an opencode concept, so they get
their own `window.api` channels that hit bui-server's `/api/schedule`
endpoints — they do NOT route through the opencode client methods. New methods
(both transports, kept in sync per the AGENTS.md rule):

- `scheduleList(sessionId?)` → `ScheduledJob[]` (optionally filtered to the
  current session; the card shows only this session's jobs, a future global
  view could pass none).
- `scheduleDelete(id)` → `{ deleted: boolean }`.

Six edit sites (the standard new-`window.api`-method pattern):

| Site | Desktop | Mobile |
|---|---|---|
| IPC const | `src/shared/types.ts` `IPC.scheduleList` / `scheduleDelete` | same |
| Renderer call | `src/preload/index.ts` (ipcRenderer.invoke) | `src/renderer/api/httpApi.ts` (`rpc(...)`) |
| Handler | `src/main/index.ts` ipcMain.handle | `src/server/rpc.mjs` `buildHandlers` dispatch |
| Impl | `src/main/schedule.ts` (NEW — `fetch`es bui-server `/api/schedule` over the existing `-L 18787` presence forward, OR direct if reachable) | `src/server/schedule.mjs` calls in-process (no HTTP needed; same process) |

**Desktop reach to the server store**: the scheduler store lives on
bui-server. Desktop already opens a best-effort `-L 18787:127.0.0.1:8787`
forward for push presence (`ensurePresenceForward` in `src/main/opencode.ts`).
`src/main/schedule.ts` reuses that forward to `GET`/`DELETE`
`127.0.0.1:18787/api/schedule`. If the forward is down, desktop list/delete
degrades to an error toast ("schedule server unreachable") — the jobs still
fire (server-owned), the user just can't manage them from desktop until the
forward heals. Mobile is in-process so always works.

### The `ScheduledTasksCard` — pinned card above the composer

Modeled on `PermissionCard` (`ChatPanel.tsx:4815`), rendered as a
`shrink-0 px-4 pt-2` sibling above the composer near the RetryCard slot
(`ChatPanel.tsx:3824`), gated on a `showSchedules` state. **Auto-renders on both
desktop and mobile** — it's a card, not a footer toolbar item, so the
mobile-CSS footer hiding (`mobile.css:260`) does NOT affect it. No mobile CSS
edits required.

Card contents:
- Header: `⏰ Scheduled` + count.
- One row per job: `label || prompt` (truncated) · human-readable cadence
  (`describeCron(cron)` — pure helper, "every 5 min", "weekdays 9:00", "once at
  15:00") · a `✕` delete button per row.
- Empty state: "No scheduled tasks" (shown briefly if opened with none).
- Dismiss `×` in the header closes the card (`setShowSchedules(false)`).
- Delete row → `scheduleDelete(id)` → optimistic remove from local state →
  refetch via `scheduleList`.

State in ChatPanel: `showSchedules: boolean`, `schedules: ScheduledJob[]`,
fetched via `scheduleList(sessionId)` when the card opens AND refreshed on a
new `schedule.updated` bus event (see below). Reset on session change.

### Entry points (open the card)

- **Desktop**: a `⏰ schedules` button appended to `SessionToolbar`
  (`ChatPanel.tsx:4561`, next to fork/compact/delete). Sets `showSchedules`.
  Optionally show a count badge when `schedules.length > 0` so the user knows
  jobs exist without opening it.
- **Mobile**: `SessionToolbar` is hidden by mobile CSS, so add a
  "Scheduled tasks" button to the mobile `⋯` bottom-sheet
  (`src/renderer/mobile/SessionScreen.tsx:246-264`) that flips the same
  `showSchedules` state (lifted/passed into ChatPanel, or toggled via a small
  shared store flag — match how the sheet's other actions reach ChatPanel).

### Freshness — refetch-on-open + open-poll (NOT a new event channel)

The card must stay current when a job is created (by the model) or auto-deleted
(one-shot fired). The clean cross-transport way is refetch-driven, NOT a new
bus event:

- Refetch `scheduleList(sessionId)` when the card opens.
- While the card is open, a lightweight poll (~10s) refetches so a
  model-created or just-fired job appears without reopening.
- Refetch after the user deletes a row (optimistic remove + reconcile).

**Why not a `schedule.updated` bus event reaching the renderer?** On *mobile*
the renderer subscribes to bui-server's `/events` bus over WS, so a new
`schedule.updated` kind would work. But on *desktop* the renderer is wired to
the Electron main process's opencode SSE bus — it does NOT subscribe to the
mobile server's in-process bus, so the event never arrives without building a
whole desktop→server event bridge. Refetch-on-open + open-poll is identical on
both transports and far less plumbing for v1. bui-server still PUBLISHES
`schedule.updated` on every mutation (cheap, already wired) so a future mobile
optimization can consume it, but the UI does not depend on it.

### `describeCron(cron)` — pure helper (tested)

Lives in `chatUtils.ts` (renderer-pure, Vitest). Best-effort
cron→human-readable: covers the common shapes the model emits (`*/N * * * *` →
"every N min", `0 H * * *` → "daily H:00", `M H * * 1-5` → "weekdays H:MM",
single-fire one-shots → "once at H:MM"). Falls back to the raw cron string for
anything it doesn't recognize — never throws, never blocks rendering.

## What is NOT in v1 (deliberate scope cuts)

- **No desktop-main duplication.** The scheduler lives only on bui-server. The
  desktop app already reaches opencode through the same box; jobs fire
  regardless of whether the Mac app is open. A desktop-side scheduler would
  double-fire — explicitly avoided. (If desktop ever runs without the box…
  it can't; opencode IS on the box.)
- **No jitter / 7-day expiry.** Claude Code adds these for multi-tenant API
  fairness and forgotten-loop bounding. bui is single-user on one box; skip for
  v1. Revisit if recurring jobs accumulate.
- **No global "all sessions" schedule view.** The `ScheduledTasksCard` shows
  only the current session's jobs. `scheduleList()` with no sessionId returns
  all jobs, so a global view (e.g. in Settings) can be added later with no
  backend change.
- **No edit-in-place.** To change a schedule, delete + recreate (ask the
  model). An edit form is a future enhancement.
- **`ping` tool** — same pattern, deferred to a fast-follow (reuses
  `src/server/push.mjs` `firePush`). Not built in this pass.

## Test coverage (`src/server/schedule.test.mjs`, node:test)

Pure logic only (no timers, no live opencode):
- `cronMatches`: `*`, step, range, list, DOM/DOW either-match semantics,
  invalid-expr rejection, boundary minutes.
- `createScheduler.tick`: fires a due job (via injected `sendPrompt` spy),
  sets `lastFiredMinute`, does NOT double-fire same minute, deletes one-shot
  after firing, keeps recurring, persists via injected `saveJobs`, publishes
  `schedule.updated` on one-shot auto-delete.

Renderer-pure (`chatUtils.test.ts`, Vitest):
- `describeCron`: common shapes (`*/N`, daily, weekdays, one-shot) + raw-string
  fallback for unrecognized expressions (never throws).

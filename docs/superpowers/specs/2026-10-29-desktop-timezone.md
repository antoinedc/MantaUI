# Box follows the desktop's timezone

Status: agreed (Option B from the 2026-10-29 discussion)

## Problem

The AI states every time in UTC. The box clock is UTC, opencode runs with no
`TZ`, so everything the model sees is UTC: opencode's own "Today's date" line,
`date` and any command it runs, file/log timestamps. The desktop never tells the
box which timezone the user is in. Scheduled prompts have the same defect: cron
is evaluated in the box's local time (UTC), so "every day at 9am" fires at 09:00
UTC.

## Decision

The desktop reports its OS timezone; the box adopts it **process-wide** for
opencode (by setting `TZ` on the opencode service and restarting it, deferred
until no work is running) and for manta-server (by setting `process.env.TZ` at
runtime, no restart). The AI then sees local times everywhere without any
prompt engineering, and schedules fire in local time with correct DST.

Rejected alternatives (recorded for posterity):
- An opencode plugin injecting "the user's timezone is X" into the system
  prompt — the model still sees UTC everywhere and has to remember to convert.
- A line in the global AGENTS.md — same weakness.
- Setting the box's system timezone (`timedatectl`) — needs root, affects
  every other service on the box.

Libraries considered: none needed. IANA timezone resolution and validation are
built into Node/Electron (`Intl.DateTimeFormat().resolvedOptions().timeZone`,
`new Intl.DateTimeFormat("en-US", { timeZone })`), and Node honours a runtime
assignment to `process.env.TZ` (it resets its timezone cache on assignment).

## Contract

### 1. Desktop → box (wire)

The existing desktop presence heartbeat (`src/main/desktopPresence.ts`,
`POST /push/desktop-presence`, every 30s + on lock/unlock/suspend/resume) gains
one optional field:

```json
{ "idleSeconds": 12, "lockedSeconds": null, "timeZone": "Europe/Paris" }
```

- `timeZone` = `Intl.DateTimeFormat().resolvedOptions().timeZone`, read fresh on
  every heartbeat (so a change is picked up when Electron notices it; at worst on
  next app launch — acceptable).
- Omitted when the value is empty/undefined. An old desktop sends no field →
  server does nothing (no change in behaviour).
- No new route, no new RPC channel.

### 2. Validation (server, pure)

`isValidTimeZone(tz)`:
- string, 1–64 chars, matches `^[A-Za-z0-9_+\-/]+$` (no spaces, quotes, `=`,
  newlines — this value is written into a systemd unit and passed to PlistBuddy),
- AND `new Intl.DateTimeFormat("en-US", { timeZone: tz })` does not throw.

Invalid → ignored (logged once per distinct value), never written anywhere.

### 3. Server state

New module `src/server/boxTimeZone.mjs` (pure logic + injected I/O, same
dependency-injection style as `upgradeV2Service.mjs` / `delegate.mjs`).

- **Desired timezone** persisted in the server config (`~/.manta/config.json`
  via `configGet`/`configUpdate`) as `boxTimeZone: string | null`. Last valid
  report wins (single-user box; if two desktops disagree, the last heartbeat
  wins — see rate limit below).
- **manta-server apply**: when the desired value changes, and once at server
  boot from the stored value, set `process.env.TZ = desired`. Immediate, no
  restart. This makes `schedule.mjs` (which uses local `getHours()` etc.)
  evaluate cron in the user's timezone.
- **opencode apply**: the opencode service definition carries `TZ=<desired>`:
  - systemd: `Environment=TZ=<tz>` in `~/.config/systemd/user/opencode-serve.service`
    `[Service]`, then `systemctl --user daemon-reload`.
  - launchd: `:EnvironmentVariables:TZ` in `~/Library/LaunchAgents/com.mantaui.opencode.plist`.
  - nohup fallback: not supported — log once and skip (opencode stays UTC).
  Reuse `createOpencodeService` / `patchUnitText` in `src/server/upgradeV2Service.mjs`;
  add a narrow method (e.g. `setEnv({ TZ })`) that patches ONLY the given keys
  and does NOT touch the binary or the V1/V2 env that `configure()` manages.
  `configure()` must keep preserving an existing `TZ` line (verify; add a test).
- **Reconciliation compares against the actual service definition**, not just the
  stored value: read the unit/plist's current `TZ`. If it already equals desired,
  nothing to do. This covers a re-install that re-renders the unit without `TZ`
  (the next boot/heartbeat re-applies it).

### 4. Restart policy (the load-bearing part)

Writing `TZ` into the definition does nothing until opencode restarts, and a
restart ends every in-flight turn box-wide. Therefore:

1. Write the definition change immediately (cheap, inert).
2. Mark "restart owed". Restart opencode ONLY when the box has **no active
   work**: no session running a turn, no running background (delegate) job, and
   no pending question/permission. Use the server's authoritative running-state
   source (`sessionStatus` running set / `sessionsWithActiveWork`, and/or
   opencode's own session-status endpoint) — the implementer picks the
   authoritative one and documents it; it must not be a guess from transcripts.
3. Check whenever a session goes idle and on a timer (≤60s). Never restart while
   work is active, however long that takes.
4. Restart mechanism: systemd → existing `restartOpencode()` in
   `opencodeAdmin.mjs` (it also opens the providers-cache grace window);
   launchd → `bootout` + `bootstrap` (`createOpencodeService().start()`), NEVER
   `kickstart -k` (restarts from launchd's stale in-memory definition).
5. **Rate limit**: at most one timezone-driven opencode restart per 10 minutes.
   If the desired value changes again inside the window, the definition is
   updated and the restart waits for the window to pass. Prevents ping-pong if
   two devices report different zones.
6. Race: re-check "no active work" immediately before issuing the restart.

Logging (one line each, `[timezone]` prefix): desired changed (old → new),
definition written, restart deferred (reason), restart done, invalid value.

### 5. Schedules

No scheduler code change is required for the core behaviour (cron uses local
time, which now follows `process.env.TZ`). Requirement: a timezone change must
not make a job fire twice for the same real minute (check `minuteKey` /
`lastFiredMinute` dedup across a TZ change; fix if it can double-fire, with a
test). Existing schedules authored under UTC will from now on fire at that wall
time in the user's zone — accepted, called out in the PR deploy notes.

The `schedule_create` tool description / AGENTS blurb that says cron is in "box
local time" stays true; no text change needed unless it says UTC (check).

## Out of scope

- iOS reporting its timezone.
- A Settings UI showing/overriding the box timezone.
- claude-TUI tmux windows (their shells inherit the tmux server env).
- Changing the host's system timezone.

## Tests (required)

Pure/injected only (no real systemctl/launchctl, the suite runs on a live box):
- `isValidTimeZone`: accepts `Europe/Paris`, `America/Argentina/Buenos_Aires`,
  `UTC`, `Etc/GMT+5`; rejects `""`, `Foo/Bar`, `Europe/Paris\nX=1`, `a b`, `"x"`,
  65-char strings, non-strings.
- Reconciler: same tz → no write/no restart; new tz → definition written,
  restart deferred while work active, performed once idle; rate limit honoured;
  re-check before restart; unit missing `TZ` after re-install → re-applied;
  nohup → skipped, no throw; invalid tz → nothing written.
- `patchUnitText` / new `setEnv`: adds/replaces `TZ` only; `configure()` keeps it.
- launchd path uses bootout+bootstrap (injected exec records the argv).
- Presence route passes `timeZone` through; old body without it → no-op.
- Desktop: heartbeat body includes `timeZone` (unit-test the body builder).
- Schedule: no double fire across a TZ change.

## Done

- `npm run typecheck`, `npm test` green.
- On the dev box (systemd), with a desktop reporting `Europe/Paris`: unit has
  `Environment=TZ=Europe/Paris`, opencode restarted only while idle, and a new
  chat asked "what time is it" (running `date`) answers in Paris time.

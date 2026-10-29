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

- `timeZone` = `Intl.DateTimeFormat().resolvedOptions().timeZone`, read inside
  `report()` on every beat (never cached at start), so a change is picked up when
  Electron notices it; at worst on next app launch — acceptable.
- Extract the body into a pure, exported `buildPresenceBody({idleSeconds,
  lockedSeconds, timeZone})` that omits an empty `timeZone`; that is the test target.
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

All logic lives in `src/server/boxTimeZone.mjs`. The `/push/desktop-presence`
route in `index.mjs` adds ONE fire-and-forget call,
`boxTimeZone.noteReported(body?.timeZone)`, which only validates and records the
desired value in memory/config and pokes the reconciler. It never awaits unit
writes, daemon-reload or restarts in the request (the heartbeat has a 4s client
timeout and the presence TTL depends on it landing).

New module `src/server/boxTimeZone.mjs` (pure logic + injected I/O, same
dependency-injection style as `upgradeV2Service.mjs` / `delegate.mjs`).

- **Desired timezone** persisted in the server config (`~/.manta/config.json`
  via `configGet`/`configUpdate`) as `boxTimeZone: string | null`. Missing key
  reads as `null`. Written ONLY when the value changes (never every heartbeat).
  Last valid report wins (single-user box; if two desktops disagree, the last
  heartbeat wins — see rate limits below).
- **manta-server apply**: when the desired value changes, and once at server
  boot from the stored value, set `process.env.TZ = desired` — through an
  injected `setProcessTz` (default `(tz) => { process.env.TZ = tz }`), the ONLY
  place the env var is touched. Tests always inject a recorder (the suite runs
  on a live box and `process.env.TZ` is process-wide and sticky). Immediate, no
  restart. This makes `schedule.mjs` (which uses local `getHours()` etc.)
  evaluate cron in the user's timezone.
- **opencode apply**: the opencode service definition carries `TZ=<desired>`:
  - systemd: `Environment=TZ=<tz>` in `~/.config/systemd/user/opencode-serve.service`
    `[Service]`, then `systemctl --user daemon-reload`.
  - launchd: `:EnvironmentVariables:TZ` in `~/Library/LaunchAgents/com.mantaui.opencode.plist`.
  - nohup fallback: not supported — log once and skip (opencode stays UTC).
  - nohup: mark handled for this process so it isn't retried/logged every 30s.
  Reuse `createOpencodeService` / `patchUnitText` in `src/server/upgradeV2Service.mjs`;
  add narrow methods `readEnv(key)` and `setEnv({ KEY: value })` that touch ONLY
  the given keys, never the binary or the V1/V2 env `configure()` manages.
  `setEnv` REJECTS null/empty values (`patchUnitText` treats those as "delete
  the line"); systemd path keeps mode 0600 + chmod (the unit carries
  OPENCODE_PASSWORD) and runs `daemon-reload` only when the text changed;
  launchd path uses PlistBuddy Set-else-Add and fails loudly (restart stays
  owed, logged) if `:EnvironmentVariables` is missing. `configure()` must keep
  preserving an existing `TZ` line (add a test).
- **Definition-write bound**: the definition is written at most once per 60s;
  if desired changes faster (two devices disagreeing), the latest value is
  written at the next opportunity.
- **Reconciliation compares against the actual service definition**, not just the
  stored value: read the unit/plist's current `TZ`. If it already equals desired,
  nothing to do. This covers a re-install that re-renders the unit without `TZ`
  (the next boot/heartbeat re-applies it). Reconcile runs at server boot (from
  the stored value), on desired change, and on the restart-check timer.
- Known interactions: `install.sh` re-renders the unit from its template (drops
  `TZ`; re-applied by reconcile → one extra opencode restart after a reinstall,
  accepted). `self-update.sh`'s `ensure_opencode_cli_version` patches in place
  and preserves `TZ` (on macOS it also bootout/bootstraps, which applies TZ).

### 4. Restart policy (the load-bearing part)

Writing `TZ` into the definition does nothing until opencode restarts, and a
restart ends every in-flight turn box-wide. Therefore:

1. Write the definition change immediately (cheap, inert).
2. Mark "restart owed" (in memory; re-derived at boot by comparing the
   definition's `TZ` with the RUNNING opencode — see below). Restart opencode
   ONLY when the box is **idle**, defined by exactly one predicate:
   `listActiveSessionIds()` (opencode.mjs → `GET /api/session/active`, opencode's
   own global running set) **succeeds AND returns an empty list**. A session
   blocked on a question/permission and a running delegate job's child are both
   mid-turn, so both appear in that set. If the read throws (opencode down,
   booting, timeout) the state is UNKNOWN → defer, never restart. Do NOT use the
   server's `sessionStatus` running set (empty until async hydration completes).
   - Detecting "the running opencode already has this TZ" after a manta-server
     restart: read `/proc/<MainPID>/environ` (systemd, via `readOpencodeMainPid`)
     for `TZ=`; if unreadable (macOS), treat as owed only when this process
     wrote the definition. Keep it simple; document the choice.
3. Check whenever a session goes idle and on a timer (≤60s). Never restart while
   work is active, however long that takes.
4. Restart mechanism: systemd → existing `restartOpencode()` in
   `opencodeAdmin.mjs`; launchd → `launchctl bootout gui/<uid>/com.mantaui.opencode`
   (failure tolerated) then `launchctl bootstrap gui/<uid> <plistPath>`
   (`createOpencodeService().start()`), NEVER `kickstart -k` (restarts from
   launchd's stale in-memory definition). Both paths call
   `invalidateProvidersCache({ restarted: true })`. The owed flag is cleared ONLY
   on a confirmed success; on failure log and retry on the next check, with the
   rate limit below applying to attempts.
5. **Rate limit**: at most one timezone-driven opencode restart per 10 minutes.
   If the desired value changes again inside the window, the definition is
   updated and the restart waits for the window to pass. Prevents ping-pong if
   two devices report different zones.
6. Race: re-check "no active work" immediately before issuing the restart.

Logging (one line each, `[timezone]` prefix): desired changed (old → new),
definition written, restart deferred (reason), restart done, invalid value.

### 5. Schedules

No scheduler code change is required for the core behaviour (cron uses local
time, which now follows `process.env.TZ`). Invariant to state in a code comment
and pin with a test: the dedupe key (`minuteKey` / `lastFiredMinute`) is
WALL-CLOCK, which is why a TZ change (or DST fall-back) cannot fire a job twice
for the same wall minute. A forward jump skips that minute — accepted; do not
"fix" it by switching to epoch minutes.

Other local-time consumers (CTO digest/rollups/profile/health day bucketing:
`ctoDigest.mjs`, `ctoRollups.mjs`, `ctoProfile.mjs`, `ctoHealth.mjs`) will
re-bucket on the switch day. Accepted; listed in the PR notes, no code change. Existing schedules authored under UTC will from now on fire at that wall
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
- Reconciler (all I/O injected, incl. `setProcessTz`, clock, active-sessions read,
  service, config): same tz → no write/no restart; new tz → definition written,
  restart deferred while sessions active, deferred when the active read throws,
  performed once idle; owed flag kept on restart failure; restart rate limit and
  definition-write bound honoured; re-check right before restart; unit missing
  `TZ` after re-install → re-applied; nohup → skipped once, no throw; invalid tz
  → nothing written; `noteReported(undefined)` → no-op.
- Config: file without the key reads `null`; set → reload → same; other keys
  untouched.
- `patchUnitText` / new `setEnv`: adds/replaces `TZ` only; `configure()` keeps it.
- launchd path uses bootout+bootstrap (injected exec records the argv).
- Desktop: `buildPresenceBody` includes `timeZone`, omits it when empty.
- Schedule: same job, TZ switched between two instants in the same wall minute
  → one fire (run in a child process or with TZ restored, never leaking).

## Done

- `npm run typecheck`, `npm test` green.
- On the dev box (systemd), with a desktop reporting `Europe/Paris`: unit has
  `Environment=TZ=Europe/Paris`, opencode restarted only while idle, and a new
  chat asked "what time is it" (running `date`) answers in Paris time.

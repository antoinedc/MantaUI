# Handoff: UI shows "processing" after the agent turn actually completed

**Date:** 2026-05-19  ·  **main tip when written:** `5ccf149`  ·  **Status:** NEW symptom, not yet investigated. Distinct from everything fixed this session.

## TL;DR
The agent does **not** hang. Server-side the turn **completes normally**
(question answered → resumed → response written → `step-finish`). The
**renderer stays stuck on the spinner** because the *completion* SSE events
(`session.idle`, final `message`/`step-finish`) never reach the UI — a
mid-stream drop on that one session's scoped stream right after the first
post-answer frame ("got a first line then hangs"). Work is done; only the
UI is wrong.

## Hard evidence gathered (2026-05-19, ~00:33–00:45)
- 3 most-recent sessions all show last assistant msg =
  `['step-start','text','step-finish']`, `question_parts=[]` →
  **turn finished server-side.** (`/session/{id}/message` probe.)
- Direct opencode probe (`127.0.0.1:4096`, bypassing all tunnels) returns
  only `server.connected` when idle → that "looks stalled" pattern is
  just **opencode being idle**, NOT a stall. Don't be misled by it again.
- Bus log (`/tmp/better-ui-preview.log`): every stream `event#0
  server.connected`, no `STALLED`, no heartbeats logged — consistent with
  idle streams; the watchdog correctly did NOT fire (no active work by the
  time it checked).
- Running app PID 23736, built 00:27:18, had `5ccf149` code (7 refs). So
  the dedicated-tunnel + heartbeat-aware fixes WERE present.

## Why this is a NEW root cause (not the prior fixes)
Everything landed this session (`575a9e4`, `10fa544`, `03e4457`,
`5ccf149`) addresses: question display/reply, scoped `?directory=`,
transport isolation, half-dead-mux detection. **None** addresses:
**a scoped stream that delivers the FIRST post-resume frame then drops
before `session.idle`/`step-finish`, leaving the renderer's per-session
"running" state stuck true.**

## Prime hypotheses for next session (UNVERIFIED — investigate, don't assume)
1. **Watchdog timing race:** the stall happens, but the turn finished
   server-side so `session.idle` *should* flip `activeWorkByDir` false —
   except if `session.idle` is the very event that got dropped,
   `activeWork` stays true and mode-B *should* fire. Check: did the
   watchdog interval run? did `eventTunnelRestart` happen? Is
   `STREAM_STALL_MS` (45s) just longer than the user's patience (they
   call it "hanging" at <45s)?
2. **Renderer-side completion state:** even if the stream reconnects and
   re-fetches, does the renderer clear its "running"/spinner on
   message-refetch? Trace `ChatPanel` running-state: `session.idle` /
   `session.status idle` handlers (~line 635-680) + whether the
   reconnect-driven `opencodeMessages` refetch resets `running`. The
   completion may be IN the refetched transcript but the UI never
   recomputes "done" from it.
3. **Dedicated-tunnel per-stream drop:** the 14097 tunnel is one process
   carrying ALL scoped event streams. If it drops one stream's chunked
   response but the process stays alive, `subscribeEvents` for that dir
   ends → bus reconnect loop should re-open it. Verify the reconnect
   actually re-fires and re-delivers, and that a re-fetch closes the UI
   gap.

## Reproduction (do this FIRST next session)
1. Clean rebuild from `main`: `pkill -f electron-vite; rm -rf out;
   npm run build && npm run preview` (the prior running build's timing
   vs `5ccf149` commit was ~90s off — rule out stale build entirely).
2. Open a NEW session, ask the agent to use the question tool, answer it.
3. Watch: does the UI clear the spinner when the turn finishes? Tail
   `/tmp/better-ui-preview.log` for `STALLED` / `event tunnel` /
   `stream CONNECTED` around the answer. Cross-check server-side
   `/session/{id}/message` for `step-finish`.
4. If UI stuck but server shows `step-finish` → confirmed; focus
   hypothesis 2 (renderer completion state) — likeliest, and cheapest
   to fix, since transport recovery may be working but the UI doesn't
   recompute "done" after a reconnect-refetch.

## Accepted scope (do NOT reopen)
Pre-existing-question sessions + the tilde-corrupted
`/home/dev/~/projects/...` session stay broken — user explicitly
accepted. New sessions are the target.

## Housekeeping carried over
- AGENTS.md lines ~424-427 still document the DEAD `/question` REST
  mechanism — wrong; update to event-payload + scoped-reply + dedicated
  tunnel when doing the next docs pass.
- gstack upgrade 0.8.5 → 1.40.0.0 pending (deferred all session).

# bui-native tools — the `notify` tool + cross-device notification routing

This is the fourth **bui-native opencode tool** (after `schedule`, `serve_page`,
`peers`) and the first to add a **desktop OS notification leg** alongside the
existing mobile Web Push. It also introduces the **single notification router**
that decides — for *every* notification, automatic or AI-triggered — whether it
goes to desktop, mobile, both, or escalates from one to the other, with **no
duplicates**.

Read `docs/bui-tools-scheduler.md` first for the reusable "bui tools" pattern
(global opencode tool → thin registrar → bui-server endpoint + durable logic).
This doc only covers what's notify-specific.

## Why a single router

"No duplicates" requires that **one place** knows the state of *all* devices at
decision time. Before this feature, two facts were split:

- bui-server (`src/server/push.mjs`) owned the **mobile** leg (Web Push) and
  already tracked desktop presence (`_desktop`) + mobile focus (`_focus`).
- The desktop Electron app had **no notifications at all**.

So bui-server is the natural sole arbiter: it already sees every opencode event
(the `firePush` call in the opencode pump) and already holds both presence
signals. We extend it to also drive the desktop leg. The desktop app does not
make its own routing decisions — it only *renders* the OS notification the
server tells it to (with one local refinement, below).

```
opencode event ─┐
AI notify tool ──┤→ bui-server router (push.mjs)
                 │      ├─ desktop leg → bus "desktopNotify" → SSH -L 18787
                 │      │                 → Electron app → new Notification()
                 │      └─ mobile leg  → Web Push (VAPID) → PWA service worker
```

- **Mobile leg** = existing Web Push, unchanged transport.
- **Desktop leg** = the Electron main process subscribes to bui-server's
  existing `GET /events` SSE **over the already-open `-L 18787` presence
  forward** and reacts only to a new `kind:"desktopNotify"` envelope by showing
  an Electron `Notification`. (Desktop already gets opencode events from its own
  `:4096` stream, so it must ignore the bus's `kind:"opencode"` firehose — it
  consumes *only* `desktopNotify`.)

## The presence model (Slack/Discord parity)

Desktop presence comes from `desktopPresence.ts` heartbeats; three states:

| State | Definition | Source |
|---|---|---|
| **active** | a bui window is focused **AND** `getSystemIdleTime() < 30s` | `_desktop.visible === true`, fresh `lastSeen` |
| **idle / away** | app open (heartbeat fresh, `lastSeen` within 60s TTL) but `visible === false` (blurred or idle >30s) | fresh `lastSeen`, `visible:false`, outside grace |
| **gone** | no heartbeat for > 60s TTL (app closed, machine asleep) | `lastSeen` stale |

Mobile presence comes from `/push/focus {sessionId, visible}`:
- **foreground** (`_focus.visible`) / **background**, plus the session it's
  viewing.

This is exactly Slack/Discord "active / away / offline" per device. The
"active = focus **AND** recent input" rule is load-bearing and already
documented in `desktopPresence.ts` — picking up your phone does not blur the Mac
window, so focus alone would mute mobile forever.

## Notification tiers

Two tiers, mirroring how Slack/Discord treat @mentions/DMs vs. channel noise:

- **blocking** — `permission.asked`, `question.asked`, `session.error`, and a
  `notify` call with `urgent:true`. Always reaches **every** device
  immediately; never delayed, never escalation-gated. (This preserves today's
  behavior: blocking events already fan out to all devices.)
- **informational** — `session.idle`→"done" and a normal `notify`. Follows the
  soft **desktop-first → mobile-escalation** ladder below.

## Routing matrix (informational tier)

For a notification about session `S`, given device states:

| Desktop | Mobile | Desktop OS notif | Mobile push |
|---|---|---|---|
| active, viewing `S` | – | – (already on screen) | – |
| active, other session | – | ✅ now | – |
| idle/away (app open) | – | ✅ now | ⏳ after `ESCALATE_MS` if unacked |
| gone | – | – | ✅ now |
| any | foreground viewing `S` | (desktop rules) | – (in-app already shows it) |
| gone | foreground other session | – | ✅ (push; PWA shows in-app) |

**Blocking tier** collapses the matrix: desktop now (unless viewing `S`) **and**
mobile now (unless mobile foreground viewing `S`) — both, immediately.

### The "viewing `S`" refinement is client-side on desktop

The server routes **desktop-vs-mobile**. The final "am I literally staring at
this chat right now?" suppression for the **desktop** leg is done at show-time
by the Electron app (it knows its focused window + active session locally), so
we don't have to plumb the desktop's active session all the way to the server.
Mobile can't do this — a push can't be un-sent — so mobile's "viewing `S`"
suppression stays server-side via the existing `/push/focus`.

## Escalation — desktop-first, then mobile if unhandled

`ESCALATE_MS = 90_000` (locked). When the router decides desktop is **idle/away**
for an informational notification:

1. Emit the desktop directive **now** (the Mac is still open; you may wander
   back).
2. Schedule a mobile push for `now + ESCALATE_MS`, keyed by the notification
   `tag` (per session+kind, so a re-notify replaces rather than stacks a second
   timer).
3. **Cancel** the pending escalation when any of:
   - desktop becomes **active** again (`setDesktopPresence visible:true`) —
     cancels *all* pending escalations (the user is back at the desk; clicking
     the desktop notification focuses the app, which trips this naturally);
   - the session resumes or the ask is answered for `S`
     (`session.status busy`, `question.replied/rejected`,
     `permission.replied/rejected`) — cancels escalations for that session;
   - a newer notification with the same `tag` supersedes it.

If the desktop is **gone** (TTL lapsed) there's no desktop leg and the mobile
push fires immediately — your scenario "AFK too long, I'm probably not at my
desktop at all" (the heartbeat is what proves the Mac is even reachable).

## The four asked scenarios, mapped

1. **Working on desktop, another session has a notif** → desktop **active** →
   desktop OS notification only, mobile suppressed. ✅
2. **Working on mobile, another session has a notif** → desktop not active →
   mobile leg fires (the foregrounded PWA shows it in-app; a background PWA gets
   the push). Desktop silent. ✅
3. **AFK, desktop open** → desktop **idle/away** → desktop notification now,
   mobile push escalates after 90s unless you return / handle it. ✅
4. **AFK too long** → desktop **gone** (no heartbeat) → mobile only, immediately.
   ✅

## Additional scenarios (the "another one?")

- **Active on desktop but on a different chat than the notif** — desktop OS
  notification (you're at the machine but not looking at that chat); the in-app
  sidebar dot alone is too easy to miss.
- **Both desktop active + mobile foreground** — desktop wins, mobile suppressed
  (Discord rule).
- **Re-notify / dedupe** — reuse the existing `tag` (`<kind>-<sessionId>`) so a
  second notification for the same session+kind *replaces* the first
  (`renotify` on the SW; `tag`-collapse on Electron) instead of stacking.
- **Subagent / unresolved session** — a "done" whose sessionID has no tmux
  `@manta-session-id` is a subagent child or orphan; already suppressed by
  `shouldSuppressUnresolvedDone`. The `notify` tool always carries a real
  session, so it's unaffected.
- **Quiet hours / DND** — Slack's signature feature. **Deferred to v2** (locked).
  Sketch: an `AppConfig.quietHours = {start, end}`; during the window force
  informational notifs to silent-mobile-only (or hold), blocking still fires.

## The `notify` tool — behavior

Model calls `notify` when the user says "ping me when X", "notify me when the
build finishes", "let me know when you're done", etc. The model typically pairs
it with the `schedule` tool (schedule a check, and in that scheduled turn call
`notify` once the condition is met).

- **Args**: `message` (string, required — the body), `title` (optional, defaults
  to the session label `workspace / session-name`), `urgent` (optional bool —
  blocking tier: fire on all devices now, no escalation delay).
- **Session-tied (locked)**: the tool reads `context.sessionID`; the
  notification carries it so tapping deep-links to that chat and dedupes by
  session — same as every other push.
- POSTs `{message, title, urgent, sessionID}` to `POST /api/notify`; bui-server
  builds a payload `{kind:"notify", title, body, sessionId, tag:"notify-<sid>"}`
  and runs it through the **same router** as opencode events.

### Install (same pattern as schedule/serve-page/peers)

```bash
cp <repo>/docs/opencode-tools/notify.ts ~/.config/opencode/tools/notify.ts
cat <repo>/docs/opencode-tools/AGENTS.md >> ~/.config/opencode/AGENTS.md   # already includes notify guidance
systemctl --user restart opencode-serve
```

**COPIED, not symlinked** (the `@opencode-ai/plugin` import-resolution gotcha).

## Implementation map (the standard sites)

Server-owned core (testable first, no device wiring):

| Piece | File |
|---|---|
| Pure router `routeNotification(payload, presence, now)` → `{desktop, mobileNow, escalateAfterMs}` | `src/server/push.mjs` |
| Escalation timers (`_escalations` Map keyed by tag) + cancel hooks | `src/server/push.mjs` |
| Desktop sink injection (`setDesktopSink(fn)` → `bus.publish({kind:"desktopNotify"})`) | `src/server/push.mjs` + wired in `src/server/index.mjs` |
| `POST /api/notify` endpoint | `src/server/index.mjs` |
| `notify` opencode tool | `docs/opencode-tools/notify.ts` |
| Tool guidance | `docs/opencode-tools/AGENTS.md` |
| Tests (router matrix + escalation fire/cancel) | `src/server/push.test.mjs` |

Desktop leg:

| Piece | File |
|---|---|
| Subscribe to bui-server `/events` over `-L 18787`, filter `desktopNotify`, `new Notification()` | `src/main/notify.ts` (NEW), started from `src/main/index.ts` |
| Local "viewing `S`" + click→focus/deep-link suppression | `src/main/notify.ts` + renderer active-session signal |

Mobile leg: unchanged transport; the router just gates `sendPush` as today.

## What is NOT in v1 (deliberate cuts)

- **Quiet hours / DND** — deferred (see above).
- **Per-event opt-out / notification preferences UI** — v1 routes everything;
  granular muting is a fast-follow.
- **`/push/ack` explicit acknowledge endpoint** — v1 cancels escalation via the
  organic signals (desktop-active, reply events). An explicit "I saw the desktop
  toast, don't escalate" ack is a future refinement.
- **Desktop notification action buttons** (quick-reply a Question from the Mac
  notification) — mobile has this via SW actions; desktop parity is a follow-up.

## Test coverage (`src/server/push.test.mjs`, node:test)

Pure logic only:
- `routeNotification`: each matrix row (active-viewing/active-other/idle/gone ×
  blocking/informational), TTL-stale → mobile, grace window.
- Escalation: idle informational schedules a timer; desktop-active cancels;
  reply event cancels by session; same-tag supersede replaces.

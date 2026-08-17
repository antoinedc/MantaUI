# manta-native tools — the `notify` tool + cross-device notification routing

This is the fourth **manta-native opencode tool** (after `schedule`, `serve_page`,
`peers`) and the first to add a **desktop OS notification leg** alongside the
existing mobile Web Push. It also introduces the **single notification router**
that decides — for *every* notification, automatic or AI-triggered — whether it
goes to desktop, mobile, both, or escalates from one to the other, with **no
duplicates**.

Read `docs/manta-tools-scheduler.md` first for the reusable "manta tools" pattern
(global opencode tool → thin registrar → manta-server endpoint + durable logic).
This doc only covers what's notify-specific.

## Why a single router

"No duplicates" requires that **one place** knows the state of *all* devices at
decision time. Before this feature, two facts were split:

- manta-server (`src/server/push.mjs`) owned the **mobile** leg (Web Push) and
  already tracked desktop presence (`_desktop`) + mobile focus (`_focus`).
- The desktop Electron app had **no notifications at all**.

So manta-server is the natural sole arbiter: it already sees every opencode event
(the `firePush` call in the opencode pump) and already holds both presence
signals. We extend it to also drive the desktop leg. The desktop app does not
make its own routing decisions — it only *renders* the OS notification the
server tells it to (with one local refinement, below).

```
opencode event ─┐
AI notify tool ──┤→ manta-server router (push.mjs)
                 │      ├─ desktop leg → bus "desktopNotify" → SSH -L 18787
                 │      │                 → Electron app → new Notification()
                 │      └─ mobile leg  → Web Push (VAPID) → PWA service worker
```

- **Mobile leg** = existing Web Push, unchanged transport.
- **Desktop leg** = the Electron main process subscribes to manta-server's
  existing `GET /events` SSE **over the already-open `-L 18787` presence
  forward** and reacts only to a new `kind:"desktopNotify"` envelope by showing
  an Electron `Notification`. (Desktop already gets opencode events from its own
  `:4096` stream, so it must ignore the bus's `kind:"opencode"` firehose — it
  consumes *only* `desktopNotify`.)

## The presence model (Slack/Discord parity)

Desktop presence comes from `desktopPresence.ts` heartbeats. The desktop
reports raw observations every 30s, unconditionally — `{idleSeconds,
lockedSeconds}` — and the SERVER computes the desktop's state. Window focus is
NOT an input: Manta's normal pattern is to start a turn then work in another
app on the same Mac, and a focus-based rule would call that "away". System-wide
input idle measures the machine, not a window (Slack/Teams do the same).

The two away conditions are merged into ONE instant by `computeAwayAt`
(`min()`): idle for 10 min (`IDLE_AWAY_MS`) OR locked for 5 min (`LOCK_AWAY_MS`)
— whichever trips first wins, so they are one state transition, not two timers.
`desktopState` then yields three states:

| State | Definition | Source |
|---|---|---|
| **present** | app running and the user is at the machine | heartbeat fresh (`lastSeen` within `PRESENCE_TTL_MS` 90s) AND now before `awayAt` |
| **away** | app running, but the user has left (locked or idle) | heartbeat fresh AND now past `awayAt` |
| **gone** | no heartbeat for > 90s TTL (app closed, machine asleep) | `lastSeen` stale |

Mobile presence comes from `/push/focus {sessionId, visible}`:
- **foreground** (`_focus.visible`) / **background**, plus the session it's
  viewing.

This is exactly Slack/Discord "active / away / offline" per device.

## Notification tiers

Two tiers, mirroring how Slack/Discord treat @mentions/DMs vs. channel noise:

- **blocking** — `permission.asked`, `question.asked`, `session.error`, and a
  `notify` call with `urgent:true`. Always reaches **every** device
  immediately; never delayed, never escalation-gated. (This preserves today's
  behavior: blocking events already fan out to all devices.)
- **informational** — `session.idle`→"done" and a normal `notify`. Follows the
  **desktop-first → deferred-mobile** ladder below.

## Routing matrix (informational tier, by `desktopState`)

For a notification about session `S`. `deferMobile` = the mobile notification is
parked (delivered later or dropped stale), never added.

| Desktop state | Mobile | Desktop OS notif | Mobile push |
|---|---|---|---|
| present | not viewing `S` | ✅ now | ⏳ deferred until away/gone or 30-min stale |
| present | foreground viewing `S` | – (already on screen) | – |
| away | not viewing `S` | ✅ now | ✅ now |
| away | foreground viewing `S` | ✅ now | – (in-app already shows it) |
| gone | not viewing `S` | – | ✅ now |
| gone | foreground other session | – | ✅ (push) |

**Blocking tier** collapses the matrix: desktop now (unless viewing `S`) **and**
mobile now (unless mobile foreground viewing `S`) — both, immediately.

### The "viewing `S`" refinement is client-side on desktop

The server routes **desktop-vs-mobile**. The final "am I literally staring at
this chat right now?" suppression for the **desktop** leg is done at show-time
by the Electron app (it knows its focused window + active session locally), so
we don't have to plumb the desktop's active session all the way to the server.
Mobile can't do this — a push can't be un-sent — so mobile's "viewing `S`"
suppression stays server-side via the existing `/push/focus`.

## Deferred mobile — desktop-first, then deliver when the user leaves

There is no flat escalation timer any more. When the router decides
`deferMobile` (desktop state `present`), the notification payload is parked in
one `_deferredMobile` list keyed by `tag`. A single 30s poller
(`flushDeferredMobile` / `startDeferredMobilePoller`, started from
`index.mjs` like the other pollers) re-evaluates each parked entry against the
LIVE `awayAt` on every tick:

1. Emit the desktop directive **now** (the Mac is open; you may wander back).
2. Park the mobile push keyed by the notification `tag` (per session+kind, so a
   re-notify replaces rather than stacks).
3. On a later flush: desktop **away** or **gone** → deliver to mobile now; held
   **> 30 min** → drop without delivering (stale); still **present** → leave it.

**Cancel** without delivering when any of:
- a heartbeat reports a LOWER `idleSeconds` than the last one (the user came
  back — `setDesktopPresence` cancels all parked deliveries; they'll see the
  desktop notification);
- the session resumes or the ask is answered for `S` (`cancelDeferredMobileForSession`
  from the busy/reply branches in `firePush`);
- a newer notification with the same `tag` supersedes it.

If the desktop is **gone** (TTL lapsed) the router routes mobile immediately —
your scenario "AFK too long, I'm probably not at my desktop at all".

## The four asked scenarios, mapped

1. **Working on desktop, another session has a notif** → desktop **present** →
   desktop OS notification now, mobile **deferred** until you leave the desk. ✅
2. **Working on mobile, another session has a notif** → desktop not active →
   desktop **gone** (or away) → mobile leg fires (a foregrounded phone shows it
   in-app; a background one gets the push). ✅
3. **AFK, desktop open** → desktop **away** → desktop notification now + mobile
   push now. ✅
4. **AFK too long** → desktop **gone** (no heartbeat) → mobile only, immediately.
   ✅

## Additional scenarios (the "another one?")

- **Active on desktop but on a different chat than the notif** — desktop OS
  notification (you're at the machine but not looking at that chat); the in-app
  sidebar dot alone is too easy to miss.
- **Both desktop present + mobile foreground** — desktop wins, mobile suppressed
  (Discord rule).
- **Re-notify / dedupe** — reuse the existing `tag` (`<kind>-<sessionId>`) so a
  second notification for the same session+kind *replaces* the first
  (a same-tag entry in `_deferredMobile` is overwritten) instead of stacking.
- **Subagent / unresolved session** — a "done" whose sessionID has no tmux
  `@manta-session-id` is a subagent child or orphan; already suppressed.
  The `notify` tool always carries a real session, so it's unaffected.
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
- POSTs `{message, title, urgent, sessionID}` to `POST /api/notify`; manta-server
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
| Pure router `routeNotification(payload, presence, now)` → `{desktop, mobileNow, deferMobile}` | `src/server/push.mjs` |
| Away calculation + state (`computeAwayAt`, `desktopState`) | `src/server/push.mjs` |
| Parked mobile list (`_deferredMobile` Map keyed by tag) + flush poller | `src/server/push.mjs` |
| Desktop sink injection (`setDesktopSink(fn)` → `bus.publish({kind:"desktopNotify"})`) | `src/server/push.mjs` + wired in `src/server/index.mjs` |
| `POST /api/notify` endpoint | `src/server/index.mjs` |
| `notify` opencode tool | `docs/opencode-tools/notify.ts` |
| Tool guidance | `docs/opencode-tools/AGENTS.md` |
| Tests (router matrix + deferred flush/cancel) | `src/server/push.test.mjs` |

Desktop leg:

| Piece | File |
|---|---|
| Subscribe to manta-server `/events` over `-L 18787`, filter `desktopNotify`, `new Notification()` | `src/main/notify.ts` (NEW), started from `src/main/index.ts` |
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
- `routeNotification`: each matrix row (present/away/gone × blocking/informational,
  mobile-viewing suppression).
- `computeAwayAt` / `desktopState`: idle+lock → one instant; fresh/past-awayAt/stale-TTL → present/away/gone.
- Deferred delivery: park while present, deliver on away/gone, drop stale after 30 min,
  cancel on lower-idle heartbeat / by session, same-tag supersede replaces.

# Changelog

User-facing changes per release. Each release names the components it ships:
**Box** (server, `server-v*`), **Desktop** (macOS `mac-v*` + Windows `win-v*`),
**iOS** (`ios-v*`, TestFlight), **Website** (`web-v*`), **Gateway**
(`gateway-v*`). A component not listed in a release did not change.

Desktop and Box share one version number (`package.json`); iOS has its own
(`MARKETING_VERSION` in `mobile/native/project.yml`).

## 1.1.0 — Box + Desktop · iOS 1.2.0 — 2026-10-29

Ships: Box `server-v1.1.0`, Desktop `mac-v1.1.0` / `win-v1.1.0`, iOS
`ios-v1.2.0`, Website `web-v1.1.0` (publishes the box update manifest only).
Gateway unchanged.

### Talking to a running agent
- **Send while the agent works.** A message sent mid-turn now reaches the
  running agent at its next step instead of interrupting it. **⌥Enter** sends
  "after this turn" instead. Desktop and iOS.
- **Pending messages card.** Messages waiting for the agent are listed above the
  composer with **Send now**, **Wait** and **×**; **↑** edits the last one. The
  list lives on the box, so it survives a reload and shows on every device.
- **Background slash commands.** An opencode command or skill can be run in the
  background from the composer; it gets its own card and result in the
  transcript.
- Skills run from the composer as `/<skill>`.

### Long conversations
- **Auto-handoff.** When a conversation grows long, it continues in a fresh
  session with a structured summary (per-session mode: auto / suggest / off).
  The handoff shows as a card in the transcript, an
  unanswered last reply is carried over and asked again first, and previous
  sessions are named.
- Tool-output pruning is on by default (one-time migration), keeping context
  smaller.

### Background jobs
- Jobs run on the OpenCode V2 engine, including the CTO's workers.
- **Another round on a finished job** (`delegate_send`) keeps its context,
  worktree and branch.
- Sessions started outside Manta (scripts, nested subagents) are tracked and
  nested under the session that actually runs them, with a small icon instead
  of a text label.
- Background jobs hand off on their own; Stop and Pause always stop.
- The approval card reports what Start / Not now did, and a pending permission
  prompt can never auto-approve a job.
- A finished job's window closes even when it had no worktree; job cards stay
  where they were added instead of jumping to the tail.

### Desktop
- Every URL in the transcript is clickable, tagged or not; inline code stays
  unstyled.
- Scrolling up while text streams works; auto-follow resumes only at the very
  bottom.
- Secrets card: search next to **+ Add secret**.
- Usage ring: combined seats in automatic mode, and a used-up longer limit makes
  the shorter one count as full.
- **@@** opens agent suggestions; **Reconnect** opens Accounts with a real
  sign-in path.
- Composer hints no longer re-wrap the controls row.

### iOS
- Send while the agent is running, with the pending-messages list.
- Broad parity with desktop (waves A–C): the same session, transcript and
  background-job behaviour, with shared logic moved onto the box.
- Handoff cards.

### Box
- Follows the desktop's timezone.
- Model catalogue is cached, so sessions stop resetting to "Server default"
  (and a catalogue read taken mid-restart is no longer cached as good).
- Updated Manta guidance in `~/.config/opencode/AGENTS.md` is refreshed on
  update while keeping your own edits.
- Stale "usage stopped" entries are cleared.
- Typed OpenCode V2 client throughout; the legacy V1 job path is removed.

## 1.0.0 — 2026-10-23

OpenCode V2 cutover: the box runs a pinned OpenCode V2 and migrates existing
history automatically on update. Earlier releases are recorded only in git tags.

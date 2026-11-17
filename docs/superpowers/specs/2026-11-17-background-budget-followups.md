# Background work budget — follow-ups after first use

Status: rev 3 (2026-11-17) — two review rounds folded in; §5.6 amends §5.1–5.5. Builds on `2026-11-17-background-work-budget.md` (PR #1690, merged 372cfcd5).
Owner: box server (`src/server/`), desktop renderer (`src/renderer/`).

## 1. What happened

The owner updated their box and opened Settings → Knowledge. It said knowledge was paused because of the
budget; "Change" opened the Models tab. Measured on that box (2026-11-17 19:40):

- Claude weekly window: 47 % used, 2.5 days into the week (started Sat 08:00, resets Sat 22 Nov 08:00);
  projected end 132 % → rule `projected-high`, resumes around Thu 10:42 if usage stays flat. Correct
  behaviour, explained badly.
- ChatGPT Pro: its only window is 7 days long but the codex adapter reports it as `kind:"session"`, so the
  budget treated a week as a 5-hour window (wrong rules, wrong copy).

User decisions (2026-11-17): keep the pause rule; fix the copy; give the setting its own Settings section;
add an override; when knowledge resumes after a pause it must catch up on what it missed, condensed so the
catch-up doesn't burn the allowance at once; use Manta handoff summaries (and OpenCode compaction
summaries) instead of raw history where they exist.

## 2. Plain-language pause copy

Every paused line says WHAT is waiting, WHY (protecting the user's quota/money), on WHICH plan, the
figure, and WHEN it resumes. Copy is built in `backgroundWorkFormat.ts` (pure, tested); the subject is
passed by the caller ("Knowledge", "The CTO", or "Background work" on the card).

| Reason | Copy (example) |
|---|---|
| projected-high | "Knowledge is waiting so it doesn't use up your Claude week: you've used 47% in 2½ days, on pace for more than the whole week. It resumes Thu 10:40 if your usage slows, or Sat 08:00 when the week resets." |
| window-busy (short) | "Knowledge is waiting while you're using Claude heavily: your 5-hour window is 74% used. It resumes at 14:00 when that window resets." |
| window-busy (weekly, no projection) | "…your Claude week is 74% used. It resumes Sat 08:00 when the week resets." |
| level-cap | "Knowledge has used its share of your Claude week (5%). It resumes Sat 08:00 when the week resets." |
| exhausted | "Your Claude week is used up. Knowledge resumes Sat 08:00." |
| usd-cap | "Knowledge reached today's $5.00 API-key limit. It resumes at midnight." |
| off | "Background work is off for your plans." |
| unavailable | "Knowledge is waiting: the budget couldn't be read. It will retry." |

- "2½ days" = elapsed time of the window (needs its start: §6), rounded to half days (hours under a day).
- The "Change" link text becomes "Background work settings" (aria label to match). `summaryLine` and the
  status line take a `subject` parameter.
- Elapsed time and the window noun need `windowStart` and `spanMs` on the wire: `BudgetWindow` gains
  `windowStart: number|null` and `spanMs: number|null`; the renderer derives the noun from `spanMs`
  (5-hour window / week / "<label> window"), falling back to `kind`.

## 3. Its own Settings section

New Settings section **Background work** (`sectionId: "background"`, icon from the existing set) holding
the `BackgroundWorkCard`; removed from Models. The Knowledge card's and CTO pane's "Background work
settings" link opens this section and focuses the card heading (existing `manta-open-settings` event with
`section:"background"`). Settings search indexes it ("budget", "background", "quota", "spend", "cap") through a `custom` schema
entry. Touch points: `SettingSectionId` + `SETTING_SECTIONS` (`settingsSchema.ts`; placed directly after
Models in the same nav group), `SECTION_ICONS` (`Settings.tsx`), remove the Models render,
`openBackgroundWorkSettings` targets `background`.

## 4. Override: "Keep running when my plan is busy"

- Config `backgroundWork.runWhenBusy: boolean`, default `false`; validated/merged by
  `validateAndMergeBackgroundWork` like the other fields.
- When `true`, plan rules **window-busy** and **projected-high** (incl. the near-reset variant, §17.10 of
  the base spec) are skipped. Still enforced: `off`, `exhausted`, level caps (incl. batch ceiling), payg cap.
- UI: a checkbox under the level control, label "Keep running when my plan is busy", help "Background work
  still stays within its share (5% of a week on Normal), but no longer waits when your own usage is high."
  Hidden when level is Off. Save behaviour = the other controls (visible success/error).
- Plumbing: `readBackgroundWork` / `validateAndMergeBackgroundWork` / defaults (`DEFAULT_BACKGROUND_WORK`,
  `local.mjs`) / `AppConfig` type carry `runWhenBusy`; `status()` returns it (the card reads its values from
  status). The rule sites skipped are the short-window busy rule, the weekly projection rule, its near-reset
  variant and the weekly no-projection busy fallback.

## 5. Catching up after a pause, condensed

Today a paused capture keeps its bookmark (cursor) per session and catches up on resume, but reads only the
newest 400 messages and fits ~24k characters, so long backlogs lose their early/middle parts.

### 5.1 Reading forward from the bookmark

- New `oc.listMessagesSince(sessionId, {after: {at, id}, max})` (`src/server/opencode.mjs`): pages the
  session newest-first (the existing reader) and stops at the bookmark, returning oldest-first, at most
  `max` (default 2,000) messages; never loads more than the existing 10,000-record ceiling. The capture
  reader (`createCaptureMessageSource`) uses it when a bookmark exists, and keeps the `summary` flag of a
  completed compaction message (`mapTimeline` already sets `info.summary`). A span beyond `max` is reported
  in the input as "[N older messages not read]" and logged.

### 5.2 Condensing raw history (no model)

A pure `condenseForCapture(messages)` (new `knowledge/condense.mjs`), applied to backlog input only:

- Keep whole: user messages; the last assistant text of each turn; failed tool calls (error status /
  non-zero exit) with the first and last lines of their output; edits/writes as "edited <path>".
- Collapse to one-line markers: runs of reads/greps/globs/lists ("read 14 files in src/server"), passing
  test/build commands ("ran npm test: passed"), web fetches ("fetched 3 pages").
- Drop: successful read-only tool outputs, reasoning, synthetic/ignored parts, intermediate assistant text
  superseded later in the same turn.
- Deterministic, idempotent, keeps message ids so citations still resolve.

### 5.3 Summaries for spans too big to read

Only when the raw span from the bookmark, AFTER §5.2, does not fit one capture input (`MAX_INPUT_CHARS`,
24k chars) — otherwise raw wins and summary messages are skipped (they would re-state already-captured
history):

1. **Manta handoff summary.** New sync engine method `handoff.summariesFor(sessionId)` over committed
   records → `{asPredecessor: [{recordId, createdAt, text, successorId, disposition, messageId}],
   asSuccessor: {recordId, fromSessionId, createdAt, text, disposition, messageId} | null}`, `text` being
   the delivered text (`internal.textOverride` when set). If the session handed off after the bookmark, the
   summary replaces the raw span bookmark→`createdAt` (request time — a conservative cutoff). In the
   SUCCESSOR, the delivered preamble is not read twice: disposition `send` → skip the message with
   `messageId`; `armed` → strip the `preamble + "\n\n---\n\n"` prefix from its first user message (keep the
   user's own text); draft → skip only on exact text match. Records pruned (30 days / newest 500) → fall
   through to 2/3.
2. **OpenCode compaction summary** (a `summary:true` message after the bookmark): replaces the raw span
   before it. Summary text is exempt from the 1,200-char assistant clip (cap it at 8k chars).
3. Otherwise: §5.4 windows.

Citations: a handoff summary cites `msg:<successorId>/<messageId>` for `send`, else the predecessor's last
message at or before `createdAt`; a compaction summary cites its own message. Notes whose only evidence is a
summary are marked `derived: true`.

### 5.4 Catch-up in ordinary windows, oldest first

What doesn't fit one input after 5.1–5.3 is captured as successive ordinary captures over ≤ 24k-char
windows, oldest first, each advancing the bookmark to its last message. Resumable: a refusal or failure
mid-way loses nothing already captured. No new task class or model; same redaction, aliases and
validation per window. At most 8 windows per session per day (the rest waits for the next day, logged).

### 5.5 Pacing (no budget change)

- A session is in **backlog** when its bookmark is more than one window behind (persisted per session as
  `backlog_since` in the capture table; schema migration `capture-2`).
- Each capture tick first runs ordinary due captures (unchanged), then at most ONE backlog window, most
  recently active session first.
- A budget refusal of a backlog window returns skip code `budget-backlog`, which does NOT stop ordinary
  captures in later ticks (unlike `budget`, which still breaks the tick).
- Spend stays under the existing level cap / daily cap; no new budget accounting.

### 5.6 Rev 3 amendments (win over 5.1–5.5)

1. **User-message gate.** The "≥ 3 new user messages" gate (`too-few-messages`) is evaluated ONCE on the
   whole span since the bookmark, before summaries and windowing. Once a session is in backlog, every window
   runs regardless of its own user-message count; a window with nothing capturable (after §5.2) advances the
   bookmark with no model call.
2. **Backlog selection.** The backlog step selects from the capture table by `backlog_since IS NOT NULL`,
   independent of `dirty`, ordered by most recent activity; it does not require the 10-minute idle (the
   session was already idle when it became backlog). A compaction-triggered capture on a backlog session also
   runs only one window. `backlog_since` is cleared when the bookmark reaches the end.
3. **`listMessagesSince` keeps the OLDEST.** It pages newest-first down to the bookmark, keeping a rolling
   buffer of the oldest `max` messages after the bookmark; newer ones stay unread for later windows. "[N
   older messages not read]" is reported only when the 10,000-record ceiling is hit before reaching the
   bookmark.
4. **Bookmark after a summary.** A span replaced by a summary advances the bookmark to its last replaced
   message (the last at or before the handoff's `createdAt`, or the compaction message itself).
5. **Daily cap persisted.** `capture-2` adds `backlog_day` and `backlog_windows` (count) next to
   `backlog_since`.
6. **Successor preamble.** The skip/strip of the delivered handoff preamble in a successor applies ALWAYS
   (the preamble is never user-authored evidence), not only when the predecessor used the summary.
7. **Summary role.** Summary aliases carry role `summary` (non-user), so the existing rule makes any note
   citing them `derived`.
8. **Settings search label** for the `custom` entry: "Background work — plans and API-key limit". If the
   visual gate enumerates Settings sections, add the new section's row.

## 6. Window length and the ChatGPT fix

- `UsageWindow` gains optional `spanMs` (window length). Codex sets it from `limit_window_seconds`;
  Claude sets 5 h for `session`, 7 d for `weekly` kinds; descriptor readers when known.
- The budget treats a window as weekly-kind when `isWeeklyKind(kind)` OR `spanMs ≥ 2 days`, and as short
  otherwise; `windowStart` default = `resetsAt − spanMs` when `spanMs` is known (replaces the
  weekly-only 7-day default).
- `normalizeWindow` passes `spanMs` through. The codex adapter keeps `kind` names (other consumers key
  history on them); only the budget and the copy read `spanMs`. Every `isWeeklyKind(...)` use in
  `backgroundBudget.mjs` becomes a window-based `isWeeklyWindow(w)`. Note: the ChatGPT 7-day window's
  cap drops from 10 % to 5 % (Normal) once reclassified — expected. Window noun in copy: "5-hour window" / "week" / "<label> window" from `spanMs`.

## 7. Libraries considered

| Need | Chosen | Considered, and why not |
|---|---|---|
| Transcript condensing | own pure function | LLM summarizers cost the allowance this feature exists to save; no maintained library understands OpenCode tool parts. |
| Summaries | existing handoff store + OpenCode compaction messages | — |
| Paging transcripts | new `listMessagesSince` over the existing reader | — (no paging exists today) |
| Settings section | existing Settings section framework | — |

## 8. Tests

- Copy: every reason × subject; elapsed formatting.
- Settings: section exists, link opens it and focuses the card, search finds it; override toggle saves
  and reports errors.
- Budget: `runWhenBusy` skips exactly the two rules; `spanMs` weekly classification and windowStart;
  
- Codex adapter: `spanMs` from `limit_window_seconds`; a 7-day primary window is weekly for the budget.
- Capture: `listMessagesSince` stops at the bookmark; `condenseForCapture` fixtures; summaries used only
  when the span doesn't fit (handoff for send/armed/draft successors, compaction), citations and
  `derived`; window-by-window catch-up advances the bookmark per window and resumes after a refusal; 8
  windows/day cap; one backlog window per tick after ordinary captures; `budget-backlog` doesn't stop
  ordinary captures; `capture-2` migration.

Verification on Freestyle VMs only.

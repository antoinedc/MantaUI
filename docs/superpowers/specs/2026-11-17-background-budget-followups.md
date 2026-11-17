# Background work budget — follow-ups after first use

Status: draft rev 1 (2026-11-17). Builds on `2026-11-17-background-work-budget.md` (PR #1690, merged 372cfcd5).
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
- When the override (§4) is on and the only refusals are `projected-high`/`window-busy`, those lines are
  not shown (the work runs).
- The "Change" link text becomes "Background work settings".

## 3. Its own Settings section

New Settings section **Background work** (`sectionId: "background"`, icon from the existing set) holding
the `BackgroundWorkCard`; removed from Models. The Knowledge card's and CTO pane's "Background work
settings" link opens this section and focuses the card heading (existing `manta-open-settings` event with
`section:"background"`). Settings search indexes it ("budget", "background", "quota", "spend", "cap").

## 4. Override: "Keep running when my plan is busy"

- Config `backgroundWork.runWhenBusy: boolean`, default `false`; validated/merged by
  `validateAndMergeBackgroundWork` like the other fields.
- When `true`, plan rules **window-busy** and **projected-high** (incl. the near-reset variant, §17.10 of
  the base spec) are skipped. Still enforced: `off`, `exhausted`, level caps (incl. batch ceiling), payg cap.
- UI: a checkbox under the level control, label "Keep running when my plan is busy", help "Background work
  still stays within its share (5% of a week on Normal), but no longer waits when your own usage is high."
  Hidden when level is Off. Save behaviour = the other controls (visible success/error).
- Status/`check` unchanged otherwise; evidence `refused` rows simply stop for those reasons.

## 5. Catching up after a pause, condensed

Today a paused capture keeps its bookmark (cursor) per session and catches up on resume, but reads only the
newest 400 messages and fits ~24k characters, so long backlogs lose their early/middle parts.

### 5.1 Reading the backlog: summaries first

For a session being captured, build its input from the bookmark forward, in this order of preference:

1. **Manta handoff summary.** If the session (or a predecessor whose capture bookmark is behind its
   handoff) has a committed handoff record in `~/.manta/handoffs.json` (`records[*]` with
   `fromSessionId`, `state:"committed"`, `text`, `createdAt`), the handoff `text` replaces that session's
   history up to the handoff's `createdAt`. A successor session's first user message that IS the handoff
   preamble is skipped (it would be read twice). Read through an injected `handoffSummaries(sessionID) →
   [{createdAt, text, successorId}]` from the handoff engine (never parse the file in knowledge).
2. **OpenCode compaction summary.** A completed compaction appears in the transcript as a `summary:true`
   message; history before the newest compaction after the bookmark is replaced by its summary text.
3. **Condensed raw history** for whatever remains (§5.2).

Summary text is marked in the capture input (`[handoff summary]`, `[compaction summary]`) and cites the
session (`msg:` ref of the summary message, or the handoff record's message id when available) so notes
stay evidence-backed.

### 5.2 Condensing raw history (no model)

A pure `condenseForCapture(messages)` in `knowledge/capture.mjs` (or a sibling module):

- Keep whole: user messages; the last assistant text of each turn; tool calls that failed (status error /
  non-zero exit) with the first and last lines of their output; edits/writes as "edited <path>".
- Collapse to one-line markers: runs of reads/greps/globs/lists ("read 14 files in src/server"), passing
  test/build commands ("ran npm test: passed"), web fetches ("fetched 3 pages").
- Drop: tool outputs of successful read-only tools, reasoning, synthetic/ignored parts, intermediate
  assistant text superseded in the same turn.
- Deterministic; tested on fixtures; idempotent on already-condensed input.

### 5.3 Chunking and the cheap pre-pass

- After 5.1–5.2, if the backlog still exceeds `MAX_INPUT_CHARS` (24k), split it into chunks of ≤ 24k
  oldest-first, and for each chunk except the last run one **condense** call on the cheapest band
  (new task class `knowledge-condense`, band `fast`, work type `knowledge-capture` so it shares the
  capture budget), producing ≤ 2k chars of "what happened, what was decided, what failed, what the user
  corrected", with the cited message ids kept. The final capture call reads the condensed chunks + the
  last raw chunk.
- Hard cap per catch-up: at most 6 condense calls per session per catch-up; beyond that the oldest
  chunks are summarised by §5.2 only (logged, never silently dropped: the capture input says "[earlier:
  N messages condensed without a model]").
- The 400-message read limit is lifted for catch-up: read pages from the bookmark forward (paged
  `listMessages`) up to 5,000 messages; the rest is reported in the input the same way.

### 5.4 Pacing

- Backlog = sessions whose bookmark is behind and that became due while capture was refused.
- Capture processes the most recently active backlog sessions first.
- A catch-up session may start only when the budget allows AND the catch-up spend in the current window
  (plan: share of the governing window; payg: today's $) stays under **half of what remains** of the
  level cap / daily cap. Ordinary (non-backlog) captures are never held back by this rule.
- Implemented as an optional `headroom` argument on `backgroundBudget.check` for this work only
  (`check({workType, model, maxShareOfRemaining: 0.5, tag: "catch-up"})`), with the budget tracking
  catch-up spend per window/day separately (same accounting style as `batch`).

## 6. Window length and the ChatGPT fix

- `UsageWindow` gains optional `spanMs` (window length). Codex sets it from `limit_window_seconds`;
  Claude sets 5 h for `session`, 7 d for `weekly` kinds; descriptor readers when known.
- The budget treats a window as weekly-kind when `isWeeklyKind(kind)` OR `spanMs ≥ 2 days`, and as short
  otherwise; `windowStart` default = `resetsAt − spanMs` when `spanMs` is known (replaces the
  weekly-only 7-day default).
- The codex adapter keeps `kind` names (other consumers key history on them); only the budget and the
  copy read `spanMs`. Window noun in copy: "5-hour window" / "week" / "<label> window" from `spanMs`.

## 7. Libraries considered

| Need | Chosen | Considered, and why not |
|---|---|---|
| Transcript condensing | own pure function | Generic summarizers (LLM-based) are what §5.3 already uses only as a fallback; there is no maintained library that understands OpenCode tool parts. |
| Summaries | existing handoff store + OpenCode compaction messages | — |
| Paging transcripts | existing `listMessages` paging | — |
| Settings section | existing Settings section framework | — |

## 8. Tests

- Copy: every reason × subject; elapsed formatting; override hides busy/projected lines.
- Settings: section exists, link opens it and focuses the card, search finds it; override toggle saves
  and reports errors.
- Budget: `runWhenBusy` skips exactly the two rules; `spanMs` weekly classification and windowStart;
  catch-up headroom accounting.
- Codex adapter: `spanMs` from `limit_window_seconds`; a 7-day primary window is weekly for the budget.
- Capture: handoff summary replaces pre-handoff history (and the successor's preamble message is skipped);
  compaction summary replaces earlier history; `condenseForCapture` fixtures; chunking with the
  condense call (fake runner) and the 6-call cap; 5,000-message paging; backlog ordering and pacing.

Verification on Freestyle VMs only.

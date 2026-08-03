# Native chat screen — consolidated design record

One place for every decision that governs the native iOS chat + session screens,
with its source, whether it is built, and where the design is genuinely silent.
Written after a round of "this was decided, nothing is implemented" — for three
of the six items that is true, for two it is not, and for one no decision was
ever recorded.

Authority order: `docs/mobile-redesign/DECISIONS.md` (settled design record,
§7 list / §8 chat) → `transcript-mockup.html` + `mockup.html` (pixel spec) →
`mobile/native/FINDINGS.md` (as-built record). Desktop specs
(`docs/screens/redesign-spec.html`, `src/renderer/**`) are reference, NOT
authority — several items below were remembered from desktop and never written
down for mobile.

---

## Status at a glance

| # | Topic | Decided? | Built? |
|---|---|---|---|
| 1 | Turn-in-flight (running) treatment | Header subtitle only | Subtitle yes; the visible row is unspec'd |
| 2 | Session loading (opening a chat) | **No decision on record** | No |
| 3 | Tool-row rhythm / spacing | Fully specified, to the pixel | Yes — so a visible gap is a defect, not a missing feature |
| 4 | Context usage % | Subtitle field | Yes, running-only |
| 5 | Git branch | Deliberately absent | Not on chat (correct) |
| 6 | Overflow sheet (schedules/secrets/fork/clear/compact/…) | Fully specified | **No — the button is a transparent placeholder** |

---

## 1. Running / in-flight state

**Decided.** `DECISIONS.md:615-621`:

> Native header, transparent, no large title. Custom two-line centred title:
> session name 14.5px/600 tracking −0.01em `tx1` with ellipsis; below it
> 11px/500 `tx4` of the form "running · 2m · 8%", with the word "running" in
> `accentTx` when busy, falling back to "idle".
> …
> **Session status lives in the header subtitle** — which is exactly where
> BET-406 phase 7 is moving it on desktop. The two clients converge.

Sub-agent rows carry their own live duration (`DECISIONS.md:684-687`).

**What is NOT decided for mobile:** any in-transcript running row, shimmer,
skeleton or animated divider. Those exist only on desktop and are two different
things there:

- the "working…" row with elapsed time between transcript and composer
  (`docs/screens/redesign-spec.html:2545`), and
- the ambient orange sweep on the composer's top hairline, which is the
  **refetch** indicator and explicitly *replaced* a full-row loading card
  (`src/renderer/index.css:83-87`).

**Built:** the subtitle (`ChatModels.swift:318-331`, `ChatScreen.swift:118-122`)
plus a spinner row above the composer that no mobile spec describes
(`ChatScreen.swift:179-194`).

**Open decision — needs a call.** Either (a) subtitle only, and delete the ad-hoc
row, or (b) port the desktop pair: a working row with elapsed time above the
composer *and* the ambient hairline sweep for background refetches. Recommend
(b) with the desktop's own split, because the subtitle is 11pt at the top of a
screen nobody is looking at while they wait, and because the two states mean
different things (turn running vs transcript syncing).

## 2. Session loading

**No decision exists** — DECISIONS.md never covers opening a chat. Desktop
covers both halves: cold load is a full-screen "Connecting to session…" spinner
(`ChatPanel.tsx:2010-2016`), and the ambient bar is deliberately armed on first
open too (`useSseBus.ts:629-633`).

**Built:** nothing. `ChatSessionStore.loading` is published
(`ChatSessionStore.swift:46,102-107`) and **no view reads it**;
`ChatScreen.swift:50-54` branches only on `loadFailed`. Opening a session shows a
blank canvas until blocks arrive.

**Proposed decision:** transcript-shaped skeleton (three greyed blocks at the
user-band / prose / step-group rhythm), replaced in place when the first blocks
land; no full-screen spinner, no layout shift.

## 3. Tool-row ("Ran …") rhythm

**Decided, exhaustively.** `DECISIONS.md:644-660`:

> **Machinery collapses; prose does not.** … A coding session is mostly
> machinery — tool calls, output, diffs — so cramping the text is the wrong
> lever. Prose gets full readability and the machinery compresses instead.
> **Step row** … one line per tool call inside a grouped container —
> `[status dot] [verb] [target, mono, ellipsised] [duration]`, 13px, background
> `panel`, hairline `border-subtle` between rows, radius `--r-md`.
> **Output is collapsed by default.**
> **Consecutive steps roll up.** Three or more in a row collapse to a single
> summary line — `▸ 4 steps · read 3 files, 1 search`.

Geometry, `transcript-mockup.html:75-88` and `:65-69`:

- zero gap between rows inside a group — hairline only;
- `--sp-3` below a step group; `--sp-3` below prose; `--sp-4` below a user band;
- row padding `7px --sp-3` (off-grid, tokenised `--step-row-y`).

**Built and measured** — `FINDINGS.md:144,203-209`, `TranscriptComponents.swift:140-141,210-211,236,344-350`.

**Therefore the wide gap above a "Ran …" row is a DEFECT against a spec that is
already implemented**, not a missing decision. Prime suspects: prose block
emitting a trailing empty paragraph, or `--sp-3` applied on both the prose
bottom and the group top. Fix to the numbers above; no redesign.

## 4. Context usage %

**Decided:** the third field of the header subtitle — a bare integer percent.
No bar, no pill, no popover on mobile (`DECISIONS.md:615-618`). Desktop's
segmented `ContextBar` / ctx-pill / stale-cache pill are desktop-only.

**Built:** `ChatModels.swift:322-329`, fed by the box's interpreted stream.
Shown **only while running** — an implementation choice, not a spec statement.

**Proposed decision:** show it at idle too (`idle · 8%`); the number is most
useful when deciding whether to compact *before* sending.

## 5. Git branch

**Decided by omission, and consistently:** the §8 subtitle has exactly three
fields, the §7.1 list row exactly three slots, and §7.1a enumerates every
subtitle string. Branch appears nowhere. Desktop's `⎇ <branch>` footer was never
carried over.

**Built:** correctly absent from chat. Branch labels exist only in the
folder-picker (`SessionModels.swift:274-292`), one of which is test-only.

**Open decision:** if a branch is wanted on mobile, it needs a home — a fourth
subtitle field is the cheapest, the overflow sheet header is the roomiest.
Recommend the overflow sheet, so the two-line header stays a status line.

## 6. Overflow sheet — the real gap

**Decided.** `DECISIONS.md:619` gives the header exactly two controls:

> Leading and trailing 38×38 circular glass buttons: ChevronLeft, MoreHorizontal.

`DECISIONS.md:667-670` gives the sheet its contents:

> The overflow sheet is a real sheet: rests at half height, drags to full,
> flicks away, dims the screen behind proportionally, grabber functional.
> Contents: Attach photo or file · Scheduled tasks (with live count) · Secrets ·
> Fork session · Open terminal · Delete session (destructive).

Supporting rules:

- Schedules and secrets are in the sheet *because* they were forced out of the
  header — `DECISIONS.md:770-775`: "**The fix is fewer controls, not bigger
  ones.** … schedules and secrets move into the overflow sheet where they
  already live, leaving two targets with room around them."
- Compact and Clear live in the chat screen's overflow — `DECISIONS.md:602-604`:
  "**Compact and Clear** stay in the chat screen's overflow menu, where you can
  see what you are compacting." (They are named there but omitted from the §8
  enumeration — an inconsistency this doc resolves by including them.)
- Clear is an **action sheet**, not an alert, destructive item at the top,
  Cancel detached — `DECISIONS.md:709-715`. Native alerts only; never a web
  dialog.
- **Webhooks, model picker and trust toggle were never specified for mobile.**
  The model picker was built anyway (`ComposerView.swift:90-91`,
  `ModelPickerSheet.swift`).

**Built: none of it.** `ChatScreen.swift:127-130` — the trailing button is a
`Color.clear` spacer with the comment "a placeholder in S4 (the overflow sheet
with fork/settings is a later stage)". Only voice-triggered `compact` works;
clear/fork/trust return "isn't available in this chat" (`ChatVoice.swift:53-56`).

**Resolved contents for the sheet** (spec list + the compact/clear ruling +
the two unspecified items given a home):

1. Attach photo or file
2. Scheduled tasks (live count)
3. Secrets
4. Webhooks — *new, by analogy with schedules/secrets; same session-scoped card*
5. Compact
6. Clear session (action sheet, destructive)
7. Fork session
8. Open terminal
9. Delete session (destructive)

Model picker stays in the composer where it is already built and used; trust
mode stays a Settings toggle (`FINDINGS.md:631`) — per-session trust was never
designed and should not be invented here.

---

## Work implied (not scheduled here)

1. Overflow sheet + its nine items — the bulk of it.
2. Session-loading skeleton.
3. Running-state call (subtitle-only vs desktop's row + ambient sweep), then
   delete or formalise the ad-hoc spinner row.
4. Fix the prose→step-group gap against §3's numbers.
5. Context % at idle.
6. Branch: decide in/out; if in, the sheet header.

Items 1-3 and 6 need a decision from the design record's owner; 4 and 5 are
straight defects against text already written.

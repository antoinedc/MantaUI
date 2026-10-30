# Routines — design contract

Companion to `docs/screens/routines/mockup.html` (the design) and
`docs/superpowers/specs/2026-10-30-routines-design.md` (the behaviour). This file
translates every region of the mockup into **existing primitives + exact Tailwind
classes**, so the implementation is a transcription, not an interpretation.

Rules (from `docs/components.md` and `docs/visual-verification.md`, restated because
they decide review outcomes):

1. **Use the existing primitive** wherever one exists (Button, IconButton, Pill, Tag,
   Chip, SplitChip, Card, Modal, Field, Toggle, Callout, Eyebrow, StatusDot,
   OutputWell, MessageBubble, MenuItem/Dropdown, MenuOption, MeasureColumn). No
   inline re-implementation of their chrome. No `className` escape hatch.
2. **No raw hex, no off-grid spacing.** Spacing comes from the Tailwind steps
   (`1`=4 `2`=8 `3`=12 `4`=16 `5`=20 `6`=24 `8`=32 `10`=40 `12`=48). Type comes from the
   roles `text-display`(24) `text-title`(17) `text-prose`(15) `text-body`(14)
   `text-label`(13) `text-meta`(12) `text-micro`(11) `text-code`(13).
3. **No new tokens.** Primitive changes in this feature (each a variant/prop on an existing primitive, recorded in `docs/components.md` + `src/renderer/primitives.test.ts` in the same PR): `Pill` tone `danger`; `StatusDot` tone `accent` (static); `Field` prop `multiline` (+`rows`).
    Every value used here resolves to an existing token. The ONLY
   primitive changes are the three listed above: `Pill` tone `danger` →
   `"bg-danger-bg text-danger"`; `StatusDot` static tone `accent` (`bg-accent`, no pulse);
   `Field` `multiline` + `rows`. Each is added to the primitive's comment block and to
   `docs/components.md` (also record the existing, undocumented `Callout size: md|note`).
4. Every new region carries a `manta-routines-*` hook class (listed below) so the
   visual registry can crop it. Hooks carry no styles.
5. Colour mapping used below: `text-text`=--tx1, `text-text-muted`=--tx2,
   `text-text-faint`=--tx3, `text-text-quiet`=--tx4, `bg-bg`=--canvas,
   `bg-bg-elev`=--panel, `bg-bg-soft`=--card, `bg-raised`=--raised,
   `bg-inset`=--inset, `bg-fill`/`bg-fill-hover`/`bg-fill-active`, `border-border-subtle`,
   `border-border`, `border-border-strong`, `text-accent-tx`, `bg-accent-bg`,
   `bg-accent-solid`, `text-on-accent`, `bg-danger-bg`, `text-danger`, `bg-warn-bg`,
   `text-warn`, `bg-ok-bg`, `text-ok`, `bg-[var(--diff-add)]`, `bg-[var(--diff-del)]`. If a utility
   above does not exist in `tailwind.config.js` yet, add the colour key mapping to the
   existing CSS variable there (config wiring, not a new token).

Icons are lucide-react (already a dependency). Mockup symbol → lucide name:
`i-routine`→`CalendarClock`, `i-chart`→`ChartLine`, `i-bug`→`Bug`, `i-crash`→`TriangleAlert`,
`i-package`→`Package`, `i-book`→`BookOpen`, `i-tag`→`Tag`, `i-shield`→`Shield`,
`i-memory`→`NotebookText`, `i-msg`→`MessageCircle`, `i-help`→`CircleHelp`,
`i-clock`→`Clock`, `i-folder`→`Folder`, `i-eye`→`Eye`, `i-spark`→`Sparkles`,
`i-bell`→`Bell`, `i-play`→`Play`, `i-pause`→`Pause`, `i-pencil`→`Pencil`,
`i-plus`→`Plus`, `i-check`→`Check`, `i-x`→`X`, `i-chev-d`→`ChevronDown`,
`i-chev-r`→`ChevronRight`, `i-more`→`Ellipsis`, `i-sidebar-add`→`PanelLeftOpen`.
The routine glyph (per routine) is a free choice from a fixed set of 8 icons
(`ChartLine, Bug, TriangleAlert, Package, BookOpen, Tag, Shield, CalendarClock`)
stored as `icon` on the routine; default `CalendarClock`.

---

## R0 — Sidebar row (`Sidebar.tsx`)

Directly below the existing CTO row, inside the same `px-1 pb-1` wrapper, a second
button with **byte-identical chrome to the CTO row**:

```
<button class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-text hover:bg-fill-hover manta-routines-nav"
        aria-label="Open Routines" title="Routines — scheduled work">
  <CalendarClock size={14} class="text-text-faint" />      ← text-accent-tx when selected
  <span class="flex-1 text-left">Routines</span>
  [needsYou>0]  <span class="rounded-full bg-danger px-1 text-[11px] font-semibold leading-5 text-white" aria-label="N need you">N</span>
  [unread>0]    <span class="rounded-full bg-accent-solid px-1 text-[11px] font-semibold leading-5 text-on-accent" aria-label="N new findings">N</span>
</button>
```
(`text-[11px]`/`leading-5` are copied from the CTO badge so the two rows match; do
not "fix" them in this feature.) Selected state (Routines pane open) = `bg-raised` +
the SessionRow selection marker (`ROW_SELECTED` from `SessionRow.tsx` — import the
constant, do not retype it). The row is NOT a `SessionRow` (it is a nav row like CTO).
Badge counts come from the routines summary (`needsYou`, `unread`); both hidden at 0.

## R1 — Routines page (`RoutinesPane.tsx`, hook `manta-routines-pane`, `data-screen="routines"`)

Header bar: the same 46px bar the CTO pane uses — crumb text `Routines` in
`text-label font-medium text-text`. No right-side controls.

Column: `<div class="mx-auto px-6 py-8" style={{maxWidth:"var(--cto-col-max-w)"}}>`
(identical to `CtoPanel.tsx`).

**Page head** `flex items-end gap-4`:
- `h1` `text-display font-semibold text-text` → "Routines"
- `p` `mt-1 text-body text-text-faint` → "Recurring work that starts a fresh session each time it runs. Results land here and stay out of the sidebar."
- right: `<Button tone="primary">` with `<Plus size={14}/>` "New routine".

**Section** wrapper `mt-8`; section head `flex items-center gap-2 mb-3`:
`<Eyebrow>` title + count `text-micro font-mono tabular-nums text-text-quiet` + optional
right slot (`ml-auto`). Optional hint text `text-meta text-text-quiet`.
Text-link buttons ("Mark all read", "Findings only", "Show all", "Show older"):
`rounded-sm px-2 py-1 text-meta font-medium text-accent-tx hover:bg-accent-bg`.
List container ("box"): `rounded-lg border border-border-subtle bg-bg-soft overflow-hidden`.

Sections render in this order and are **omitted entirely when empty** (except "Your
routines", which shows the empty state E1):

### R1.1 Needs you (`manta-routines-needs`)
One card per run in `needs_input`, then one per orphaned routine (spec §8.2: CircleHelp badge; line 1 "<name> · <project>"; line 2 "<name> lost its chat. Move it back to Routines?"; `<Button tone="primary">Move back</Button>`). Run card:
`flex items-start gap-3 rounded-lg border border-border bg-bg-soft px-4 py-3 shadow-sm`
with `style={{borderLeftWidth:"var(--need-edge-w)", borderLeftColor:"var(--danger)"}}`
(the CTO needs-you edge). Contents: 32px badge `grid place-items-center w-8 h-8 rounded-md bg-danger-bg text-danger` (CircleHelp 16; Shield for a permission ask);
text column `flex-1 min-w-0`: line 1 `text-meta text-text-faint` "<routine> · <project> · asked <age> ago · paused until you answer";
line 2 `mt-1 text-body font-semibold text-text` = the question text in curly quotes (permission: "Allow <tool>: <command>?").
Right: `<Button tone="primary">Answer</Button>` (self-center) → opens the run (R3) scrolled to the ask card.

### R1.2 New findings (`manta-routines-findings`)
Unread runs with outcome `findings`, newest first, max 20 (then "Show all" link). Row:
`relative grid grid-cols-[8px_1fr_auto] items-start gap-3 px-4 py-3 border-t border-border-subtle first:border-t-0 cursor-pointer hover:bg-fill`.
- unread dot `mt-2 w-2 h-2 rounded-full bg-accent` (invisible, not removed, when read)
- line 1 `flex items-center gap-1 text-meta text-text-faint`: routine glyph (12) + routine name + `·`(text-text-quiet) + project
- line 2 `mt-1 text-body font-semibold text-text` report title
- line 3 `mt-1 truncate text-label text-text-faint` report summary
- right `mt-1 text-right text-micro font-mono tabular-nums text-text-quiet` time (`9:04` today, `Fri` this week, `24 Oct` older)
- hover reveals (absolute, `right-3 top-1/2 -translate-y-1/2 flex gap-1`, time hidden): `<Button tone="ghost">`(Check) "Mark read" + `<Button tone="default">` "Open".
Click row → R3 for that run (marks it read).

### R1.3 Running now (`manta-routines-queue`)
Hint: "N at a time; the rest wait their turn" (N = configured concurrency, default 2).
Box with `grid grid-cols-[320px_1fr]`:
- left `px-4 py-3 border-r border-border-subtle flex flex-col gap-2`: `<Eyebrow>`"Running"; one slot per running run:
  `flex items-center gap-2 rounded-md bg-accent-bg px-3 py-2 text-label font-medium text-text` + `<StatusDot tone="running"/>` + name + `ml-auto text-micro font-mono tabular-nums text-accent-tx` elapsed (live, 1s tick). Free slot: `rounded-md border border-dashed border-border px-3 py-2 text-label text-text-quiet` "Free".
- right `px-4 py-3`: `<Eyebrow>`"Waiting"; rows `flex items-center gap-2 py-1 text-label font-medium text-text-muted`: position badge `grid place-items-center w-5 h-5 rounded-full bg-fill-active text-micro font-mono font-semibold text-text-muted`, name, optional `<Pill tone="neutral" border>` "you pressed Run now" (manual trigger) / "caught up" (catch-up), right `ml-auto text-micro font-mono text-text-quiet` "queued 10:00 · starts in ~1m". Empty: `text-meta text-text-quiet` "Nothing waiting".
- footnote `mt-2 text-meta text-text-quiet`: "A run is never skipped because the box is busy; it waits here. A routine that's already waiting isn't queued twice. A run waiting on your answer gives up its slot."
The whole section is omitted when nothing is running AND nothing is waiting.

### R1.4 Your routines (`manta-routines-table`)
Header row + rows share `grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1.2fr)_96px_40px] items-center gap-3 px-4`.
- header `py-2 border-b border-border-subtle` cells in `<Eyebrow>` style (text-micro semibold uppercase tracking text-text-quiet): Routine · When · Last run · Next · (empty)
- row `py-3 border-t border-border-subtle first-of-type:border-t-0 cursor-pointer hover:bg-fill` (click → R2):
  - Routine: glyph tile `grid place-items-center w-8 h-8 rounded-md bg-fill text-text-faint` (icon 14) + name `truncate text-body font-semibold text-text` / project `text-meta font-mono text-text-quiet` (= `projectName ?? basename(directory)`)
  - When: `text-label font-medium text-text-muted` cadence (`describeCron`) / `text-meta text-text-quiet` access ("Read-only" | "Can make changes · own branch") + ", tells you only on failure" when notify≠findings
  - Last run: `flex flex-col items-start gap-1`: outcome `<Pill>` (see Outcome map) / `truncate text-meta text-text-quiet` detail
  - Next: `text-meta font-mono text-text-faint` ("Fri 9:00", "Tomorrow 7:00", "11:00", "Thu 6 Nov", "—" when paused/needs-input)
  - `<Toggle checked={enabled} ariaLabel={"Enable "+name}/>` — click does NOT open the row (stopPropagation).
  - paused row: name + cadence in `text-text-quiet`; cadence shows "Paused" / "was <cadence>".

**Outcome map** (Pill `size="meta"`, leading `<StatusDot>` inside the pill):
| state | Pill tone | dot | label |
|---|---|---|---|
| findings | accent | `accent` (NEW static tone on StatusDot: `bg-accent`, no pulse — a variant on the existing primitive) | Findings |
| nothing | neutral + `border` | none | Nothing new |
| running | accent | `running` | Running |
| queued | warn | `warn` | Queued · #N |
| needs_input | danger (new tone) | `error` | Needs you |
| failed | danger | `error` | Failed |
| cancelled / timed_out | neutral + border | none | Stopped / Timed out |
| skipped (missed while the box was off) | neutral + border | none | Skipped |
| moved into a chat (routine row only) | neutral + border | none | In a chat |

### R1.5 Follow-ups in a chat (`manta-routines-followups`)
Head: `<Eyebrow>`"Follow-ups in a chat" + count + hint " · these run inside an existing chat instead of starting a new one".
Row `flex items-center gap-3 px-4 py-3 border-t border-border-subtle first:border-t-0 text-label font-medium text-text-muted`:
`<MessageCircle size={14} class="text-text-faint"/>` · text column (prompt first line, then `text-meta text-text-quiet` "<cadence> · in <a class=text-accent-tx>Session name</a>" — link opens that sidebar session) ·
`ml-auto text-meta font-mono text-text-faint` next-fire · recurring → `<Button tone="ghost">`(CalendarClock) "Make it a routine" (opens R6); one-time → `w-40 text-right text-meta text-text-quiet` "one-time".

### E1 — Empty state (no routines at all)
In place of all sections: `<Card>` with header glyph tile (CalendarClock, accent tile `bg-accent-bg text-accent-tx`), `text-body font-semibold` "No routines yet", `text-label text-text-faint` "Ask in any chat — “every weekday at 9, summarize yesterday's analytics” — or create one here.", actions `<Button tone="primary">New routine</Button>`.

## R2 — One routine (`RoutineDetail.tsx`, hook `manta-routines-detail`)

Header crumb: `Routines` (`text-text-faint hover:text-text`, button → R1) `/` routine name.
Column as R1.

**Hero** `flex items-start gap-4`:
- glyph tile `w-10 h-10 rounded-lg bg-accent-bg text-accent-tx` (icon 20)
- `h1 text-display font-semibold`; facts row `mt-2 flex flex-wrap gap-2` of `<Chip>`s: Clock cadence · Folder path (mono: wrap content in `font-mono`) · Eye "Read-only" | Pencil "Can make changes" · Sparkles model+effort · Bell notify policy · and the destination chip `<Chip on>` (CalendarClock) "New session each run" + ChevronDown → `Dropdown` with two `MenuOption`s: "New session each run" (selected) / "Inside a chat…" (opens R7).
- `mt-3 text-label text-text-faint` "Next run **<b class='font-semibold text-text'>tomorrow at 9:00</b>** · 23 runs since 1 Oct · about 41k tokens a run"
- right `ml-auto flex gap-2`: `<Button tone="default">`(Pencil) Edit (opens R4 prefilled) · `<Button tone="default">`(Pause/Play) Pause|Resume · `<Button tone="primary">`(Play) Run now. "Run now" when a run is already waiting shows the inline `text-meta text-text-faint` note "Already waiting in line" next to the buttons for 4 s.
A routine moved into a chat replaces Pause/Run now with `<Button tone="default">Move back to Routines</Button>`, shows `<Callout tone="info" size="note">` "Runs inside <chat> every <cadence>." under the hero, and the destination chip reads "Inside <chat>".

**Two columns** `mt-8 grid grid-cols-[minmax(0,1fr)_320px] gap-6 items-start`:

Left — Runs: section head (`<Eyebrow>`Runs + count + "Findings only" link toggling a filter) and a box of run rows:
`grid grid-cols-[80px_112px_minmax(0,1fr)_64px] items-center gap-3 px-4 py-3 border-t border-border-subtle first:border-t-0 cursor-pointer hover:bg-fill`
- date `text-meta font-mono text-text-faint` "Thu 30" / `block text-micro text-text-quiet` "9:02"
- outcome Pill
- title `truncate text-label font-medium text-text` (unread → `font-semibold`; nothing-new → `font-normal text-text-faint`) + `block truncate text-meta text-text-quiet` note (see "Run notes" in the spec: waited N min, caught up, error reason, retried at…)
- duration `text-right text-micro font-mono text-text-quiet` "2m 14s"
Paginated: 30 rows, then "Show older" text-link.

Right — `flex flex-col gap-4`, three boxes:
1. **What it remembers** (`manta-routines-memory`): head `flex items-center gap-2 px-4 pt-3` NotebookText(14, text-text-faint) + `text-label font-semibold text-text` title + `ml-auto` `<IconButton icon={<Pencil/>} label="Edit memory"/>`; sub `px-4 pt-1 text-meta text-text-quiet` "Every run reads this first and updates it at the end. Last changed by <run label>."; body `<OutputWell variant="standalone">` (mono, `text-meta`, `whitespace-pre-wrap`), margin `mx-4 mt-3 mb-4`. Lines added by the most recent run are wrapped in `<span class="bg-[var(--diff-add)] rounded-xs">`. Lines starting with `## ` render `font-semibold text-text`. Edit → the body becomes `<Field multiline mono rows={12}>` + Save/Cancel `<Button>`s; a "Clear" `<Button tone="danger">` sits in the edit footer.
2. **Instructions**: same head (MessageCircle) + `<IconButton>`Pencil (opens R4); body `mx-4 mt-3 mb-4 text-label text-text-muted` with `$skill` tokens rendered as `inline-flex rounded-full bg-accent-bg px-2 font-mono text-meta text-accent-tx`.
3. **Settings list**: `<dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 px-4 pt-3 pb-4 text-meta">` dt `text-text-quiet`, dd `text-text-muted`: Triggers ("Schedule · Run now"), Missed runs ("Run once on catch-up, up to 6h late"), Keeps ("30 days of runs; unread runs are never deleted").

## R3 — One run (`RoutineRunView.tsx` wrapping the existing `ChatPanel`, hook `manta-routines-run`)

The run's transcript IS the existing `ChatPanel` mounted on the run's session id. Two
additions only:
- **Header**: ChatPanel's `SessionHeader` with the session menu HIDDEN and the crumb replaced by `Routines / <routine> / <Thu 30 Oct · 9:02>` and a `<Tag icon={<Eye/>}>read-only</Tag>` (or `<Tag icon={<GitBranch/>}>{branch}</Tag>` for edit routines). Right side prepends `<Button tone="default">`(PanelLeftOpen) "Keep in sidebar".
- **Run bar** below the header (`manta-routines-runbar`): `flex items-center gap-3 px-6 py-2 bg-bg-elev border-b border-border-subtle text-meta text-text-faint` — CalendarClock(14, text-accent-tx), `<b class="font-semibold text-text">Scheduled run</b>` (or "Manual run" / "Catch-up run" / "Webhook run") · started 9:02 · 2m 14s · 38.2k tokens; right `ml-auto flex gap-2`: `<Button tone="ghost">‹ Wed</Button>` `<Button tone="ghost" disabled>Fri ›</Button>` (prev/next run of the same routine).
- **Transcript**: the routine's prompt renders as the first user turn. It is the normal `MessageBubble`, with an `<Eyebrow>`-styled label row inside it ("Routine instructions", CalendarClock 12). Above it a divider row `flex items-center gap-2 text-meta font-medium text-text-faint` (Clock 12 text-accent-tx · cadence text · `flex-1 h-px bg-border-subtle`). The memory read/update show up as ordinary collapsed tool lines (they ARE tool calls).
- **Report card** (`manta-routines-report`) — rendered after the last assistant message when the run has a report. Chrome = the permission/ask card chrome (`rounded-lg border border-border bg-bg-soft shadow-md overflow-hidden`):
  head `flex items-start gap-3 px-4 pt-4 pb-3`: badge `grid place-items-center w-8 h-8 rounded-md bg-accent-bg text-accent-tx` (routine glyph 16) · body `flex-1 min-w-0`: kind label `text-micro font-semibold uppercase tracking-wider text-accent-tx` ("Findings" / "Nothing new" in text-text-faint / "Failed" in text-danger), title `mt-1 text-prose font-semibold text-text`, then the report's markdown body (bullets) rendered by the existing markdown renderer at `text-body text-text-muted`, `mt-2`.
  footer `flex items-center gap-2 px-4 py-2 border-t border-border-subtle bg-bg-elev text-meta text-text-faint`: Bell(14) "Notified you at 9:04" | "Filed quietly" ; right `ml-auto`: `<Button tone="default">Fix it in a new session</Button>` (creates a normal sidebar session in the routine's folder, seeded with the report + run link).
- **Composer**: the normal InputArea; its right-hand meta slot shows `text-meta text-text-quiet` "Replies stay with this run · “Keep in sidebar” makes it a normal session" instead of the ⏰/🔑/🪝 buttons.

## R4 — New / edit routine (`RoutineEditor.tsx` in `<Modal size="lg" tall label="New routine">`, hook `manta-routines-editor`)

Modal header `flex items-center gap-2 px-5 py-4 border-b border-border-subtle`: CalendarClock(16, text-accent-tx) + `text-title font-semibold` "New routine"|"Edit routine" + `ml-auto` `<IconButton icon={<X/>} label="Close"/>`.
Body `px-5 py-4 flex flex-col gap-4 overflow-y-auto`. Footer `flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-bg-elev`: `<Button tone="default">`(Play) "Test run now" · `ml-auto` · `<Button tone="ghost">Cancel</Button>` · `<Button tone="primary">Create routine|Save</Button>`.

Fields (labels use Field's `LABEL_CLS`; help uses `text-meta text-text-faint`):
1. **Name** — `<Field mono={false}>`.
2. **What should it do each time?** — `<Field multiline rows={4} mono={false}>`. `multiline` is a NEW prop on the existing Field primitive (renders a `<textarea>` with the same INPUT_BASE chrome, `resize-y`); adopters in this feature: this field, the memory editor (R2) and the convert modal (R6). Help: "Write it for someone starting fresh each time. Tip: try it once in a normal chat first."
3. Row `grid grid-cols-2 gap-3`: **Folder** (opens the existing `FolderPickerModal`; display = Field look, mono, Folder icon leading, ChevronDown trailing) · **Model** (`<SplitChip>`-free: a Field-look button that opens the existing `ModelMenu`; "Default" when unset).
4. **When** — the existing `<ChipGroup>` (Chip.tsx; Settings' `SegmentedField` wraps it). Options: Hourly · Daily · Weekdays · Weekly · Monthly · Custom. Second row depends on choice: Weekly → seven `<Chip on>` day toggles (Mon..Sun, multi-select) in an `inline-flex flex-wrap gap-2` wrapper + time Field (`w-24`, mono, `HH:MM`); Daily/Weekdays → time Field; Monthly → day-of-month Field + time; Hourly → minute Field ("at :MM"); Custom → cron Field (mono) + live `describeCron` preview. Help line `text-meta text-text-quiet`: "box time · <IANA tz> · first run <date>".
5. **What it's allowed to do** — `grid grid-cols-2 gap-2` of two radio cards: `flex gap-2 rounded-md border border-border bg-bg-soft p-3 cursor-pointer`, selected `border-accent bg-accent-bg`; radio dot 16px `rounded-full border-2 border-border-strong`, selected `border-accent-solid` with an 8px `bg-accent-solid` inner dot; title `text-label font-semibold text-text`, sub `text-meta text-text-faint`. "Read and report — Can read files, run commands and use your connectors. File edits are blocked." / "Make changes — Works on its own branch each run and can open a draft PR."
6. **Tell me** — `<ChipGroup>`: When it finds something · Every run · Only if it fails · Never.
7. `<Callout tone="info" size="note">` with NotebookText: "Each run starts fresh but reads **what the routine remembers** from earlier runs, then updates it. You can read and edit that on the routine's page."

Validation errors render under the field as `text-meta text-danger`. Create is disabled until name, instructions, folder and a valid schedule exist.

## R5 — Created-from-chat card (transcript tool renderer, hook `manta-routines-created-card`)

When the `routine_create` tool call completes, its tool part renders this card instead of the generic ToolCard:
`<Card>`-like: `rounded-lg border border-border bg-bg-soft shadow-sm overflow-hidden` with `max-width: var(--inline-max-w)`.
Head `flex items-center gap-3 px-4 py-3`: accent glyph tile (CalendarClock) · `text-meta text-text-faint` "Routine created" / `text-body font-semibold text-text` name.
Body `<dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 px-4 pb-3 text-label">` dt `text-text-quiet`, dd `text-text-muted`: When · Folder (+ " · read-only") · Tell you · Starts knowing ("The baselines from this chat (4 lines)" — the count of memory lines seeded; row omitted when 0).
Footer `flex gap-2 px-4 py-2 border-t border-border-subtle bg-bg-elev`: `<Button tone="default">Open routine</Button>` `<Button tone="ghost">`(Play) "Run now".
`routine_update` renders the same card with "Routine updated". Follow-ups (destination `session`) keep the existing ⏰ composer card behaviour.

## R6 — Follow-up → routine (`ConvertToRoutineModal.tsx`, `<Modal size="lg" tall label="Make it a routine">`, hook `manta-routines-convert`)

Body blocks (gap-4):
1. "from" strip: `flex items-center gap-3 rounded-md border border-border-subtle bg-bg-elev px-3 py-2` — MessageCircle · `text-label font-semibold text-text` prompt / `text-meta text-text-quiet` "<cadence> · runs inside “<session>”" · `ml-auto flex items-center gap-1 text-meta font-semibold text-accent-tx` ChevronRight "New session each run".
2. **Instructions, rewritten to make sense without the chat**: box `rounded-md border border-border-subtle overflow-hidden`; old `bg-[var(--diff-del)] px-3 py-2 text-label text-text-muted line-through`; new = `<Field multiline mono={false} rows={4}>` directly under the struck-through old text. Help "A fresh session can't see the chat, so “this week” and “billing” are spelled out. Edit freely." While the rewrite is generating: the new block shows `MantaLoader size="inline"` + "Rewriting…"; on failure it falls back to the original text with a `text-meta text-warn` note "Couldn't rewrite automatically — edit it so it stands alone."
3. **It will start out knowing**: `<Field multiline mono rows={6}>` + help "Taken from the chat. This becomes the routine's memory, and every run reads and updates it."
4. `grid grid-cols-[1.3fr_1fr_1fr] gap-2` of read-only Field-look boxes: Folder · When · Allowed to (each opens its editor inline on click).
5. Checklist `flex flex-col gap-1 text-meta text-text-faint`, each item `flex gap-2` with Check(14, text-ok): the three sentences from the mockup.
Footer: Test run now · Cancel · `<Button tone="primary">Make it a routine</Button>`.

## R7 — Routine → chat (`MoveToChatModal.tsx`, `<Modal size="lg" tall label="Run it inside a chat">`, hook `manta-routines-tochat`)

1. "from" strip (routine glyph; "<cadence> · new session each run · N runs" → "Inside a chat").
2. **Which chat?** — three radio cards (R4 radio-card chrome, full width, `flex flex-col gap-2`): the origin chat (if it still exists) "· the chat this routine was created from · active 6m ago" · "A new chat just for this — Shows up in the sidebar as “<name>”. Every run adds to it." · "Another chat… — Pick any session in the sidebar." (opens a session picker `Dropdown` listing chat-mode windows).
3. **What changes** checklist (four sentences from the mockup, the chat name interpolated).
4. `<Callout tone="info" size="note">` CircleHelp: "Good for check-ins you want to discuss. For independent daily reports, a new session each run keeps the chat from growing every day."
Footer: `ml-auto` Cancel · `<Button tone="primary">Move into chat</Button>`.

## R8 — Notification toast
Uses the EXISTING desktop notification path (OS notification) — no new in-app toast
component. The mockup's toast illustrates the payload only: title "<routine> · findings", body = report title, click → R3.

---

## Fixture (demo state `?demo&state=routines&desktop`)

The demo transport must return exactly the mockup's content so `npm run visual:compare`
compares layout, not words. Clock pinned to **Thu 30 Oct 2026 10:01** box-local.

Routines (in table order): see the mockup's "Your routines" table — 8 rows with the
names, projects, cadences, access, last-run states, notes, next times and enabled
flags exactly as written there. Runs for "Daily analytics digest": the 7 rows in the
mockup's R2 table. Needs-you: 1 (Weekly bug triage question). Findings unread: 3 (as in
R1.2). Running: Docs drift check (3m 41s, manual), Competitor pricing scan (52s).
Waiting: #1 Error budget check (scheduled 10:00), #2 Dependency audit (manual 10:01).
Follow-ups: 3 rows as in R1.5. Memory text: verbatim from the mockup (the two lines
under "## Watching" from "checkout errors…" are the most-recent-run additions).
Run transcript (R3) for run "Thu 30 9:02": prompt, 5 tool lines, one paragraph, one
memory-update tool line, report — verbatim.

Sidebar counts: needsYou 1, unread 3.

## Visual registry rows (`scripts/visual/screens.mjs`)

All rows: `url: "/app/index.html?demo&state=routines&desktop"`, `mockup: "docs/screens/routines/mockup.html"`, `viewport: DESKTOP_VIEWPORT`,
`ready: '[data-screen="routines"]'`. Each row's `mockupActions` clicks the mockup tab
`[data-s="<id>"]` and `mockupRegion` is `.app`.

| id | actions (real gestures) | final / region |
|---|---|---|
| routines-overview | click `aria-label="Open Routines"` | `.manta-routines-pane` |
| routines-detail | + click row "Daily analytics digest" | `.manta-routines-detail` |
| routines-run | + click run "Signups up 18%…" | `.manta-routines-run` |
| routines-create | overview + click "New routine" | `.manta-routines-editor` (snapshot = editor) |
| routines-created-card | `?demo&state=routines-chat&desktop` (opens "Analytics review") | `.manta-routines-created-card` |
| routines-convert | overview + click 2nd follow-up's "Make it a routine" | `.manta-routines-convert` |
| routines-tochat | detail + click destination chip + "Inside a chat…" | `.manta-routines-tochat` |

Record baselines with `npm run visual:update`, run `npm run visual:compare`, and
record findings in `docs/screens/routines/conformance.md` per the definition of done.

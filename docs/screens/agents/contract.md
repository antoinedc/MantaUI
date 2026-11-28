# Agent screens — design contract

Companion to `docs/screens/agents/mockup.html` (the design) and
`docs/superpowers/specs/2026-11-26-agents-screens.md` (the behaviour). Where this file and the mockup disagree, the
mockup wins and this file is the bug — except for elements marked `data-component="… unchanged"` in the mockup: those
are EXISTING components drawn as they ship; render the component, never copy the mockup's HTML.

## Rules

1. **Reuse first** (binding decision 3). Use the components below; no inline re-implementation of their chrome, no
   `className` escape hatch (`docs/components.md`).
2. **No raw hex, no off-grid spacing.** Spacing from the Tailwind steps; type from the roles `text-title`(17)
   `text-prose`(15) `text-body`(14) `text-label`(13) `text-meta`(12) `text-micro`(11).
3. **No new tokens** (§Tokens). Component-only numbers are constants in code (§Constants).
4. **Hooks:** every new region carries a `manta-agents-*` hook class (no styles) for the visual registry.
5. **Both themes**; nothing here has a per-theme override.

## Components

### Reused unchanged (render them; do not restyle)

| Where in the mockup | Component (file) | Data |
|---|---|---|
| Question in chat, Fleet → Needs you | `QuestionCard` (`Cards.tsx`) | `TaskQuestion` → `QuestionRequest` (spec §4.4), header "<Agent> asks you" |
| Ask confirmation, profile pending change, history expansion, Needs-you change | `AgentChangeView` (`AgentChangeCard.tsx`); the profile's pending change passes the optional `collapsed` (one summary line + the change folded; everything else is the unchanged card) | `AgentChange` record |
| Architect result + its proposals | `BackgroundResultCard` + `ArchitectChanges` (`BackgroundCards.tsx`, `ArchitectChanges.tsx`) | N4 part / job id |
| Needs-you review item (a decision, or the user's own unmerged branch — rule set P1) | `BackgroundResultCard` look via the same component, fed from `NeedsYou.reviews`; the context line carries its `reason` | job |
| Task run card ("Working · 1 question") | `RunCard` in `BackgroundRunCards` (`BackgroundCards.tsx`) + one chip from `openQuestionsByJob`, + the "Added @slug to <Project>" line from `seatAdded` | job view |
| Side panel "What happened" | `JobDetails` (`BackgroundCards.tsx`, exported as is) | job `view` |
| Buttons | `Button` tones `primary` / `default` / `ghost`; `IconButton` (Close, "+") | |
| Chips / tags | `Pill` (`ok` fresh, `warn` stale, `neutral` thin / later), `Tag` (sidebar "via Manta") | |
| Status dots | `StatusDot` | |
| Seat remove confirm | `ConfirmInline` | |
| Refresh Monthly / Off (Monthly is the default) | `Segmented` | `AgentProfile.refresh.enabled` |
| `@` picker | `TypeaheadPopup` (`ComposerParts.tsx`), agent rows extended (spec §2.3) | |
| New agent / Change via Manta | the new-session draft (`createDraft` / `updateDraft`, `NewSessionScreen`) | |
| Sidebar rows | the rail row class of `AgentsSection.tsx` (`ROW_CLASS`, density tokens) | |

### New (thin)

| Component (file, owner) | What it is |
|---|---|
| `FleetPage` (`agents/FleetPage.tsx`) | **Superseded by the Fleet redesign** (`docs/screens/fleet/`, `docs/superpowers/specs/2026-11-28-fleet-redesign.md`): tasks by project or agent, the decisions card, Ended today, Details. The agents × projects grid and the recap are gone from the page. |
| `NeedsYouPage` (`agents/NeedsYou.tsx`) | **Superseded by the Fleet redesign:** its own page, items under project headings; each item is the existing card under a title and who-line. |
| `AgentProfile` (`agents/AgentProfile.tsx`, R1) | header, pending card, tablist + panels; every tab is a `TwoColumn` (content + tinted pane, `agents/ProfileLayout.tsx`) |
| `AgentResearch` (`agents/AgentResearch.tsx`) | the Research tab: expandable entry rows + the library / health / refresh pane |
| `AgentHistory` (`agents/AgentHistory.tsx`, R1) | native-disclosure rows (when, who, summary, status + reason); open → `AgentChangeView` (Undo only on the newest live one) + the quiet restore link; `HistoryPane` |
| `AgentSeats` (`agents/AgentSeats.tsx`, R1) | seat rows (brief, inline access map, Edit brief / Remove seat), brief editor (`<textarea>` + counter), pane: what a seat is + add-seat `<select>` |
| `TaskSidePanel` (`TaskSidePanel.tsx`, R2) | right-slot panel: top bar + `JobDetails` + `ResearchRows` + brief `<details>` |
| `ResearchRows` (`ResearchRows.tsx`, R2) | library entry rows (topic, sources · age, fresh/stale/thin `Pill`s); used by the panel and the profile |

## Regions → classes

| Mockup | Implementation |
|---|---|
| `.phead` (page header bar) | the Routines header recipe: `h-11 flex items-center gap-2 px-4 border-b border-border text-label`, reserving `--pane-inset-x` / `--titlebar-inset-right` like the Routines header |
| `.h2` section titles | `text-label font-semibold text-text` + count `Pill tone="warn"` |
| `.ny-ctx` context line | `flex items-center gap-2 text-meta text-text-faint`; name `text-text-muted font-semibold` |
| `.recap` | `rounded-md bg-fill px-3 py-2 text-label text-text-muted`; lead-in `text-text font-semibold`; a line about one task carries a ghost "Open" button |
| `table.mx` | `<table>` `w-full text-meta`; `th` `text-left font-semibold text-text-faint px-2 py-2 border-b border-border`; `td` `px-2 py-2 border-b border-border-subtle align-top`; first column `<th scope="row">` sticky (`sticky left-0 bg-bg`) |
| `.cell` | `flex flex-col gap-px w-52`; title `truncate text-text-muted`; state line `flex items-center gap-2 text-text-faint` with `StatusDot`; empty `text-text-quiet` "—" |
| `.phero` | `flex gap-4 items-start`; name `text-display font-semibold text-text`; facts `text-label text-text-faint flex flex-wrap` with a `·` separator drawn by CSS (`@slug · Specialist · 2 seats`); description `text-prose text-text max-w-[68ch]`, shown once |
| `.av` / `.av.lg` / `.av.sm` | agent badge: `rounded-sm` (`rounded-md` large) filled with `AgentInfo.color`, initials `font-semibold` (`text-micro`; the 44px one `text-prose`) in the better of white / near-black on that colour (`agentInk`, WCAG ratio), sizes 14 (rail, as today) / 22 / 44 px |
| `.ptabs` | tablist: `flex gap-5 border-b border-border text-label`; tab `py-2 text-text-faint`, selected `text-text` + 2px `border-b-2 border-accent` drawn on `::after` (the `tabs` guide: a border, not a box-shadow); disabled Tests `text-text-quiet` |
| `.h2` in the main column (`BlockTitle`) | `text-body font-semibold text-text mb-2`; no uppercase eyebrow; an optional control at the row's end ("All 4 →", `text-meta font-medium text-accent-tx`) |
| `.ov` (Overview) | a `[container-type:inline-size]` wrapper around `grid gap-8`; one column, and `grid-cols-[minmax(0,1fr)_18rem]` from a container width of 720px (`[@container(min-width:720px)]:`) |
| `.dl` (How to use it) | `grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-3`; `dt` `text-label text-text-faint`, `dd` `text-body text-text`; a row only for a field the agent has |
| `.instr` | native `<details>`: chevron + "Full instructions · N lines" `text-label font-medium text-text-muted`, a `border-t border-border-subtle` above; the text in `bg-fill rounded-md text-meta` |
| `.pane` (details pane) | `<aside aria-label="Details">` `rounded-lg bg-bg-elev p-4`, `sticky top-4` from 720px; groups separated by `border-t border-border` (dark: `border-border-subtle`, plus an inset `border-border-subtle` ring); group titles `text-meta font-semibold text-text-muted` |
| `.kv` (pane Details) | `grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-label`; `dt` `text-text-faint`, `dd` `text-text text-right` |
| `.change` (collapsed pending card) | the `Card` chrome (elevated when pending); header = chip, `Architect · summary` (`text-body text-text`, who `font-semibold`), Discard / Apply; native `<details>` fold `text-meta font-medium text-text-faint` ("Show the change · 3 lines · based on 2 sources") |
| `.rw` rows | `flex items-center gap-2 py-2 border-b border-border-subtle text-label`; right meta `ml-auto text-meta text-text-faint whitespace-nowrap` |
| `.rows` / `.src` (Research) | `border-t border-border-subtle` list; row `flex min-h-10 items-center gap-3 py-2 border-b border-border-subtle`, native `<details>` (chevron rotates on open); sources `text-meta text-accent-tx` links under the row, indented; "Also used by …" `text-meta text-text-faint` |
| `.seatrow` | `py-4 border-b border-border-subtle`; name `text-body font-semibold`, notes `text-meta text-text-faint` at the end; brief `text-body text-text` (whole, `whitespace-pre-line`); access map inline (`flex-wrap`); actions: "Edit brief" `text-meta font-medium text-accent-tx`, "Remove seat" a quiet underlined link (`hover:text-danger`) |
| `.hrow` | `<details>` row, `summary` a `grid-cols-[56px_minmax(0,1fr)_auto] py-3` grid: when `text-label text-text-faint`; who (neutral badge + name `text-label text-text-muted`), summary `text-body text-text`, status line (6px dot + label `text-meta font-medium` in ok / accent / faint / warn, then the reason `text-text-faint`); "Details ›" `text-meta text-text-faint`; opened content indented 68px |
| `.mem` | rows, not cards: name `text-label text-text` and one tag at the end (`text-meta rounded-xs px-1`: read `bg-fill-active text-text-muted`, read + write `bg-accent-bg text-accent-tx`, no access `text-text-faint`); in the pane no hairlines, in the Seats tab hairline rows with the note inline |
| research "thin" tag | `Pill tone="warn"` (like stale) |
| `.hrow` | `grid grid-cols-[52px_1fr_auto] gap-x-3 gap-y-2 py-2 border-b border-border-subtle text-label [content-visibility:auto] [contain-intrinsic-size:auto_64px]` |
| `.tsp` side panel | fixed-width sibling like `ArtifactsPanel`: `w-[440px] border-l border-border bg-bg-elev flex flex-col`; top bar `h-11 px-4 border-b border-border`; body `overflow-auto px-4 pt-4 pb-6 flex flex-col gap-6` |
| `.newag` | `Button tone="default"` "New agent" + `text-micro tracking-normal text-text-faint` hint |

## Icons (lucide-react)

`i-inbox`→`Inbox` · `i-grid`→`LayoutGrid` · `i-plus`→`Plus` · `i-folder`→`Folder` · `i-book`→`BookOpen` · `i-x`→`X` ·
`i-chev`→`ChevronRight` · `i-help`→`HelpCircle` (in QuestionCard already) · `i-bot`→`Bot` (in AgentChangeView already) ·
`i-send`→`Send` (QuestionCard) · `i-pr`→`GitBranch`.

## Tokens

The mockup inlines `src/renderer/tokens.css` verbatim (it predates `--usage-dot*`, unused here). Its own values map as:

| Mockup value | Existing token / utility |
|---|---|
| `--canvas / --panel / --card / --raised` | `bg-bg` / `bg-bg-elev` / `bg-bg-soft` / `bg-raised` |
| `--fill`, `--fill-hover`, `--fill-active` | `bg-fill`, `bg-fill-hover`, `bg-fill-active` |
| `--border-subtle / --border / --border-strong` | `border-border-subtle` / `border-border` / `border-border-strong` |
| `--tx1..--tx4` | `text-text` / `text-text-muted` / `text-text-faint` / `text-text-quiet` |
| `--accent`, `--accent-tx`, `--accent-solid`, `--accent-bg`, `--on-accent` | `accent`, `text-accent-tx`, `bg-accent-solid`, `bg-accent-bg`, `text-on-accent` |
| `--ok/--warn/--danger` (+ `-bg`) | `ok` / `warn` / `danger` (+ `-bg`) |
| `color-mix(--warn 70%, black)` for "thin" (light) | `text-warn` (light `--warn` is already AA on panel) |
| `color-mix(--accent …)` tints | `bg-accent-bg`, `border-accent` |
| per-agent `oklch(…)` hues (`.a-seo` …) | `AgentInfo.color` (agent.md `color`); none → `bg-fill-hover text-text` as today |
| font sizes 15 / 14 / 13 / 12 / 11 / 10 / 20 px | `prose` / `body` / `label` / `meta` / `micro` / `micro` / `title` (`text-micro` carries 0.08em tracking for uppercase labels: add `tracking-normal` wherever it sets lowercase prose — hints, notices, initials) |
| weights 650 / 550 / 450 | `font-semibold` / `font-medium` / `font-normal` |
| radii 4 / 6 / 8 / 12 / 99 | `rounded-xs` / `sm` / `md` / `lg` / `full` |
| spacing 5, 7, 9, 11 px paddings; 14, 18, 22, 28 gaps | nearest steps: 4 / 8 / 8 / 12; 12 / 16 / 24 / 24 |
| shadows | `shadow-sm` / `shadow-md` / `shadow-lg` |
| motion (details chevron) | `--motion-fast` + `--ease-out` |

**New tokens: none.** Every value resolves to an existing token or a code constant.

## Constants (code, not tokens)

| Name | Value | Where |
|---|---|---|
| `TASK_PANEL_WIDTH_PX` | 440 | `TaskSidePanel.tsx` (Artifacts uses 340; the panel carries step text) |
| `HISTORY_LIMIT` | 50 | server + `AgentHistory.tsx` |
| `OVERVIEW_PREVIEW` | research 4 | `AgentProfile.tsx` |
| `FLEET_REFETCH_DEBOUNCE_MS` | 1000 | `agentsView.ts` |
| `SEAT_BRIEF_MAX` | 4000 chars | server + `AgentSeats.tsx` |
| `QUESTIONS_OPEN_MAX` | 3 per task | server |

## States

- **Needs you item** (Fleet redesign): a decision (change waiting for a click, task that ended needing a decision) or an open question; an unmerged branch is never an item. An item leaves when the task's session is opened, or Done.
- **Fleet and Needs you states:** see `docs/screens/fleet/` (ideal, empty, loading, load error, box unreachable, failed action, many items, long-running) and the spec §1.
- **Profile:** loading, error, invalid agent (its `error`, no tabs), lead/Architect (no seats actions, no refresh control, "Works in every project"), pending cards 0..n (collapsed); an agent with no use when / not for ("Nothing written yet…"); refresh Monthly (default) / Off / saving / refused (sentence); narrow page (the pane stacks under the main column). No Tests tab or box.
- **History row:** live (applied automatically / you approved it) / undone (by you) / waiting (its card is above) / other states, each a coloured dot + label + reason; collapsed / expanded; Restore busy ("Restoring…"), refused (sentence under the row), done (the new
  record's row appears at the top, expanded).
- **Research row:** with sources (opens; the first at the start) / without (plain row, counts) / missing ("no longer in the library"); a source link that can't open says so in the row.
- **Seat row:** view / editing (textarea + "N / 4000") / saving / save error / confirm remove; a lead or Architect has no rows ("Works in every project").
- **Question card** (unchanged component, no busy/error props): open; while the answer call runs the card stays as is;
  a refusal shows on the chat's existing send-error line (in Needs you: an alert line in the item's context row); after a
  successful answer the refetch removes the card; the milestone in the side panel records it.
- **Side panel:** running / done / failed / job gone ("This task is no longer on the box" + Close).

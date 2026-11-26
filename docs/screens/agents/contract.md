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
| Ask confirmation, profile pending change, history expansion, Needs-you change | `AgentChangeView` (`AgentChangeCard.tsx`) | `AgentChange` record |
| Architect result + its proposals | `BackgroundResultCard` + `ArchitectChanges` (`BackgroundCards.tsx`, `ArchitectChanges.tsx`) | N4 part / job id |
| Needs-you review item | `BackgroundResultCard` look via the same component, fed from `NeedsYou.reviews` | job |
| Task run card ("Working · 1 question") | `RunCard` in `BackgroundRunCards` (`BackgroundCards.tsx`) + one chip | job view |
| Side panel "What happened" | `JobDetails` (`BackgroundCards.tsx`, exported as is) | job `view` |
| Buttons | `Button` tones `primary` / `default` / `ghost`; `IconButton` (Close, "+") | |
| Chips / tags | `Pill` (`ok` fresh, `warn` stale, `neutral` thin / later), `Tag` (sidebar "via Manta") | |
| Status dots | `StatusDot` | |
| Seat remove confirm | `ConfirmInline` | |
| Refresh Off / Monthly | `Segmented` | |
| `@` picker | `TypeaheadPopup` (`ComposerParts.tsx`), agent rows extended (spec §2.3) | |
| New agent / Change via Manta | the new-session draft (`createDraft` / `updateDraft`, `NewSessionScreen`) | |
| Sidebar rows | the rail row class of `AgentsSection.tsx` (`ROW_CLASS`, density tokens) | |

### New (thin)

| Component (file, owner) | What it is |
|---|---|
| `FleetPage` (`agents/FleetPage.tsx`, R1) | page shell: header pills, Needs you, recap, grid |
| `NeedsYou` (`agents/NeedsYou.tsx`, R1) | list of `{context line + existing card}`; the context line is the only new markup |
| `AgentProfile` (`agents/AgentProfile.tsx`, R1) | header, pending cards, tablist + panels |
| `AgentHistory` (`agents/AgentHistory.tsx`, R1) | rows (date, who, summary, outcome, actions); expands to `AgentChangeView` |
| `AgentSeats` (`agents/AgentSeats.tsx`, R1) | seat rows, brief editor (`<textarea>`), add-seat `<select>`, memory map grid |
| `TaskSidePanel` (`TaskSidePanel.tsx`, R2) | right-slot panel: top bar + `JobDetails` + research rows + brief `<details>` |

## Regions → classes

| Mockup | Implementation |
|---|---|
| `.phead` (page header bar) | the Routines header recipe: `h-11 flex items-center gap-2 px-4 border-b border-border text-label`, reserving `--pane-inset-x` / `--titlebar-inset-right` like the Routines header |
| `.h2` section titles | `text-label font-semibold text-text` + count `Pill tone="warn"` |
| `.ny-ctx` context line | `flex items-center gap-2 text-meta text-text-faint`; name `text-text-muted font-semibold` |
| `.recap` | `rounded-md bg-fill px-3 py-2 text-label text-text-muted`; lead-in `text-text font-semibold` |
| `table.mx` | `<table>` `w-full text-meta`; `th` `text-left font-semibold text-text-faint px-2 py-2 border-b border-border`; `td` `px-2 py-2 border-b border-border-subtle align-top`; first column `<th scope="row">` sticky (`sticky left-0 bg-bg`) |
| `.cell` | `flex flex-col gap-px max-w-52`; title `truncate text-text-muted`; state line `flex items-center gap-2 text-text-faint` with `StatusDot`; empty `text-text-quiet` "—" |
| `.phero` | `flex gap-3 items-start`; name `text-title font-semibold`; facts `text-meta text-text-faint flex gap-3 flex-wrap`; description `text-label text-text-muted max-w-[70ch]` |
| `.av` / `.av.lg` / `.av.sm` | agent badge: `rounded-sm` (`rounded-md` large) filled with `AgentInfo.color`, initials `text-micro font-semibold`, sizes 14 (rail, as today) / 22 / 44 px |
| `.ptabs` | tablist: `flex gap-5 border-b border-border text-label`; tab `py-2 text-text-faint`, selected `text-text` + 2px `border-b-2 border-accent` drawn on `::after` (the `tabs` guide: a border, not a box-shadow); disabled Tests `text-text-quiet` |
| `.blk h3` | `text-meta uppercase tracking-wider text-text-faint font-semibold mb-2` |
| `.rw` rows | `flex items-center gap-2 py-2 border-b border-border-subtle text-label`; right meta `ml-auto text-meta text-text-faint whitespace-nowrap` |
| `.mem` | `grid grid-cols-2 gap-2`; cell `rounded-md border border-border-subtle px-3 py-2 text-meta text-text-faint`; title `text-label font-semibold text-text` |
| `.muted` (Tests later) | `rounded-md border border-dashed border-border px-3 py-2 text-meta text-text-faint` |
| `.hrow` | `grid grid-cols-[52px_1fr_auto] gap-x-3 gap-y-2 py-2 border-b border-border-subtle text-label`, `content-visibility:auto` |
| `.tsp` side panel | fixed-width sibling like `ArtifactsPanel`: `w-[440px] border-l border-border bg-bg-elev flex flex-col`; top bar `h-11 px-4 border-b border-border`; body `overflow-auto px-4 pt-4 pb-6 flex flex-col gap-6` |
| `.newag` | `Button tone="default"` "New agent" + `text-micro text-text-faint` hint |

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
| font sizes 15 / 14 / 13 / 12 / 11 / 10 / 20 px | `prose` / `body` / `label` / `meta` / `micro` / `micro` / `title` |
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
| `FLEET_CELL_MAX_PX` | 208 (`max-w-52`) | `FleetPage.tsx` |
| `HISTORY_LIMIT` | 50 | server + `AgentHistory.tsx` |
| `OVERVIEW_PREVIEW` | research 4, history 3 | `AgentProfile.tsx` |
| `FLEET_REFETCH_DEBOUNCE_MS` | 1000 | `FleetPage.tsx` |
| `SEAT_BRIEF_MAX` | 4000 chars | server + `AgentSeats.tsx` |
| `QUESTIONS_OPEN_MAX` | 3 per task | server |

## States

- **Fleet:** loading (skeleton rows after 150 ms), error (sentence + Try again), empty Needs you ("Nothing needs you."),
  no agents ("No agents yet" + New agent), older box (channel unknown → "Update the box to see the fleet").
- **Profile:** loading, error, invalid agent (its `error`, no tabs), lead/Architect (no seats actions), pending cards 0..n.
- **History row:** collapsed / expanded; Restore busy ("Restoring…"), refused (sentence under the row), done (the new
  record's card appears at the top, expanded).
- **Seat row:** view / editing / saving / save error / confirm remove.
- **Question card:** open / submitting / refused (sentence) — after a successful answer the card disappears (the store
  hint removes it); the milestone in the side panel records it.
- **Side panel:** running / done / failed / job gone ("This task is no longer on the box" + Close).

# Usage popover — clear next resets (5-hour + weekly) for every seat

Status: approved by the user 2026-11-17 (mockup "Proposal B, revised").
Mockup (wins on looks): `docs/screens/usage-resets/mockup.html` — open it in a browser; Dark/Light toggle top right.

## Problem

In the composer's usage popover (`src/renderer/UsageDial.tsx`, `UsagePopoverBody`):

1. The reset of each window is a faint 13 px line under its bar ("resets in 1d18h (Thu, 19 Nov, 09:00)") — hard to scan.
2. "Other seats" show a reset only when the seat is ≥ 95 % loaded (`seatResetHint`), and only for one window — most seats show no reset at all.
3. A window that has not started yet (0 %, provider sends no reset time) shows nothing instead of saying why.
4. Nothing shows where we are inside the window, so "62 % used" can't be judged.

## Scope

Renderer only. No server, wire or iOS change. The dial ring, its tooltip/aria label, and Settings → Accounts (`SeatsPanel`, which keeps using `UsageWindowRow`) are unchanged.

## Design (popover body, top to bottom)

Unchanged: header (provider name, plan label, Automatic/Manual pill), the conversation-seat line (+ "new conversations start here", Logged-out badge), the "Quota is being reset…" notice, the "Update your box to see usage colours" note, extras (credits…), last-move block, footer (Manage seats + updated ago).

### 1. Reset cards — the conversation's seat (replaces the `UsageWindowRow` list in the popover)

- One card per **bar window** = `seatBarWindows(snapshot.windows)` (session + unscoped weekly; provider-generic fallback already in that helper). Two cards side by side in a 2-column grid (`gap 8px`); one window → one full-width card.
- Card chrome (mockup `.chip`): `rounded-md` (8 px), `border border-border-subtle`, `bg-inset`, padding `9px 10px 10px`.
- Row 1: label in the micro style (11 px, uppercase, `letter-spacing .08em`, `text-text-faint`) = `"<noun> · resets"` where noun is `5-hour` for a 5 h window, `Weekly` for a weekly-kind window, otherwise the window's `label` (derive from `kind`/`spanMs`/`label`, never a provider name). Right: the percentage, mono, `text-meta text-text-muted` (no "used" wording anywhere).
- Row 2 (headline, `text-prose font-semibold`): the **absolute reset**: same local day → time only ("16:40"); otherwise `"<Wkd> <d> <Mon> · <time>"` ("Thu 19 Nov · 09:00"). Locale formatting via `Intl` like the existing `RESET_*_FMT`.
- Row 3: the countdown `in <formatResetDistance(delta)>` ("in 2h20m", "in 1d18h") as a **reset timer with tooltip** (§4), `text-meta`.
- Row 4: the **window bar** (§3), 6 px, `mt-2`.
- States:
  - `stale` (reset instant passed, new numbers not in): headline "Resetting…", no countdown, bar empty, no dot.
  - no `resetsAt` and pct 0: headline "Not started", row 3 "starts on first use" (faint), empty bar, no dot.
  - no `resetsAt` and pct > 0: headline "—", row 3 omitted, bar filled, no dot.
  - blocked (`usageWindowBlocker`): card at `opacity-50`, row 3 = "not usable until the <label> limit resets" instead of the countdown.
- **Other windows** of the conversation's seat (scoped e.g. "Weekly · Fable", any third window), each as one faint `text-meta` line under the cards, `mb-3`: `"<label> <pct>% · resets with the <card noun> window"` when its `resetsAt` equals a card window's, else `"<label> <pct>% · "` + reset timer; inactive (`active === false`) → `"<label> · not active"`.

### 2. Seat table — only when the provider has ≥ 2 seats (`multi`); replaces the "Other seats" list

- Columns: `Seat` | `5-hour` | `Weekly` (headings = the card nouns; micro style, faint). `table-layout: fixed`, window columns 118 px, popover min-width stays 420 px (the mockup is 440 px).
- **Row 1 = the conversation's seat** (or the "new conversations start here" seat when unassigned): `bg-accent-bg` + 2 px inset left accent bar, sub-line "this conversation" (or "new conversations start here").
- Then every other seat in `orderOtherSeats` order; an account heading row (faint, spans all columns) when `showHeading`.
- Seat cell: name, `next` tag (automatic mode, same as today), Logged-out badge (same control, same re-sign flow). Manual mode: sub-line link **"Use this seat"** (dotted underline, `text-meta text-text-muted`) that triggers the existing `switcher.request(seat)` + the existing confirm block (rendered under the row, spanning the table). Disabled with the same reasons as today's Use button.
- Window cell: line 1 = pct (mono, `font-medium`; coloured with the tone colour when warn/danger, else `text-text`) left, and on the right the **countdown only** ("in 45m") as a reset timer with tooltip — never a date in the table. Line 2 = window bar (§3) 5 px, `mt-[5px]`.
  - not started → right side "not started" (faint), empty bar, no dot. stale → "resetting…". No reading / logged-out with no windows → cell text "no reading" (faint).
  - blocked → cell `opacity-40` with the existing `title`.
- Cells are `white-space: nowrap`; the seat cell wraps.

### 3. Window bar (cards + table)

- Track `bg-fill-active`, fully rounded; fill width = pct, colour = existing `toneRingColor(w.tone)` (stale/inactive → empty).
- **Position dot** = where now is inside the window: a white dot (`#fff`) centred vertically, 4 px on the 6 px bar, 3 px on the 5 px bar, with a 1 px ring `rgb(0 0 0 / .45)` in dark and `rgb(26 24 21 / .55)` in light (add one token pair, e.g. `--usage-dot` / `--usage-dot-ring`, in `tokens.css` for both themes). Left = `clamp(4%, progress, 96%)`.
- `progress` = new pure helper `windowProgress(w, nowMs): number | null` in `chatUtils.ts`: `startedAt` + `resetsAt` → `(now − startedAt) / (resetsAt − startedAt)`; else `resetsAt` + `spanMs` → `1 − (resetsAt − now) / spanMs`; clamp 0..1; `null` (no dot) when stale, inactive, no `resetsAt`, no span, or reset in the past.
- The bar carries `title="<n>% of the way through this window"` when it has a dot.

### 4. Reset timer + tooltip

- The countdown text is a focusable element (`tabIndex=0`, `aria-describedby` → the tooltip) with a hover/focus affordance (text goes `text-text`, dotted underline in `text-text-faint`; `focus-visible` accent ring).
- Tooltip shows on pointer enter / focus, hides on pointer leave / blur / `Escape` (Escape closes only the tooltip: stop the event so the popover stays open). Stays open while the pointer is over the tooltip itself (WCAG 1.4.13: hoverable + dismissible). No delay needed beyond ~150 ms open delay.
- Content: line 1 bold `Resets <Wkd> <d> <Mon> at <time>`, prefixed `Today, ` on the same local day ("Resets Today, Tue 17 Nov at 15:05"); line 2 faint `in <distance>` + `· window started <date>` only when the provider reported `startedAt`.
- Look (mockup `.tip`): `rounded-sm`, `border border-border`, `bg-raised`, `shadow-lg`-ish, 12 px, padding `7px 10px`, nowrap, `role="tooltip"`.
- Placement: above the timer, flips below when there is no room; clamped to the viewport. It must **not be clipped** by the popover's `overflow-y-auto`: render it in a portal (`document.body`) with `position: fixed`, `z-index` above the popover (popover is z-40/55 → tooltip 60 is the toast layer; use z-[56]). **Reuse the positioning math of `Popover.tsx`**: extract its compute step into an exported pure helper (e.g. `placeFloating(anchorRect, size, viewport, placement, align)`) used by both `Popover` and the new component — do not write a second positioning engine.
- One component, e.g. `src/renderer/ResetTimer.tsx` (`<ResetTimer resetsAt startedAt nowMs />`), used by the cards, the extra-window lines and the table.

### 5. Removed from the popover

`UsageWindowRow` (still exported and used by `SeatsPanel`), `OtherSeatRow`, `SeatMiniBars` (delete if no other consumer remains; update `UsageDial.tone.test.tsx`), and the popover's use of `seatResetHint` (delete it if unused).

## Libraries considered

| Need | Chosen | Considered / why rejected |
|---|---|---|
| Tooltip trigger semantics | Hand-rolled focus/hover handlers on a focusable span, `role="tooltip"` + `aria-describedby` | Native `interestfor` + `popover="hint"` (modern-web-guidance `interest-triggered-tooltips`): the desktop renderer ships Electron 31 = Chromium 126; interest invokers need Chromium 149, `hint` 151 — unavailable. `interestfor` npm polyfill: would also need the anchor-positioning polyfill (no implicit anchors), two new deps for one tooltip type. |
| Tooltip positioning | Existing `Popover.tsx` placement math, extracted into a shared pure helper | `@floating-ui/dom` (well maintained, MIT): rejected only to avoid a second positioning engine beside the Popover primitive every other surface uses; CSS anchor positioning: Chromium 126 has only the pre-standard syntax (`position-area`/`position-try-fallbacks` landed in 128+). |
| Escaping the popover's scroll clipping | React portal + `position: fixed` (same as `Popover`) | Native top-layer `popover="manual"`: works in Chromium 126 but the usage popover itself is a portalled fixed div, not top-layer, so it adds no benefit over the existing pattern. |
| Date/time formatting | `Intl.DateTimeFormat` (as the existing reset formatters) | date-fns/dayjs: not needed for two formats. |
| Bar + dot | Plain elements + tokens | Chart libs: overkill. |

Modern Web Guidance used: `interest-triggered-tooltips` (WCAG 1.4.13 rules, ARIA wiring), `accessibility`.

## Tests (vitest, pure + component)

- `windowProgress`: startedAt path, spanMs path, clamp, stale/inactive/no-reset/past → null.
- Card headline/countdown/tooltip formatting helpers (same day vs other day, "Today, " prefix, startedAt clause).
- Component: cards render one per bar window with absolute headline; table rows for every seat with countdown-only cells (no date text in the table); not-started / stale / no-reading / logged-out / blocked states; manual-mode "Use this seat" opens the existing confirm; tooltip opens on focus and hover, closes on Escape without closing the popover; dot present only when progress is known.
- Existing `UsageDial.*.test.tsx`, `seatSelectors.test.ts`, `UsageWindowRow.test.tsx` updated where they asserted the removed popover markup — never deleted to make them pass unless the thing they test is gone.

## Revision 2026-11-18 — compact popover

The popover was too big; this supersedes the parts of the design above it contradicts.

- Reset cards (§1) removed; after the header the popover starts with the seat table. The absolute-reset headline is gone with them (the tooltip still carries the exact date); `formatResetHeadline` is deleted.
- The conversation-seat line is removed; the table's highlighted first row names the seat and carries its Logged-out badge (a working control that opens the re-sign flow).
- The last-move block is removed, with `formatLastMove`.
- A provider with no seat choice (or no `view`) gets the same table with one highlighted row built from `snapshot.windows` (name = the account label, else the plan, else the provider; sub-line "this conversation"; no Use / next / badge). No window columns, no table.
- Other windows (scoped caps, a third window) stay as faint lines directly under the table; inactive ones are omitted (no "not active" line).
- Table bars are 3 px tall (the non-small bar variant is removed); the position dot is a white core of 1 px radius with a ring out to 1.5 px, still a gradient overlay.
- Popover minimum width back to 420 px.
- A model-scoped (or any other) extra window is no longer a faint line under the table: every other ACTIVE window kind that any row has becomes its own column, after 5-hour and Weekly, by first appearance (`usageTableColumns`). Its header is the window's `scope` (else its noun) with the full label in a `title`; a seat without that window, or with it inactive, shows "—". The popover's minimum width grows by 110 px per column beyond two (`usagePopoverMinWidth`); window columns stay 118 px.
- A window the provider flags as not in force (`active: false`, e.g. Claude Team's scoped caps report `is_active: false` while still carrying real usage) is shown in the table with its figure; only the dial and the router ignore it.

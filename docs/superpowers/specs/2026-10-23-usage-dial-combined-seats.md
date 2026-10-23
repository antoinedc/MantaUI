# Usage dial: combined seats in automatic mode + remove the seat-move line

Date: 2026-10-23. Scope: desktop renderer only (`src/renderer/`). No server,
no iOS, no API/contract change.

## 1. Remove the in-chat "moved to another seat" line

The slim `↷ Moved to Work · Seat 2 (…)` / `Switched to …` line above the
composer goes away entirely.

- Delete `src/renderer/hooks/useSeatMoveNotice.ts`, the `SeatMoveNotice`
  component in `Cards.tsx`, its use in `ChatPanel.tsx`, and
  `src/renderer/SeatMoveNotice.test.tsx`.
- Delete the now-unused helpers in `chatUtils.ts`
  (`SEAT_MOVE_NOTICE_FRESH_MS`, `SEAT_MOVE_NOTICE_AUTOHIDE_MS`,
  `SeatMoveNoticeInput`, `formatSeatMoveNotice`, `seatMoveNoticeKey`, and
  `seatDisplayName` if nothing else uses it) and their tests.
- KEEP: the `accounts.moved` bus subscription in `App.tsx` (it refreshes the
  conversation's cached seat), the popover's "last move" line
  (`formatLastMove`), and the success/failure toast after pressing "Use" on a
  seat (`useSeatSwitch`).

## 2. Usage ring shows the combined usage of all seats (automatic mode only)

### When it applies
Only when the provider has a real seat choice (`hasSeatChoice(view)`, ≥2 seats)
AND `view.mode === "auto"`. Otherwise the ring is unchanged:
- manual mode → the active seat (as today);
- one seat / no seat info → the provider snapshot (as today).
If the combination yields nothing (no seat qualifies), fall back to today's
behaviour.

### The popover does not change
The popover keeps receiving exactly the snapshot it gets today (this
conversation's seat). Only the ring (pct, tone, visibility, pulse) and its
tooltip read the combined figure.

### Combination rule — new pure selector in `chatUtils.ts`
`combinedSeatWindows(view: ProviderView): { windows: UsageWindow[]; seatCount: number } | null`

1. **Included seats**: status `ok` or `unknown`, with at least one window.
   Signed-out / expired seats and seats with no reading are left out.
   `seatCount` = number of included seats. Null when 0.
2. **Weights by plan** (per account, applies to each of its seats):
   `Max 20x` → 20, `Max 5x` → 5, plain `Pro` → 1 (case-insensitive match on
   `AccountView.plan`, e.g. `"Team · Max 5x"` → 5). Anything else (null,
   `"Team"`, unknown) is *unknown*. If EVERY included seat has a known
   weight, use the weights; otherwise every seat weighs 1.
3. **Per window kind**, considering only active windows (`active !== false`):
   - kinds ordered by first appearance scanning included seats in view order,
     each seat's windows in their own order (keeps session before weekly);
   - only seats that report that kind take part in it;
   - a `stale` window (mid-reset) counts as 0%;
   - `pct` = weighted mean, rounded to an integer;
   - `resetsAt` = the earliest `resetsAt` among that kind's NON-stale windows
     (omit if none);
   - `stale: true` only when every participating window of that kind is
     stale;
   - `label` / `kind` from the first participating window; drop
     `used`/`limit`/`binding`/`startedAt`.
4. The ring then runs the existing `usageDialState` over
   `{ ...snapshot, windows: combined.windows }` — same 70% visibility rule
   (worst combined window), same primary-window value, same colour ladder.

### Tooltip (`title`) in combined mode
- Normal: `Claude · 40% of the 5h across 3 seats — next reset in 1h20m`
  (the reset clause uses `formatWindowReset` on the combined primary window's
  `resetsAt`, prefixed with "next "; omitted when there is none).
- All mid-reset: `Claude · the 5h quota is resetting on every seat`.
- The existing ` · this conversation will move to another seat soon` suffix
  (↷ badge) and ` · click for details` stay; the ↷ badge logic is unchanged
  (it stays per conversation).
- No seat name in the combined tooltip (the figure is not about one seat).

## Tests
- `chatUtils` unit tests for `combinedSeatWindows`: equal weights; plan
  weights (Pro + Max 20x); mixed known/unknown → equal; excluded statuses and
  empty seats; stale counts as 0 and earliest non-stale reset; all-stale →
  stale; a kind reported by only some seats; inactive windows ignored; null
  when nothing qualifies.
- `UsageDial` tests: auto mode uses the combined pct + tooltip; manual mode
  still uses the active seat; popover content unchanged.

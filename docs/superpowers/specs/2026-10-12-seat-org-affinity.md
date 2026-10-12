# Seat org affinity — design

Status: draft · Branch: `feat/seat-org-affinity` · Amends
`2026-10-08-multi-account-subscriptions-design.md` §5.3 (automatic mode, rules 1, 3 and 4).

## Problem

Seats of one org share a prompt cache, so moving a conversation between them is
free; moving it to another org re-sends the whole history. Two gaps make
cross-org moves more frequent than they need to be:

1. **Moves give up on the same org too early.** A move only treats a seat as
   "room" when it is under 70%. A same-org seat at 75% therefore loses to an
   other-org seat at 10% — a history re-send to avoid a free move. And a
   conversation at 95–99% with no seat under 70% stays put until it hits the
   wall, even when a same-org seat at 80% could take it for free.
2. **New conversations ignore where they could move later.** A new conversation
   takes the least-loaded seat anywhere. If that seat's org has no other seat
   with room (or is a single-seat org), the conversation's eventual move is
   guaranteed to cross orgs.

   Example: Org A seats at 10% and 90%; Org B seats at 30% and 30%. Today the
   new conversation goes to A·10%. When it fills, its only same-org sibling is
   at 90%, so it moves to B and re-sends its history. Starting on B·30% would
   have left a free move to B's other seat.

Usage limits are per seat (Team/Max), not per org, so "spreading across orgs"
is not a goal in itself; keeping a free same-org escape route is.

## Change 1 — moves prefer the same org before any cross-org seat

`decideMove` (src/server/seatAssignment.mjs) keeps its triggers (95% load, full,
unusable), the cross-org cap, and the 5 h no-move-back block. Only the target
tiers change. Within a tier the pick is `leastLoadedSeat` (ties → active seat),
as today.

| Trigger | Tiers, in order (first non-empty wins) | Else |
|---|---|---|
| **load** (95–99%) | 1. same org, known load **< 95** · 2. other org, known load **< 70** | stay |
| **full / unusable** | 1. same org, not full · 2. other org, known load < 70 · 3. other org, not full | (unusable only) today's dead-seat fallback |

- "< 95" on a soft move: a target that would itself trigger a move is
  pointless. It is `MOVE_AT_PCT`, not a new constant.
- Unknown-load seats (no reading) are never a soft-move target (unchanged);
  they remain eligible for hard moves (unchanged).
- Recently-left seats: excluded from every tier; for a hard move, if nothing
  qualifies, the same tiers are retried including them (unchanged mechanism).
- Cross-org cap: other-org tiers are skipped while capped, except for an
  unusable seat (unchanged).
- The dead-seat fallback (`why === "unusable"`, nothing found) keeps using plain
  least-loaded over all other usable seats — it must NOT pick up Change 2's
  placement rule.

Hysteresis is preserved: the no-move-back block still stops a conversation
returning to a seat it left, and a same-org target is below 95 so it never
re-triggers on arrival.

## Change 2 — new conversations prefer a seat with a same-org escape route

`chooseSeat` in **auto mode** (rule 1). Manual mode is unchanged.

A usable, not-full seat **has an escape route** when another usable seat of the
same org (`seatOrgKey`) has a known load under 70% (`MOVE_TARGET_BELOW_PCT`).

Tiers, first non-empty wins, `leastLoadedSeat` within (ties → active seat):

1. known load < 70 **and** has an escape route;
2. known load < 70;
3. every usable seat (today's behaviour, incl. unknown-load and full seats
   ranked last).

Consequences (each is a test):
- Org A {10, 90}, Org B {30, 30} → B·30 (A·10 has no escape route).
- Org A {10, 40}, Org B {30, 30} → A·10 (everyone has a route: plain least-loaded).
- Single-seat Org A {5}, Org B {60, 60} → B·60. Single-seat orgs fill after
  multi-seat orgs drop below the 70% line, then take new conversations via
  tier 2. Total capacity is still used; only the order changes.
- No seat under 70 → identical to today.

`nextSeatFor` (src/server/accountsViews.mjs) already calls `chooseSeat`, so the
"next seat" hint follows automatically. The renderer's `nextSeatHint` fallback
(`leastLoadedSeat`, used only when the server sends no `nextSeatId`) is left
as-is: it only matters for an older box.

Every caller of `chooseSeat` must pass seats carrying `accountId`/`orgId`.
`seatStates` and `accountsViews`' `chooserSeats` already do; verify any other
caller. A seat without them is its own org (`seatOrgKey` fallback), i.e. it
never has an escape route — acceptable degradation, not an error.

## Out of scope

- Org-level spend caps (Enterprise / extra usage). No signal for them today.
- Changing the 95 / 70 thresholds, the 5 h cap, or manual mode.
- Renderer changes.

## Docs to update

- `src/server/seatAssignment.mjs` header: rule 3 text to match the tiers above,
  and delete the stale "NOT here (phase 4): … same-org preference, the
  once-per-5h cross-org cap, move notices" line (all three are implemented).
- Parent spec §5.3: rule 1 gains the escape-route preference; rule 3/4 text
  matches Change 1.

## Tests (src/server/seatAssignment.test.mjs)

Intentionally reversed:
- "a same-org seat at 70+ is not 'room' for a 95% conversation, an under-70
  other-org seat is" → now the same-org seat (e.g. 75) wins.
- "with no seat under 70 a 95–99% conversation STAYS" → still stays when no
  same-org seat is under 95; add the case where a same-org seat at 80 takes it.

New:
- soft move: same-org at 94 is a target, same-org at 95 is not (falls to
  other-org < 70, else stays).
- hard move: same-org at 92 beats other-org at 10.
- cross-org cap still blocks the other-org tiers; unusable still exempt.
- dead-seat fallback unaffected by the escape-route rule.
- `chooseSeat` auto: the four consequences listed in Change 2; manual mode
  unchanged; unknown-load seats are never tier 1/2.
- service-level: a new conversation on the A{10,90}/B{30,30} box is assigned to
  B, and `nextSeatFor` reports the same seat.

Verification: `npm run typecheck && npm test`.

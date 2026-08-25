# Optimizer guardrail monitors (Axiom)

Optimizer P2.5 (BET-1347) — the three guardrails that constrain the tuner,
documented so a maintainer can watch them on the `manta` Axiom dataset. These
are documented, **not created**: there are currently zero monitors on the
`manta` dataset, and the run does not create them — a maintainer does.

The box enforces these guardrails server-side (a trip → the tuner reverts its
change immediately and writes a `rolled-back` activity entry naming which
guardrail). The monitors below are the *observability* equivalent: alert a
human when one of the same conditions looks like it's happening, so the tuner's
behaviour is auditable from outside the box.

## What the telemetry carries

The optimizer ships `channel == "ctx"` events to the `manta` dataset (via the
server's existing Axiom log shipper). Every such event carries `channel: "ctx"`
plus a `kind`, and **counts only** — never conversation content. Kinds:

| `kind` | fields | meaning |
|---|---|---|
| `mask` | `maskedTokens`, `maskedParts`, `applied`, `mode` | a masking pass (reported by the optimizer plugin) |
| `routing` | `switched`, `lambda`, `deficit`, `ecoLevel`, `routing` | a routing decision under pressure |
| `compaction` | `beforeTokens`, `background` | a background compaction |
| `tune` | `param`, `from`, `to`, `verdict` | a tuner step (`applied`/`kept`/`rolled-back`) |

The events carry `sessionID` (opaque) but never titles/paths/content.

## The three guardrails (server constants)

From `src/server/optimizer/tuner.mjs`:

- **Cache-hit drop** — the cache-hit rate fell more than
  `GUARD_CACHE_HIT_DROP_PTS` (**10** points) below its ~an-hour-earlier value,
  sustained `GUARD_SUSTAIN_MS` (**60 min**).
- **Re-fetch churn** — churn above `GUARD_CHURN_PCT` (**2%**) of masked parts
  (`countRefetchChurn`: a tool re-run whose earlier output we masked).
- **Effective cost per turn** — up more than `GUARD_COST_PER_TURN_WOW`
  (**20%**) week over week.

## Monitor 1 — re-fetch churn (the most actionable)

Churn is the honest measure of a trim that cost more than it saved. The tuner
computes it with `countRefetchChurn`; surfaces it to telemetry as a `churn`
field on `mask` events. Alert when rolling churn exceeds 2%.

```apl
['manta']
| where ['channel'] == "ctx" and ['kind'] == "mask"
| summarize churnPct = avg(['churn']) * 100 by bin_auto(['_time'])
| where ['churnPct'] > 2
```

**Threshold:** value > 2 (percent), window ≥ 1 hour (the sustain period).

> If the box build in the field predates the `churn` shipping on `mask` events,
> derive it server-side instead: the value is `guardrail.evidence.churn` on
> `rollback` (`tune` `verdict == "rolled-back"`) entries.

## Monitor 2 — cache-hit drop

Cache-hit rate is not pitched into Axiom per event (it is measured on the box).
The observability proxy is the box's own guardrail verdict: a sustained drop is
exactly what drives a `tune` `rollback`. Alert when the box rolled a change
back for `cache-hit`:

```apl
['manta']
| where ['channel'] == "ctx" and ['kind'] == "tune" and ['verdict'] == "rolled-back"
| extend which = extract("guardrail=([a-z-]+)", 1, tostring(['guardrail']))
| where ['which'] == "cache-hit"
| summarize count() by bin_auto(['_time'])
| where ['count_'] >= 1
```

**Threshold:** count ≥ 1 (any rollback for `cache-hit` is worth a human look).

## Monitor 3 — effective cost per turn, week over week

Weekly cost is aggregated from the box's ledger, not shipped per event. The
observability proxy is cost exploding alongside tuner activity — ship/report
`cost30d` and `turns30d` from the summary, then alert on the week-over-week
delta:

```apl
['manta']
| where ['channel'] == "ctx"
| summarize costPerTurn = max(['costPerTurn']) by bin(['_time'], 7d)
| where ['costPerTurn'] > 0
| sort ['_time'] asc
| extend prev = prev(['costPerTurn'])
| extend wow = (['costPerTurn'] - ['prev']) / ['prev']
| where ['wow'] > 0.2
```

**Threshold:** `wow` > 0.20 (20%).

## Steps to create each monitor in Axiom

1. Open **Axiom → Monitors → New Monitor**.
2. Name it, e.g. `optimizer-guardrail-cache-hit` / `-churn` / `-cost`.
3. Paste the query above into the query editor (dataset `manta`).
4. Set the condition + the threshold interval exactly as noted for the query
   (the sustain interval matters: a guardrail is "sustained", not a blip — use
   the 1-hour / 7-day window).
5. Pick a notify channel (email / Slack webhook) that routes to the maintainer
   who owns the box's tuner.
6. **Notify every time** the condition is true (not just once), matching the
   conservative "revert and tell me" semantics of the tuner.
7. Save + enable.

Because the underlying signals are **counts only**, these monitors never fire
on conversation content — a trip is always on shape/volume/verdict, never on
what a user said.

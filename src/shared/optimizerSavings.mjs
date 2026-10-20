// optimizerSavings.mjs — price OPTIMIZER trims honestly (sticky-trims §5.2).
//
// Pure. No node:* imports, no Date.now(), no I/O — everything arrives as an
// argument. Two functions:
//   reportUsd({ trimmed, rewarm, rates }) — ONE report's net dollars, priced
//     with the exact rates the plugin's gate used for that request.
//   summarizeSaved(entries) — a window's dollars: the SUM of the stored
//     per-report dollars, plus how much of the window was priced.
//
// History (BET-1370 → sticky trims): this module used to re-price a window at
// read time from a measured cache mix and a `promptSideRate`, which made a
// window's figure drift whenever a price changed and could not tell a re-cache
// that had paid back from one that had not. Pricing now happens ONCE, at
// ingest, per report, with the report's own rates (`reportUsd`); a window is
// then a plain sum (`summarizeSaved`). Nothing here re-prices, nothing imputes.
//
// A negative result is real and is returned, never clamped: a trim that
// re-cached more than it has yet saved is a cost, and reporting a gain on it is
// the failure this module engineers out.

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * PURE. One report's net dollars:
 *
 *     usd = trimmed × r − rewarm × (w − r)      ($/Mtok × tokens / 1e6)
 *
 * `trimmed` = net tokens removed from the request (each avoids being read at
 * cache-read rate `r`); `rewarm` = tokens that had to be re-written to cache at
 * `w` instead of read at `r` because the trim set changed. `rates` =
 * `{ cacheRead: r, cacheWrite: w }` in $/Mtok.
 *
 * Returns `null` when the rates are not usable (missing, non-finite, negative,
 * or cacheRead 0 — a free read has no saving to price) — the caller counts the
 * report as UNPRICED; unknown is never treated as free.
 */
export function reportUsd({ trimmed = 0, rewarm = 0, rates } = {}) {
  const r = rates?.cacheRead;
  const w = rates?.cacheWrite;
  if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return null;
  if (typeof w !== "number" || !Number.isFinite(w) || w < 0) return null;
  return (num(trimmed) * r - num(rewarm) * (w - r)) / 1e6;
}

/**
 * PURE. A window's savings from the stored per-model entries
 * (`{ trimmed, rewarm, usd, pricedReports, unpricedReports }`, any iterable of
 * them — a bucket half's `byModel` values, or merged across buckets).
 *
 * @returns {{ usd: number | null, basis: "measured"|"partial"|"unpriced",
 *             pricedShare: number, trimmed: number, rewarm: number }}
 *   usd         — Σ stored usd. NULL only when reports exist but NONE was
 *                 priced ("not priced"); 0 with basis "measured" when the
 *                 window holds no reports at all (nothing saved, nothing
 *                 unknown). May be negative.
 *   pricedShare — priced reports / all reports (REPORT-count weighted; 1 for
 *                 an empty window). Unpriced reports add tokens, never dollars.
 *   basis       — "measured" (all priced) | "partial" | "unpriced".
 *   trimmed / rewarm — token totals over the same entries.
 */
export function summarizeSaved(entries) {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  let trimmed = 0;
  let rewarm = 0;
  for (const e of entries ?? []) {
    if (!e || typeof e !== "object") continue;
    usd += typeof e.usd === "number" && Number.isFinite(e.usd) ? e.usd : 0;
    priced += num(e.pricedReports);
    unpriced += num(e.unpricedReports);
    trimmed += num(e.trimmed);
    rewarm += num(e.rewarm);
  }
  const total = priced + unpriced;
  if (total === 0) return { usd: 0, basis: "measured", pricedShare: 1, trimmed, rewarm };
  if (priced === 0) return { usd: null, basis: "unpriced", pricedShare: 0, trimmed, rewarm };
  const pricedShare = priced / total;
  return { usd, basis: pricedShare === 1 ? "measured" : "partial", pricedShare, trimmed, rewarm };
}

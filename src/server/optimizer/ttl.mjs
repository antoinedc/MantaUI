// optimizer/ttl.mjs — measure the EFFECTIVE Anthropic prompt-cache TTL from
// the message ledger, and VERIFY it against what opencode is configured to
// send (BET-1340; repurposes the reverted BET-1334 module, re-landed here).
//
// Background. opencode sends `cacheControl:{type:"ephemeral"}` with NO ttl
// unless Manta's `cacheTtl` setting writes `options.cacheControl
// {type:"ephemeral", ttl:"1h"}` into opencode's own config (shipped by
// #1339). Left alone — or set to "5m", which is expressed as the key being
// ABSENT — Anthropic applies its default 5-minute TTL. So:
//   • the CONFIGURED value is what opencode is asked to send ("5m"|"1h",
//     read back from opencode's config via providers.readCacheTtl);
//   • the MEASURED value is what the ledger shows actually happened across
//     real idle gaps.
//
// TWO roles, one pure core (`measureEffectiveTtl`):
//   • VERIFIER (primary) — compare the measured effective ms against the
//     configured ttl; a disagreement means config and reality have drifted
//     apart. Logged as one [optimizer] line + surfaced on the optimizer
//     summary's `ttl` field. Never user-facing in P1.
//   • OBSERVATION COLLECTOR (secondary) — the same pairwise ledger scan feeds
//     the phase-2 Optimizer's per-session TTL CHOICE (which sessions justify
//     writing ttl:"1h"). Pure + exported + tested here, but deliberately NOT
//     wired to that choice in P1.
//
// Pure. `rows` is the flat ledger shape from fetchLedgerRows (already
// assistant-message filtered). `now` is accepted for signature symmetry with
// the summary builder but does not drive the calculation — the algorithm is
// purely pairwise over the ledger.

export function measureEffectiveTtl(rows, now) {
  const list = Array.isArray(rows) ? rows : [];

  const bySession = new Map(); // sessionID -> rows[]
  for (const r of list) {
    const sid = r.sessionID ?? null;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(r);
  }

  const observations = [];
  for (const sessionRows of bySession.values()) {
    // For each consecutive pair, completion time defines "previous".
    const sorted = sessionRows
      .slice()
      .sort((a, b) => num(a.completedMs) - num(b.completedMs));

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const prevComplete = prev.completedMs;
      const curStart = cur.startedMs;
      if (typeof prevComplete !== "number" || typeof curStart !== "number") continue;

      const gapMs = curStart - prevComplete;
      // Only idle gaps in [1m, 4h] are meaningful cache-eviction windows: a
      // back-to-back turn isn't an eviction test, a multi-hour gap would
      // confound the warm/cold signal.
      if (gapMs < 60_000 || gapMs > 14_400_000) continue;

      const prevCtx = num(prev.input) + num(prev.cacheRead) + num(prev.cacheWrite);
      // A tiny previous prefix isn't worth measuring — the warm/cold signal is
      // noise at this size.
      if (prevCtx < 5000) continue;

      // "Warm" = the follow-up turn still had most of the previous prefix
      // served from cache (>= 50%).
      const warm = num(cur.cacheRead) >= 0.5 * prevCtx;
      observations.push({ gapMs, warm });
    }
  }

  const n = observations.length;
  if (n < 5) {
    return { ms: 300_000, confidence: "default", observations: n };
  }

  // If a warm pair survives a gap longer than 6.5 minutes, the cache lives
  // long enough that 1h is the honest prediction; otherwise it is 5m.
  let maxWarmGap = 0;
  for (const o of observations) {
    if (o.warm && o.gapMs > maxWarmGap) maxWarmGap = o.gapMs;
  }
  const ms = maxWarmGap > 390_000 ? 3_600_000 : 300_000;
  return { ms, confidence: "measured", observations: n };
}

// Configured TTL string ("5m" | "1h", as providers.readCacheTtl returns) →
// effective ms, or null for an unknown value (no Anthropic SDK targets, a
// config read failure, or a provider the setting doesn't apply to).
export function configuredTtlMs(configured) {
  if (configured === "1h") return 3_600_000;
  if (configured === "5m") return 300_000;
  return null;
}

// Millis → the human TTL label ("5m" | "1h") for a log line, falling back to
// a computed minutes suffix for any other value.
export function cacheTtlLabelMs(ms) {
  if (ms === 3_600_000) return "1h";
  if (ms === 300_000) return "5m";
  return `${Math.round((num(ms) || 0) / 60_000)}m`;
}

/**
 * PURE. Compare a `measureEffectiveTtl` result against the configured ttl.
 *
 * Returns null when there is nothing meaningful to compare — an inconclusive
 * measurement (< 5 observations → confidence "default"), or an unknown/absent
 * configured ttl. Returning null (not a mismatch) is what keeps the verifier
 * quiet: a "default" verdict is a statement that the box has no signal yet,
 * not evidence of drift, so it must not log.
 *
 * Otherwise returns `{ measuredMs, configuredMs, matched }`.
 */
export function verifyCacheTtl(measured, configured) {
  if (!measured || measured.confidence !== "measured") return null;
  const configuredMs = configuredTtlMs(configured);
  if (configuredMs == null) return null;
  return { measuredMs: measured.ms, configuredMs, matched: measured.ms === configuredMs };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

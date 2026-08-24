// optimizer/ttl.mjs — measure the EFFECTIVE Anthropic prompt-cache TTL from
// the message ledger (BET-1334, Optimizer P1.2). The cache used to be predicted
// from a user-facing `cacheTtl` setting that asked them to guess another
// program's internals — and guessed wrong (opencode sends
// `cacheControl:{type:"ephemeral"}` with NO ttl, so Anthropic's 5-minute
// default applies). That setting was removed in this issue; this module
// replaces the guess by measuring whether a warm, cache-backed assistant turn
// still finds its prefix cached after a real idle gap, across real sessions.
//
// Pure. `rows` is the flat ledger shape from fetchLedgerRows (already
// assistant-message filtered). `now` is accepted for signature symmetry with
// the summary builder but does not drive the calculation.

export function measureEffectiveTtl(rows, now) {
  const list = Array.isArray(rows) ? rows : [];

  const bySession = new Map();
  for (const r of list) {
    const sid = r.sessionID ?? null;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(r);
  }

  const observations = [];
  for (const sessionRows of bySession.values()) {
    // For each consecutive pair, the previous message is defined by completion.
    const sorted = sessionRows
      .slice()
      .sort((a, b) => num(a.completedMs) - num(b.completedMs));

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (typeof prev.completedMs !== "number" || typeof cur.startedMs !== "number") continue;

      const gapMs = cur.startedMs - prev.completedMs;
      // Only idle gaps in [1m, 4h] are meaningful cache-eviction windows.
      if (gapMs < 60_000 || gapMs > 14_400_000) continue;

      const prevCtx = num(prev.input) + num(prev.cacheRead) + num(prev.cacheWrite);
      if (prevCtx < 5000) continue; // tiny prefixes make the signal noise

      // "Warm" = the follow-up kept >= 50% of the previous prefix in cache.
      observations.push({ gapMs, warm: num(cur.cacheRead) >= 0.5 * prevCtx });
    }
  }

  const n = observations.length;
  if (n < 5) return { ms: 300_000, confidence: "default", observations: n };

  // A warm pair surviving a >6.5-min gap means the cache outlives 5m → 1h.
  let maxWarmGap = 0;
  for (const o of observations) if (o.warm && o.gapMs > maxWarmGap) maxWarmGap = o.gapMs;
  return {
    ms: maxWarmGap > 390_000 ? 3_600_000 : 300_000,
    confidence: "measured",
    observations: n,
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

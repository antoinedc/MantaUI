// optimizer/ttl.mjs — measure the EFFECTIVE Anthropic prompt-cache TTL from
// the message ledger (BET-1334, Optimizer P1.2).
//
// The prompt cache used to be predicted from a user-facing `cacheTtl` setting
// that asked them to guess another program's internals — and guessed wrong:
// opencode sends `cacheControl:{type:"ephemeral"}` with NO ttl, so Anthropic's
// 5-minute default applies. The setting was deleted in this issue; this module
// replaces the guess by measuring whether a warm (cache-backed) assistant turn
// still finds its prefix cached after a real idle gap, across real sessions.
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

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

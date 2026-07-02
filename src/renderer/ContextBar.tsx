// ===== Context bar =====
//
// Extracted from ChatPanel.tsx (M0.5). Chunky horizontal usage bar with a
// dotted "empty" pattern and a SEGMENTED filled portion: fresh-input (paid full
// rate) | cache.write (warm-up, paid full rate + 25% surcharge) | cache.read
// (cached, paid ~10%). Color of the fresh segment stages by total usage
// (green → yellow → orange → red); cache.write uses a steady amber; cache.read
// uses a steady muted teal.
//
// When the session has gone stale (idle past the Anthropic cache TTL the user
// configured in Settings, AND the cached prefix is non-trivial), an amber
// `⚠ /clear to save Nk tokens` pill renders to the right of the %.

import { ctxStageColor, type ContextBreakdown, type StaleCacheResult } from "./chatUtils";

// Cache-segment colors — tuned to read as distinct buckets without
// competing with the stage color of the fresh segment.
const CACHE_WRITE_COLOR = "#f59e0b"; // amber-500: warm-up, expensive
const CACHE_READ_COLOR = "#0ea5a4"; // teal-600: cached, cheap

// Format a token count compactly for the inline stale-cache pill
// ("12k", "120k", "1.2M"). Differs from `formatTokens` (which appends
// "tokens" and never reaches M-scale) because pill space is tight and
// we want a millions suffix once a session crosses 1M (Opus 4.7's full
// window).
function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function formatIdleDuration(ms: number): string {
  // Coarse human format for the tooltip — exact precision doesn't help.
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

export function ContextBar({
  breakdown,
  limit,
  staleCache,
  modelName,
  tooltip,
}: {
  breakdown: ContextBreakdown;
  limit: number;
  staleCache: StaleCacheResult;
  modelName: string | null;
  tooltip?: string;
}) {
  const { pct, segments, freshInput, cacheRead, cacheWrite, totalInput } =
    breakdown;
  // Stage color is driven by total usage (so the % digits + fresh slice
  // share the same warning hue).
  const fill = ctxStageColor(pct);
  const dot = `${fill}55`;
  const segColor = (kind: ContextBreakdown["segments"][number]["kind"]) => {
    if (kind === "fresh") return fill;
    if (kind === "cacheWrite") return CACHE_WRITE_COLOR;
    return CACHE_READ_COLOR;
  };
  // Multi-line tooltip showing the full breakdown. Caller appends any
  // contextual hints (compact recommended, model name, etc.).
  const breakdownLines = [
    `${totalInput.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`,
    modelName ? `Model window: ${modelName}` : null,
    cacheRead > 0
      ? `  · ${cacheRead.toLocaleString()} cache read (cheap, served from cache)`
      : null,
    cacheWrite > 0
      ? `  · ${cacheWrite.toLocaleString()} cache write (warm-up — paid full rate + surcharge this turn)`
      : null,
    freshInput > 0
      ? `  · ${freshInput.toLocaleString()} fresh input (uncached, paid full rate)`
      : null,
    tooltip ?? null,
  ].filter(Boolean);
  return (
    <span
      className="flex items-center gap-1.5 shrink-0"
      title={breakdownLines.join("\n")}
    >
      <span
        // Keep the `w-24` class — mobile.css selects on it to hide the
        // track on phones. Don't rename the width without updating that
        // CSS rule.
        className="inline-block w-24 h-3 rounded-[2px] overflow-hidden align-middle"
        style={{
          backgroundColor: "#1b1e25",
          backgroundImage: `radial-gradient(circle, ${dot} 1.2px, transparent 1.4px)`,
          backgroundSize: "4px 4px",
        }}
      >
        {/* Render segments inline; each takes its share of the WHOLE track
            (not of the filled portion), so widths sum to `pct` and the
            empty remainder is the dotted pattern beneath. */}
        {segments.map((s, i) =>
          s.pct > 0 ? (
            <span
              key={s.kind}
              className="inline-block h-full align-top"
              style={{
                width: `${s.pct}%`,
                backgroundColor: segColor(s.kind),
                // Subtle inset between segments so adjacent slices read as
                // distinct buckets even when their colors are close.
                boxShadow:
                  i > 0 ? "inset 1px 0 0 rgba(0,0,0,0.35)" : undefined,
              }}
            />
          ) : null,
        )}
      </span>
      <span
        className="tabular-nums text-[12px] font-semibold"
        style={{ color: fill }}
      >
        {pct}%
      </span>
      {staleCache.isStale && (
        // Visible stale-cache pill — only appears when the session has
        // been idle past the configured Anthropic cache TTL (5m or 1h,
        // see Settings) AND the cached prefix is non-trivial. The next
        // user message will pay full rate + surcharge to re-warm exactly
        // these tokens; /clear avoids the bill entirely.
        <span
          className="tabular-nums text-[11px] font-medium px-1.5 rounded-sm shrink-0"
          style={{
            color: CACHE_WRITE_COLOR,
            backgroundColor: `${CACHE_WRITE_COLOR}1f`,
          }}
          title={[
            `Session idle for ${formatIdleDuration(staleCache.idleMs)} — prompt cache has expired.`,
            `${staleCache.staleTokens.toLocaleString()} tokens currently in cache will be re-billed as cache_creation_input_tokens on your next message (full input rate + 25% surcharge, or 2× for 1h cache).`,
            "",
            "Actions:",
            "  · /clear  — start a fresh session, skip the re-warm cost entirely",
            "  · /compact — shrink the prefix before re-warming",
            "",
            "(Cache TTL is set by opencode; bui predicts staleness from the Settings → Prompt cache TTL value. If this fires at the wrong time, that setting probably doesn't match opencode's cache_control.ttl.)",
          ].join("\n")}
        >
          ⚠ /clear to save {formatTokensCompact(staleCache.staleTokens)} tokens
        </span>
      )}
    </span>
  );
}

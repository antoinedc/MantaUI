type Props = {
  ttl: "5m" | "1h";
  setTtl: (v: "5m" | "1h") => void;
  // Mobile (compact) uses px-3 and no hover; desktop uses px-4 + hover:text-text
  // on the unselected state, and labels the 1h option "1 hour (default)".
  compact?: boolean;
};

/**
 * Prompt-cache TTL segmented toggle — shared by desktop Settings and mobile
 * MobileSettings. Extracted (BET-409) to clear the duplication gate: both
 * surfaces rendered the same two-button pair with the same selected/unselected
 * class conditional, diverging only in padding, hover, and the hour label.
 */
export function TtlToggle({ ttl, setTtl, compact = false }: Props) {
  const pad = compact ? "px-3" : "px-4";
  const hover = compact ? "" : "hover:text-text";
  const hourLabel = compact ? "1 hour" : "1 hour (default)";
  const selected = "bg-accent-solid text-on-accent border-accent";
  const unselected = `bg-bg-soft text-text-muted border-border ${hover}`;
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => setTtl("5m")}
        className={`flex-1 ${pad} py-2 text-sm rounded border ${
          ttl === "5m" ? selected : unselected
        }`}
      >
        5 minutes
      </button>
      <button
        type="button"
        onClick={() => setTtl("1h")}
        className={`flex-1 ${pad} py-2 text-sm rounded border ${
          ttl === "1h" ? selected : unselected
        }`}
      >
        {hourLabel}
      </button>
    </div>
  );
}

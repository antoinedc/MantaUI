// M527.StatusDot — the status-dot chrome primitive (BET-636).
//
// A real 6px circle used for live status — the tool-call header (`.tool-h .g`)
// and the subagent/task card's status line. The spec's running tone animates
// with a bespoke 1.4s keyframe; this primitive deliberately uses Tailwind's
// `animate-pulse` (1s ease-in-out) instead. The cadence divergence is recorded
// in `docs/screens/session/conformance.md` rather than adding a keyframe
// (BET-636). No `className` escape hatch (epic standing decision 3).
//
// Chrome contract: `w-[6px] h-[6px] rounded-full shrink-0` plus a per-tone
// background — `bg-ok` (ok), `bg-accent animate-pulse` (running), `bg-danger`
// (error), `bg-warn` (warn), `bg-text-quiet` (idle), `bg-accent` (accent — a
// STATIC accent dot with no pulse: the routines "Findings" outcome pill).

export function StatusDot({
  tone,
}: {
  /** The dot's semantic state — drives the background (and pulse when running). */
  tone: "ok" | "running" | "error" | "warn" | "idle" | "accent";
}) {
  const toneCls =
    tone === "running"
      ? "bg-accent animate-pulse"
      : tone === "error"
        ? "bg-danger"
        : tone === "warn"
          ? "bg-warn"
          : tone === "ok"
            ? "bg-ok"
            : tone === "accent"
              ? "bg-accent"
              : "bg-text-quiet";
  return <span className={`w-[6px] h-[6px] rounded-full shrink-0 ${toneCls}`} />;
}

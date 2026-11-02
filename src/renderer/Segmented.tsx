// Segmented — a two-or-more-option toggle (contract §P1,
// docs/screens/explorer/contract.md). Lifted verbatim from the Artifacts
// panel's Artifacts | Review mode switch; adopters: ArtifactsPanel (mode
// switch, `fill`) and the explorer's Markdown Rendered | Source toggle.
// No `className` escape hatch (docs/components.md standing decision 3).

export type SegmentedOption<T extends string> = { id: T; label: string };

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  fill = false,
  hook,
}: {
  /** Accessible name of the group (required). */
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (id: T) => void;
  /** Stretch to the container width with equal segments. */
  fill?: boolean;
  hook?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`${hook ? `${hook} ` : ""}flex shrink-0 p-1 bg-inset border border-border-subtle rounded-md${fill ? " w-full" : ""}`}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={
              "relative z-10 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-sm text-meta font-medium " +
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
              (fill ? "flex-1 " : "") +
              (on ? "bg-raised shadow-sm text-text" : "text-text-faint hover:text-text")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

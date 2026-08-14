// ProgressBar — the shared DETERMINATE progress primitive (BET-796 [S7]).
//
// The mockup's `.bar` (manta-forge §8.2): a 5px `rounded-full` track
// (`bg-fill-active`) with a `bg-accent-solid` fill. Determinate — driven by a
// real `percent` (0..100) — because it is the ONE place in the design a
// determinate bar is correct: git clone reports real byte counts against a
// known total (§4.3). The existing `UpdateBar` sweep is indeterminate and is
// NOT this. `percent` is clamped to 0..100; the fill uses the live width (not
// a transition) so the bar tracks every poll tick.

export function ProgressBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return (
    <div
      role="progressbar"
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-[5px] rounded-full bg-fill-active overflow-hidden"
    >
      <div
        className="h-full rounded-full bg-accent-solid"
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

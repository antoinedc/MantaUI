// Skeleton — the shared loading-bar primitive (BET-787 [S1]).
//
// The mockup's `.sk` (manta-forge §8.2): a `rounded-full bg-fill-active` bar
// whose only variation is its width. Uneven widths are the whole point — a
// loading gif of three identical bars reads as a spinner; uneven ones read as
// content. Callers pass an explicit `width` (percent) and compose their own
// spacing, so a row of skeletons looks like real rows rather than a loading
// indicator.

export function Skeleton({ width }: { width: number }) {
  return (
    <span
      aria-hidden="true"
      className="block h-[9px] rounded-full bg-fill-active"
      style={{ width: `${width}%` }}
    />
  );
}

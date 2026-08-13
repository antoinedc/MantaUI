// MantaLoader — the app's ONE waiting image, on desktop.
//
// The mark inside two counter-rotating arcs: the outer sweeping clockwise, the
// inner anticlockwise, softer and slower. It is not a new design — it was the
// web client's ConnectingScreen (retired with the PWA in BET-559) and the iOS
// client carries it today as `MantaLoader.swift`, which is what you see when a
// session opens on the phone. The desktop was the only client still showing a
// generic grey ring.
//
// Reusing one image is the point, and the native file states why: a session
// load, a connect and any future wait then "all look like the same thing rather
// than three different grey placeholders". A turn in flight is that same thing,
// so the running row uses it too — at a smaller size, same geometry.
//
// Chrome contract (ported verbatim from MantaLoader.swift so the two clients
// show one image):
//   - outer arc = 28% of the circle, `--accent`, 0.9s linear clockwise;
//   - inner arc = 22% of the circle at 40% opacity, 1.4s linear anticlockwise,
//     on a circle 78% of the outer diameter;
//   - the mark at 50% of the outer diameter — the SHIPPED asset, never a
//     redrawn path (a hand-rolled path is a second, drifting copy of the brand).
// The counter-rotation and the mismatched periods are what stop the pair
// reading as one spinning circle.
//
// Drawn as SVG arcs with round caps rather than the retired web version's
// one-sided CSS border: a border gives a hard-ended quarter arc that does not
// match the native's 28%/22% trim with its round line caps, and it does not
// scale without re-tuning.
//
// SIZE IS A VARIANT, NOT A NUMBER, and there is NO `className` escape hatch
// (M527 standing decision 3) — a caller cannot shear the geometry, the speeds
// or the stroke.
//
// The stroke does NOT scale with the size, and that is deliberate. At 92px the
// arcs are 3px, ~3% of the diameter; holding that ratio at 24px gives a 0.8px
// hairline that disappears against the transcript. Below `screen` the stroke
// is pinned at 2px, so the small form is proportionally heavier. That is the
// correct optical adjustment, not drift.
//
// Motion lives in `src/renderer/index.css` (`.manta-loader-ring-*`) so
// `prefers-reduced-motion` can hold the arcs still in ONE place. Nothing is
// encoded in the rotation: the running row's elapsed counter keeps ticking, so
// a user who never sees the animation loses no information.

import mantaMark from "./assets/manta-mark-128.png";

type LoaderSize = "inline" | "screen";

// Outer diameter per size. `inline` sits in the running row next to 13px text;
// `screen` is the full waiting state (session connect), matching the native's
// 92px. 24px was chosen over 30px by the owner.
const DIAMETER: Record<LoaderSize, number> = { inline: 24, screen: 92 };
// Arc weight. Pinned at 2px below `screen` — see the header note.
const STROKE: Record<LoaderSize, number> = { inline: 2, screen: 3 };

const OUTER_ARC = 0.28; // fraction of the circumference
const INNER_ARC = 0.22;
const INNER_RATIO = 0.78; // inner diameter as a fraction of the outer
const MARK_RATIO = 0.5;

export function MantaLoader({
  size = "inline",
  label,
}: {
  /** Which of the two forms to draw. `inline` is the running row. */
  size?: LoaderSize;
  /**
   * Accessible name for the whole loader (e.g. "Connecting to session").
   * The arcs and the mark are decorative; this is what a screen reader gets.
   * Omit when the surrounding row already names the state in visible text.
   */
  label?: string;
}) {
  const d = DIAMETER[size];
  const sw = STROKE[size];
  const c = d / 2;
  const rOuter = (d - sw) / 2;
  const rInner = rOuter * INNER_RATIO;
  const circOuter = 2 * Math.PI * rOuter;
  const circInner = 2 * Math.PI * rInner;
  const mark = Math.round(d * MARK_RATIO);

  return (
    <span
      className="manta-loader relative grid place-items-center shrink-0"
      style={{ width: d, height: d }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg
        className="absolute inset-0"
        width={d}
        height={d}
        viewBox={`0 0 ${d} ${d}`}
        aria-hidden="true"
      >
        <circle
          className="manta-loader-ring-out"
          cx={c}
          cy={c}
          r={rOuter}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={`${circOuter * OUTER_ARC} ${circOuter * (1 - OUTER_ARC)}`}
        />
        <circle
          className="manta-loader-ring-in"
          cx={c}
          cy={c}
          r={rInner}
          fill="none"
          stroke="var(--accent)"
          strokeOpacity={0.4}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={`${circInner * INNER_ARC} ${circInner * (1 - INNER_ARC)}`}
        />
      </svg>
      <img src={mantaMark} width={mark} height={mark} alt="" className="block" />
    </span>
  );
}

// The same mark, held still, with no arcs. The arcs mean "in flight"; when a
// turn ends the row keeps the mark and drops them, so the eye tracks ONE
// object through the whole turn instead of two appearing and vanishing.
export function MantaMark({ size = 12 }: { size?: number }) {
  return (
    <img
      src={mantaMark}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      // Baseline nudge in em, not px: the mark sits inline with text, so the
      // correction has to scale with the type it sits next to rather than be
      // re-tuned per call site.
      className="inline-block shrink-0 align-[-0.12em]"
    />
  );
}

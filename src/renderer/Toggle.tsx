// M527.Toggle — the on/off switch chrome primitive (BET-614, stage 3).
//
// Owns the ONE shared chrome for a boolean switch with NO `className` escape
// hatch (epic standing decision 3): a 36px×20px track (rounded-full) that
// slides a 14px knob left/right, an accent fill when on, and an accent focus
// ring. A caller cannot shear the track, the knob travel or the ring, so the
// switch family can only drift if Toggle itself is retuned.
//
// A real `<button role="switch">` is kept for accessibility and keyboard
// support; the native `aria-checked` mirrors the `checked` prop and the knob
// position + track fill are driven from it. Disabled is passed through to the
// native button (the switch itself carries no disabled chrome of its own).
//
// Toggle ≠ Checkbox: a checkbox is for multi-select in a form; a switch is
// for a single live on/off setting (the two controls are both specced). This
// primitive exists for the boolean setting rows; it must NOT be swapped in at
// `Checkbox` call sites.

const TRACK =
  "relative shrink-0 w-9 h-5 rounded-full border transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const TRACK_OFF = "bg-fill-active border-border";
const TRACK_ON = "bg-accent-solid border-accent-solid";
const KNOB = "absolute top-[2px] w-3.5 h-3.5 rounded-full transition-all";
const KNOB_OFF = "left-[2px] bg-text-faint";
const KNOB_ON = "left-[18px] bg-on-accent";

export function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
  id,
}: {
  /** The switch state; `aria-checked` mirrors it exactly. */
  checked: boolean;
  /** Fired with the next state (`!checked`) when the switch is toggled. */
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name; required (the track has no visible text label). */
  ariaLabel: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`${TRACK} ${checked ? TRACK_ON : TRACK_OFF}`}
    >
      <span
        aria-hidden="true"
        className={`${KNOB} ${checked ? KNOB_ON : KNOB_OFF}`}
      />
    </button>
  );
}

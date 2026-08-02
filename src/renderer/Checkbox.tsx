// M527.Checkbox — the boxed-checkbox chrome primitive (BET-589, stage 3 of 4).
//
// Owns the ONE shared chrome for a boxed checkbox with NO `className` escape
// hatch (epic standing decision 3): a 16px box, `--border-strong` border,
// `--r-xs` radius, canvas fill, `--accent-solid` fill with a `--on-accent`
// check glyph when checked, and an accent focus ring. A caller cannot shear
// the box, its fill or its ring, so the checkbox family can only drift if
// Checkbox itself is retuned.
//
// A real `<input type="checkbox">` is kept for accessibility and keyboard
// support (visually hidden with `sr-only`). The focus ring is the only chrome
// that uses `peer` — a class on the input that styles the preceding-sibling
// box — the checked fill and glyph are driven from the `checked` prop so the
// glyph stays out of the DOM when unchecked.

import { Check } from "lucide-react";

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  id,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Text rendered after the box, inside this primitive's label. */
  label?: string;
  id?: string;
  /** Accessible name for the input; required when `label` is omitted and the call site supplies its own text. */
  ariaLabel?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={
        "inline-flex items-center gap-2 " +
        (disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")
      }
    >
      <input
        id={id}
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span
        aria-hidden="true"
        className={
          "w-4 h-4 rounded-xs border border-border-strong bg-bg inline-grid place-items-center " +
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent " +
          (checked ? "bg-accent-solid text-on-accent" : "")
        }
      >
        {checked && <Check size={12} />}
      </span>
      {label !== undefined && <span>{label}</span>}
    </label>
  );
}

// M527.Field — the labelled input chrome primitive (BET-533, stage 4).
//
// Owns the ONE shared chrome for a text input (and its micro-caps label +
// help text) with NO `className` escape hatch (epic standing decision 3): a
// caller cannot shear the surface / edge / radius / padding, so the field
// family can only drift if Field itself is retuned.
//
// Chrome contract (BET-529 inventory, settled in this cell):
//   - surface `--card` (`bg-bg-soft`), edge `--border-strong`
//     (`border-border-strong` — inputs/controls take border-strong, NOT
//     `--border`), focus `--accent`, radius `--r-md` 8px (`rounded-lg`).
//   - padding sp-3 / sp-4 → **12px vertical / 16px horizontal** (`py-3 px-4`).
//     Settles the spec's Applied-spec "12px / 14px" (off-grid, misnamed):
//     `sp-3` is the vertical step (12px), `sp-4` the horizontal (16px), same
//     orientation as Card (BET-531).
//   - value `font-mono` for path/code (default); `mono={false}` for prose text.
//   - label micro-caps `--tx2` (`text-text-muted`), help `--tx3`
//     (`text-text-faint`).
//
// A leading icon slot (`leading`) is a chrome slot, not an escape hatch: it
// adds the leading inset the icon needs (`pl-8`) so search/URL fields keep
// their icon without a caller injecting classes.
//
// C1 (validated constraints): the input sets a surface that differs from the
// page, so it also sets an explicit foreground token (`text-text`). The label
// and help intentionally inherit/set `--tx2`/`--tx3` text colours to read at
// micro/meta size.
//
// Adopters migrated in BET-533: `SettingField` (Settings.tsx) + the inline
// registry-URL and settings-search inputs.

import type { ReactNode, Ref } from "react";

type FieldProps = {
  /** Native input id; required when a visible `label` is present (label htmlFor). */
  id?: string;
  /** Visible micro-caps label. When absent, `ariaLabel` names the input. */
  label?: string;
  /** Accessible name for the input when there is no visible label. */
  ariaLabel?: string;
  type?: "text" | "password";
  value: string;
  placeholder?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Help text rendered under the input (`--tx3`). */
  help?: ReactNode;
  /** Anything rendered after `help` (e.g. a persistent inline status). */
  footer?: ReactNode;
  autoComplete?: string;
  /** Path/code values render mono (default true). Pass false for prose. */
  mono?: boolean;
  /** An icon rendered flush to the left of the value; adds the leading inset. */
  leading?: ReactNode;
  /** A ref to the native input (e.g. to focus/select it on mount). */
  inputRef?: Ref<HTMLInputElement>;
};

const INPUT_BASE = "w-full bg-bg-soft border border-border-strong rounded-lg text-body text-text focus:outline-none focus:border-accent";
const LABEL_CLS = "block text-micro font-semibold uppercase text-text-muted";
const META_CLS = "text-meta text-text-faint";

export function Field({
  id,
  label,
  ariaLabel,
  type = "text",
  value,
  placeholder,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  help,
  footer,
  autoComplete,
  mono = true,
  leading,
  inputRef,
}: FieldProps) {
  // sp-3 / sp-4 = 12px vertical / 16px horizontal. A leading icon replaces the
  // left inset with the 8-rem-leading gutter the icon needs (pl-8).
  const inset = leading ? "pl-8 pr-4 py-3" : "px-4 py-3";
  const fontCls = mono ? "font-mono" : "";
  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={id} className={LABEL_CLS}>
          {label}
        </label>
      )}
      <div className="relative">
        {leading && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint">
            {leading}
          </span>
        )}
        <input
          id={id}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          aria-label={ariaLabel}
          ref={inputRef}
          autoComplete={autoComplete}
          spellCheck={false}
          className={`${INPUT_BASE} ${inset} ${fontCls}`}
        />
      </div>
      {help && <div className={META_CLS}>{help}</div>}
      {footer}
    </div>
  );
}

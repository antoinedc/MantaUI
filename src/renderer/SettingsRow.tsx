// M527.SettingsRow — the settings-row chrome primitive (BET-614, stage 5).
//
// Owns the ONE shared chrome for a settings row: a name (label) plus optional
// help text on the left, and a caller-supplied control on the right, separated
// by a row divider. NO `className` escape hatch (epic standing decision 3). A
// caller cannot shear the flex row layout, the label/help block, the trailing
// divider or the right-aligned control slot.
//
// The control (`children`) is the caller's job — e.g. a `Toggle`, a segmented
// control, or an `input`. The primitive owns the row chrome and the `gap-2`
// inside the control slot.
//
// NOTE (BET-619): this stage's premise — that the private `SettingField` in
// Settings.tsx already implements `.setrow` and only needs extracting — does
// not hold on the current code. The actual `SettingField` is a `Field`-based
// text/password input (entry/value/onCommit/credential), not a row with
// name/help/children. Neither named adopter (Settings.tsx, ProvidersCard.tsx)
// contains a genuine `.setrow` row, so this stage ships the owner-approved
// primitive registered under the enforce net and reports the adopters (see the
// SKIP_REASON in primitives.test.ts + the conformance record) rather than
// force-converting an unrelated element.
//
// Accepted divergence (BET-614 stage 5): the spec's name line-height is 1.4;
// `text-body` is 14px/1.5. We use `text-body` and do not invent an arbitrary
// line-height — the 0.1 delta is recorded under "Accepted divergences" in
// docs/screens/settings/conformance.md. Its off-grid px are the 2px control
// top-padding and the 3px help top-margin (plus the 12.5px help text, whose
// decimal tail reads as 5px).

import type { ReactNode } from "react";

const ROW =
  "flex items-start gap-5 py-3 border-b border-border-subtle last:border-b-0";
const LAB = "flex-1 min-w-0";
const NAME = "block text-body font-medium text-text";
const HELP = "block text-[12.5px] leading-[1.5] text-text-faint mt-[3px]";
const CTL = "shrink-0 flex items-center gap-2 pt-[2px]";

export function SettingsRow({
  name,
  help,
  children,
}: {
  /** The setting's name — the bold label on the left of the row. */
  name: ReactNode;
  /** Optional help text shown below the name. */
  help?: ReactNode;
  /** The control — e.g. a Toggle, a segmented control, or an input. */
  children: ReactNode;
}) {
  return (
    <div className={ROW}>
      <span className={LAB}>
        <span className={NAME}>{name}</span>
        {help != null && <span className={HELP}>{help}</span>}
      </span>
      <span className={CTL}>{children}</span>
    </div>
  );
}

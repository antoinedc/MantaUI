import type { ChangeEvent } from "react";
import { normalizeVerifyCode } from "./mobile/pairPayload";

type Props = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * Shared four-character two-sided-confirm input (BET-514 §5.3 "K7 Q2").
 *
 * Single source of the 4-char normalization (uppercase, whitespace-stripped,
 * clamped to 4) and the input element, so the desktop Connect (PairStep) and
 * the mobile manual setup (SetupScreen) both consume ONE implementation
 * instead of each duplicating the input + normalization block. The label /
 * surrounding wrapper stays per-screen (different markup), but the field
 * logic lives here.
 *
 * Optional — an empty value keeps the legacy first-pair claim path.
 */
export function VerifyCodeInput({
  value,
  onChange,
  disabled,
  id,
  className,
}: Props) {
  return (
    <input
      id={id}
      type="text"
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      placeholder="K7Q2"
      maxLength={4}
      disabled={disabled}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) =>
        onChange(normalizeVerifyCode(e.target.value).slice(0, 4))
      }
      className={className}
    />
  );
}

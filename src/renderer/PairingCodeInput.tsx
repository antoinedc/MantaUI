import { forwardRef } from "react";
import { normalizeCode } from "../shared/claim.mjs";

type Props = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  id?: string;
  className?: string;
};

/**
 * Shared six-digit pairing-code input.
 *
 * Single source of the 6-digit normalization (strip non-digits, clamp to 6)
 * and the input element for the pairing-code field, so the desktop Connect
 * (PairStep) and the mobile manual setup (SetupScreen) both consume ONE
 * implementation instead of each duplicating the input + normalization block.
 * Focus (`ref`) is forwarded so callers can re-focus after a failed claim.
 */
export const PairingCodeInput = forwardRef<HTMLInputElement, Props>(
  function PairingCodeInput(
    { value, onChange, disabled, hasError, id, className },
    ref,
  ) {
    return (
      <input
        ref={ref}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Pairing code"
        aria-invalid={hasError}
        placeholder="000000"
        maxLength={6}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(normalizeCode(e.target.value))}
        className={className}
      />
    );
  },
);

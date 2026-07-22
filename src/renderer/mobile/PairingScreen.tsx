import { useReducer, useRef } from "react";
import {
  pairingReducer,
  initialPairingState,
  canSubmit,
} from "./pairingLogic";
import { submitPairingCode } from "../api/httpApi";

type Props = {
  // Called after a successful claim (token already persisted by
  // submitPairingCode). MobileApp re-runs its bootstrap refresh so the session
  // list loads with the now-valid Bearer credential.
  onPaired: () => void;
};

/**
 * Full-screen pairing gate for the mobile/web client. Shown by MobileApp when
 * manta-server reports auth-required (httpApi throws AuthRequiredError on 401) —
 * both on a fresh, never-paired browser AND on the re-pair path (a previously
 * stored token was revoked/rotated, so the box now 401s again).
 *
 * The user mints a 6-digit code on the box (`manta pair`, local-only) and types
 * it here; we POST /auth/claim, persist the returned box_token on success, and
 * hand control back to MobileApp. All non-UI logic (input contract, HTTP-outcome
 * classification, form state machine) lives in pairingLogic.ts + httpApi's
 * submitPairingCode and is unit-tested there.
 */
export function PairingScreen({ onPaired }: Props) {
  const [state, dispatch] = useReducer(pairingReducer, initialPairingState);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    // Guard mirrors canSubmit so an Enter keypress can't fire a request from a
    // non-submittable state (the reducer also no-ops, but avoid the round-trip).
    if (!canSubmit(state)) return;
    dispatch({ type: "submit" });
    const result = await submitPairingCode(state.code);
    if (result.ok) {
      dispatch({ type: "success" });
      onPaired();
    } else {
      dispatch({ type: "fail", result });
      // Re-focus so the user can immediately correct the code.
      inputRef.current?.focus();
    }
  };

  const onSubmitForm = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const submitting = state.status === "submitting";
  const disabled = !canSubmit(state);

  return (
    <div className="mobile">
      <div className="h-full flex flex-col items-center justify-center gap-6 px-8 text-center">
        <div className="flex flex-col gap-2">
          <div className="text-text text-lg font-medium">Connect to your server</div>
          <div className="text-text-muted text-sm">
            Enter the pairing code shown by <code>manta pair</code> on your box.
          </div>
        </div>

        <form onSubmit={onSubmitForm} className="flex flex-col items-center gap-4 w-full max-w-xs">
          <input
            ref={inputRef}
            // Numeric soft-keyboard on mobile; one-time-code hint enables OS
            // autofill from an SMS/clipboard where available.
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            aria-label="Pairing code"
            aria-invalid={state.status === "error"}
            placeholder="000000"
            maxLength={6}
            disabled={submitting}
            value={state.code}
            onChange={(e) => dispatch({ type: "edit", raw: e.target.value })}
            className="w-full text-center tracking-[0.4em] text-2xl rounded-lg bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 outline-none focus:border-accent disabled:opacity-60"
          />

          {state.error && (
            <div role="alert" className="text-red-400 text-sm">
              {state.error}
            </div>
          )}

          <button
            type="submit"
            disabled={disabled}
            className="mobile-tap w-full px-5 rounded-lg bg-accent-soft text-white disabled:opacity-40"
          >
            {submitting ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

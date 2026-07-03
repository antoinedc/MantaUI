import { useReducer, useRef, useState } from "react";
import {
  pairingReducer,
  initialPairingState,
  canSubmit,
} from "./pairingLogic";
import { submitPairingCode, saveServerBase } from "../api/httpApi";
import { useQrScanner } from "./useQrScanner";
import { parsePairPayload } from "./pairPayload";

type Props = {
  // Called after a successful claim (token already persisted by
  // submitPairingCode). MobileApp re-runs its bootstrap refresh so the session
  // list loads with the now-valid Bearer credential.
  onPaired: () => void;
};

/**
 * Full-screen pairing gate for the mobile/web client. Shown by MobileApp when
 * bui-server reports auth-required (httpApi throws AuthRequiredError on 401) —
 * both on a fresh, never-paired browser AND on the re-pair path (a previously
 * stored token was revoked/rotated, so the box now 401s again).
 *
 * The user mints a 6-digit code on the box (`bui pair`, local-only) and types
 * it here; we POST /auth/claim, persist the returned box_token on success, and
 * hand control back to MobileApp. All non-UI logic (input contract, HTTP-outcome
 * classification, form state machine) lives in pairingLogic.ts + httpApi's
 * submitPairingCode and is unit-tested there.
 */
export function PairingScreen({ onPaired }: Props) {
  const [state, dispatch] = useReducer(pairingReducer, initialPairingState);
  const [scanning, setScanning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Claim a 6-digit code against the currently-configured server. Shared by the
  // manual submit and the QR auto-connect path (which sets the server first).
  const claim = async (code: string) => {
    dispatch({ type: "submit" });
    const result = await submitPairingCode(code);
    if (result.ok) {
      dispatch({ type: "success" });
      onPaired();
    } else {
      dispatch({ type: "fail", result });
      inputRef.current?.focus();
    }
  };

  const submit = async () => {
    // Guard mirrors canSubmit so an Enter keypress can't fire a request from a
    // non-submittable state (the reducer also no-ops, but avoid the round-trip).
    if (!canSubmit(state)) return;
    await claim(state.code);
  };

  // "Scan QR code" — camera scan → parse payload → auto-connect with no typing.
  // Reuses the exact claim path the manual flow uses; every failure (invalid QR,
  // denied permission, no scanner) falls back to the inline error + manual input.
  const scan = async () => {
    if (scanning || state.status === "submitting") return;
    setScanning(true);
    try {
      const outcome = await useQrScanner();
      if (!outcome.ok) {
        // "cancelled" (user backed out of the camera) is silent — no error, no
        // state change; they can retry or type. "denied"/"unavailable" surface.
        if (outcome.reason !== "cancelled") {
          dispatch({ type: "scanFail", reason: outcome.reason });
        }
        return;
      }
      const payload = parsePairPayload(outcome.value);
      if (!payload) {
        dispatch({ type: "scanFail", reason: "invalid" });
        return;
      }
      // Point the client at the scanned box, then claim the scanned code —
      // reusing submitPairingCode, which reads serverBase() we just set.
      saveServerBase(payload.serverUrl);
      await claim(payload.code);
    } finally {
      setScanning(false);
    }
  };

  const onSubmitForm = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const submitting = state.status === "submitting";
  const disabled = !canSubmit(state) || scanning;

  return (
    <div className="mobile">
      <div className="h-full flex flex-col items-center justify-center gap-6 px-8 text-center">
        <div className="flex flex-col gap-2">
          <div className="text-text text-lg font-medium">Connect to your server</div>
          <div className="text-text-muted text-sm">
            Enter the pairing code shown by <code>bui pair</code> on your box.
          </div>
        </div>

        <div className="flex flex-col items-center gap-4 w-full max-w-xs">
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning || submitting}
            className="mobile-tap w-full px-5 rounded-lg bg-surface border border-border text-text disabled:opacity-40"
          >
            {scanning ? "Scanning…" : "Scan QR code"}
          </button>

          <div className="flex items-center gap-3 w-full text-text-muted text-xs">
            <div className="flex-1 h-px bg-border" />
            <span>or enter code</span>
            <div className="flex-1 h-px bg-border" />
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
            disabled={submitting || scanning}
            value={state.code}
            onChange={(e) => dispatch({ type: "edit", raw: e.target.value })}
            className="w-full text-center tracking-[0.4em] text-2xl rounded-lg bg-surface border border-border px-4 py-3 outline-none focus:border-accent-soft disabled:opacity-60"
          />

          {state.error && (
            <div role="alert" className="text-danger text-sm">
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

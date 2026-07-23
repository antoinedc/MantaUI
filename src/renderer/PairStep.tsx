import { useRef, useState } from "react";
import { normalizeCode } from "../shared/claim.mjs";
import { canConnectSetup } from "./mobile/setupLogic";
import { isValidBoxToken } from "../shared/transport.mjs";
import { claimBox } from "./pairClaim";

// PairStep.tsx — Step 1 (Pair) of the desktop onboarding shell (BET-49-T2,
// BET-255).
//
// Mounts into Onboarding.tsx's step-1 slot. Owns the pairing form:
//   • a Box ID input (32-hex box id, post-BET-198 every box serves its own
//     public hostname — `https://<boxId>.boxes.mantaui.com` — so no
//     server-URL field is needed)
//   • a 6-digit monospace pairing code input (auto-focused)
//   • inline errors for every claim-failure branch (wrong/expired code,
//     rate-limited, unreachable server, malformed response)
//   • its own Connect button (gated by canConnectSetup) + a "Skip setup" link
//
// The claim itself runs in the MAIN process over the `auth:claim` IPC channel
// (window.api.authClaim), which POSTs <boxDirectUrl(boxId)>/auth/claim (the
// URL is built by the shared `buildSetupClaimInput` helper, the SAME one the
// mobile setup screen and the deep-link handler use — single source of
// truth). On success, main persists { serverUrl, boxId, boxToken } to
// config.json. The shared `claimBox` helper mirrors those into the store
// (applyPairing) so resolveTransportMode reads "http" immediately, then
// swaps window.api to httpApi so the next onboarding step (Providers/Model)
// can call opencodeModels() in this same session (BET-254). Finally we call
// onPaired() to let the shell advance to Step 2.
//
// The deep-link `manta://pair?box=…&code=…` flow no longer lands here —
// App.tsx's onPairLink handler auto-claims via the SAME `claimBox` helper and
// advances via `finishOnboarding()`. If the auto-claim fails, the handler
// falls back to opening onboarding at step 1 (Onboarding.tsx still reads
// `pendingPairLink` to force step 1) so the user can retry by hand.
//
// All non-React logic (Box ID validation, the submit gate, the 6-digit
// contract, HTTP-outcome classification, the claim itself) is shared with
// the mobile client via renderer/mobile/setupLogic.ts + shared/transport.mjs
// + the new renderer/pairClaim.ts. This file is just the wiring.
//
// Props:
//   onPaired — successful claim; the shell advances to the next step.
//   onSkip   — user chose "Skip setup"; the shell persists onboardingSkipped
//              and drops to the normal app (handled by the shell's skip()).

const ACCENT = "#5A88FF"; // matches Onboarding.tsx + the app's accent token
const DANGER = "#FF7A88"; // inline error text (no dedicated tailwind token)

export function PairStep({
  onPaired,
  onSkip,
}: {
  onPaired: () => void;
  onSkip: () => void;
}) {
  const [boxId, setBoxId] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const connectEnabled = canConnectSetup({ boxId, code, submitting });

  const connect = async () => {
    if (!canConnectSetup({ boxId, code, submitting })) return;
    setSubmitting(true);
    setError(null);
    const result = await claimBox({ boxId: boxId.trim(), code });
    if (result.ok) {
      setSubmitting(false);
      onPaired();
      return;
    }
    // Failure: show the classified message, keep the code so the user can fix
    // it, and re-focus the code input.
    setSubmitting(false);
    setError(result.message);
    codeRef.current?.focus();
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void connect();
  };

  // A bad/empty Box ID is only flagged once the user has typed something, so
  // a pristine field doesn't show a scary red border on first paint.
  const boxIdLooksBad = boxId.trim() !== "" && !isValidBoxToken(boxId.trim());

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Connect to your server
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        Enter the Box ID and 6-digit pairing code shown on your VPS terminal to
        establish a secure connection.
      </p>

      <form onSubmit={onFormSubmit} className="flex flex-col gap-5">
        {/* Box ID */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pair-box-id" className="text-xs font-medium text-text-muted">
            Box ID
          </label>
          <input
            id="pair-box-id"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="0d5784a7a43451f4ad70dd3d9ee5cf72"
            disabled={submitting}
            value={boxId}
            onChange={(e) => {
              setBoxId(e.target.value.trim());
              setError(null);
            }}
            aria-invalid={boxIdLooksBad}
            className="w-full rounded-md bg-bg-soft border px-3 py-2.5 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
            style={{ borderColor: boxIdLooksBad ? DANGER : undefined }}
          />
        </div>

        {/* Pairing code */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pair-code" className="text-xs font-medium text-text-muted">
            Pairing code
          </label>
          <input
            id="pair-code"
            ref={codeRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            aria-label="Pairing code"
            aria-invalid={error != null}
            placeholder="000000"
            maxLength={6}
            disabled={submitting}
            value={code}
            onChange={(e) => {
              setCode(normalizeCode(e.target.value));
              setError(null);
            }}
            className="w-full rounded-md bg-bg-soft border border-border px-3 py-2.5 text-center font-mono text-2xl tracking-[0.4em] text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
          <p className="text-xs text-text-faint">
            Found in your terminal after running{" "}
            <code className="rounded bg-bg-soft px-1.5 py-0.5 text-[11px] text-text-muted">
              manta pair
            </code>
          </p>
        </div>

        {error && (
          <div role="alert" className="text-sm" style={{ color: DANGER }}>
            {error}
          </div>
        )}

        {/* Footer: Skip setup (left) + Connect (right) — matches the mockup, so
            the shell hides its own footer for Step 1. */}
        <div className="flex items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={onSkip}
            disabled={submitting}
            className="px-3.5 py-2.5 rounded-md text-sm text-text-muted hover:text-text transition-colors disabled:opacity-60"
          >
            Skip setup
          </button>
          <button
            type="submit"
            disabled={!connectEnabled}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
            style={{ background: ACCENT }}
          >
            {submitting ? "Connecting…" : "Connect"}
            {!submitting && (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

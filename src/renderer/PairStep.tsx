import { useRef, useState } from "react";
import { normalizeCode } from "../shared/claim.mjs";
import { normalizeServerUrl, isValidServerUrl, canConnect } from "./pairStepLogic";
import { parsePairPayload } from "./mobile/pairPayload";
import { useStore } from "./store";

// PairStep.tsx — Step 1 (Pair) of the desktop onboarding shell (BET-49-T2;
// extended BET-156 for relay-paired flows).
//
// Mounts into Onboarding.tsx's step-1 slot. Owns the pairing form:
//   • a server-URL input (prefilled from config if the user has paired before)
//   • a 6-digit monospace pairing code input (auto-focused)
//   • an OPTIONAL "pair link" paste input (BET-156): a single textbox that
//     runs parsePairPayload on submit and routes to the same claim call —
//     reuse the exact same form/input styling as the existing screen
//   • inline errors for every claim-failure branch (wrong/expired code,
//     rate-limited, unreachable server, malformed response)
//   • its own Connect button (gated by canConnect) + a "Skip setup" link
//
// The claim itself runs in the MAIN process over the `auth:claim` IPC channel
// (window.api.authClaim), which POSTs either <serverUrl>/auth/claim (direct
// HTTPS) or https://relay.mantaui.com/pair (relay-paired; ADR-2/3) and, on
// success, persists { serverUrl, boxId, boxToken } to config.json. We mirror
// those into the store (applyPairing) so resolveTransportMode reads "http"
// immediately, then call onPaired() to let the shell advance to Step 2.
//
// All non-React logic (URL normalization, the submit gate, the 6-digit
// contract, HTTP-outcome classification) is pure + unit-tested in
// pairStepLogic.ts + src/shared/claim.test.ts + pairPayload.test.ts — this
// file is just the wiring.
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
  // Prefill the server URL from config (empty on a fresh install). Read once at
  // mount — the store's serverUrl is already populated (App gates on `loaded`).
  const [serverUrl, setServerUrl] = useState(() => useStore.getState().serverUrl ?? "");
  const [code, setCode] = useState("");
  const [pairLink, setPairLink] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const pairLinkRef = useRef<HTMLInputElement>(null);

  // When the user pastes a pair link, the link's payload takes precedence
  // over any typed server/code fields. The submit gate follows.
  const linkHasContent = pairLink.trim() !== "";
  const connectEnabled =
    linkHasContent || canConnect({ serverUrl, code, submitting });

  const connect = async () => {
    // Mirror the pure gate so an Enter keypress can't fire from a non-ready
    // state (the button is also disabled, but Enter bypasses that).
    if (submitting) return;
    if (linkHasContent) {
      // Pair link wins: parse it, then route to the same claim call.
      const payload = parsePairPayload(pairLink);
      if (!payload) {
        setError("Couldn't read that pair link — paste the full manta://pair?… line.");
        pairLinkRef.current?.focus();
        return;
      }
      setSubmitting(true);
      setError(null);
      // Relay form sends serverUrl:"" (see AuthClaimInput) so the same input
      // shape works for both the desktop IPC and httpApi's mobile authClaim.
      const result = await window.api.authClaim({
        serverUrl: payload.serverUrl ?? "",
        boxId: payload.boxId ?? undefined,
        code: payload.code,
      });
      if (result.ok) {
        useStore.getState().applyPairing({
          serverUrl: payload.serverUrl ?? `https://relay.mantaui.com/box/${payload.boxId}`,
          boxId: result.boxId,
          boxToken: result.boxToken,
        });
        setSubmitting(false);
        onPaired();
        return;
      }
      setSubmitting(false);
      setError(result.message);
      return;
    }
    if (!canConnect({ serverUrl, code, submitting })) return;
    setSubmitting(true);
    setError(null);
    const result = await window.api.authClaim({
      serverUrl: normalizeServerUrl(serverUrl),
      code,
    });
    if (result.ok) {
      // main already persisted to config.json; mirror into the store so the
      // shell + transport resolution see the paired state without a re-read.
      useStore.getState().applyPairing({
        serverUrl: normalizeServerUrl(serverUrl),
        boxId: result.boxId,
        boxToken: result.boxToken,
      });
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

  // A bad/empty URL is only flagged once the user has typed something, so a
  // pristine field doesn't show a scary red border on first paint.
  const urlLooksBad =
    serverUrl.trim() !== "" && !isValidServerUrl(serverUrl);

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Connect to your server
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        Enter the 6-digit pairing code shown on your VPS terminal to establish a
        secure connection.
      </p>

      <form onSubmit={onFormSubmit} className="flex flex-col gap-5">
        {/* Server URL */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="pair-server-url" className="text-xs font-medium text-text-muted">
            Server URL
          </label>
          <input
            id="pair-server-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://your-box:8787"
            disabled={submitting}
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
              setError(null);
            }}
            aria-invalid={urlLooksBad}
            className="w-full rounded-md bg-bg-soft border px-3 py-2.5 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
            style={{ borderColor: urlLooksBad ? DANGER : undefined }}
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
            disabled={submitting || linkHasContent}
            value={linkHasContent ? "" : code}
            onChange={(e) => {
              setCode(normalizeCode(e.target.value));
              setError(null);
            }}
            className="w-full rounded-md bg-bg-soft border border-border px-3 py-2.5 text-center font-mono text-2xl tracking-[0.4em] text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
          <p className="text-xs text-text-faint">
            Found in your terminal after running{" "}
            <code className="rounded bg-bg-soft px-1.5 py-0.5 text-[11px] text-text-muted">
              bui pair
            </code>
          </p>
        </div>

        {/* Pair link (BET-156) — an optional single-paste field that runs
            parsePairPayload and routes to the SAME claim call. Reuses the
            exact form/input styling of the existing fields. */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="pair-link"
            className="text-xs font-medium text-text-muted"
          >
            Or paste a pair link{" "}
            <span className="text-text-faint font-normal">(optional)</span>
          </label>
          <input
            id="pair-link"
            ref={pairLinkRef}
            type="text"
            spellCheck={false}
            placeholder="manta://pair?box=…&code=…"
            disabled={submitting}
            value={pairLink}
            onChange={(e) => {
              setPairLink(e.target.value);
              setError(null);
            }}
            className="w-full rounded-md bg-bg-soft border border-border px-3 py-2.5 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
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

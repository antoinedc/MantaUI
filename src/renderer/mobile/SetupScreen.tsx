import { useRef, useState } from "react";
import { normalizeCode } from "../../shared/claim.mjs";
import {
  normalizeServerUrl,
  isValidServerUrl,
  canConnect,
} from "../pairStepLogic";

type Props = {
  // Called after a successful claim (token already persisted by
  // httpApi.authClaim). MobileApp clears setupRequired and re-runs its
  // bootstrap refresh so the session list loads with the now-valid
  // Bearer credential AND the now-resolved serverBase().
  onConnected: () => void;
};

/**
 * First-run setup screen for the mobile client (BET-177 Phase 1). Shown by
 * MobileApp when serverBase() throws ServerNotConfiguredError — the production
 * dead-end on a fresh iOS Capacitor install (the shell can't fall back to
 * `capacitor://localhost` so the user would otherwise see a Retry loop
 * forever). Replaces that Retry loop with the URL + pairing-code form so
 * the user can resolve the server on first launch.
 *
 * Mirrors PairingScreen.tsx's wrapper/column/input/button class strings
 * verbatim (copy, not new) so the two screens look identical once the user
 * has paired.
 *
 * Phase 2 will deliver the QR scan + `manta://` deep-link half of the flow
 * on top of this stage's screen; this stage's UX copy already references
 * QR scanning so Phase 2 can land cleanly. There is no "paste a pair link"
 * field on this screen — that's a desktop-only affordance (BET-156) and
 * would mislead the mobile user.
 *
 * All non-React logic (URL normalization, the submit gate, the 6-digit
 * contract, HTTP-outcome classification) is pure + unit-tested in
 * pairStepLogic.ts + src/shared/claim.mjs + pairingLogic.ts — this file is
 * just the wiring.
 */
export function SetupScreen({ onConnected }: Props) {
  const [serverUrl, setServerUrl] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    // Mirror the pure gate so an Enter keypress can't fire from a non-ready
    // state (the button is also disabled, but Enter bypasses that).
    if (!canConnect({ serverUrl, code, submitting })) return;
    setSubmitting(true);
    setError(null);
    // httpApi.authClaim POSTs <serverUrl>/auth/claim, classifies the outcome
    // via the shared classifier, and persists the returned box_token to
    // localStorage["manta_token"] on success (see claimAgainst in httpApi.ts).
    const result = await window.api.authClaim({
      serverUrl: normalizeServerUrl(serverUrl),
      code,
    });
    if (result.ok) {
      // Token is already persisted by claimAgainst — do NOT re-persist here.
      // Persist the server URL so serverBase() resolves on the next refresh.
      localStorage.setItem("manta_server", normalizeServerUrl(serverUrl));
      setSubmitting(false);
      onConnected();
      return;
    }
    // Failure: show the classified message, keep the fields so the user can
    // fix them, and re-focus the code input.
    setSubmitting(false);
    setError(result.message);
    codeRef.current?.focus();
  };

  const onSubmitForm = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const urlLooksBad =
    serverUrl.trim() !== "" && !isValidServerUrl(serverUrl);
  const disabled = !canConnect({ serverUrl, code, submitting });

  return (
    <div className="mobile">
      <div className="h-full flex flex-col items-center justify-center gap-6 px-8 text-center">
        <div className="flex flex-col gap-2">
          <div className="text-text text-lg font-medium">Connect to your server</div>
          <div className="text-text-muted text-sm">
            Run <code>bui pair</code> on your server, then scan the QR code with
            your iPhone camera — or enter the details below.
          </div>
        </div>

        <form onSubmit={onSubmitForm} className="flex flex-col items-center gap-4 w-full max-w-xs">
          <div className="flex flex-col gap-1.5 w-full">
            <label
              htmlFor="setup-server-url"
              className="text-xs font-medium text-text-muted self-start"
            >
              Server URL
            </label>
            <input
              id="setup-server-url"
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
              className="w-full rounded-lg bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 outline-none focus:border-accent disabled:opacity-60"
              style={{ borderColor: urlLooksBad ? "#FF7A88" : undefined }}
            />
          </div>

          <div className="flex flex-col gap-1.5 w-full">
            <label
              htmlFor="setup-code"
              className="text-xs font-medium text-text-muted self-start"
            >
              Pairing code
            </label>
            <input
              id="setup-code"
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
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
              className="w-full text-center tracking-[0.4em] text-2xl rounded-lg bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 outline-none focus:border-accent disabled:opacity-60"
            />
          </div>

          {error && (
            <div role="alert" className="text-red-400 text-sm">
              {error}
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

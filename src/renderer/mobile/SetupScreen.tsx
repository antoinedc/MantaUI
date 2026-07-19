import { useRef, useState } from "react";
import { normalizeCode } from "../../shared/claim.mjs";
import { isValidServerUrl } from "../pairStepLogic";
import { isValidBoxToken } from "../../shared/transport.mjs";
import {
  DEFAULT_SERVER_URL,
  isRelayServer,
  canConnectSetup,
  buildSetupClaimInput,
  resolveSetupServerUrl,
} from "./setupLogic";

type Props = {
  // Called after a successful claim (token already persisted by
  // httpApi.authClaim). MobileApp clears setupRequired and re-runs its
  // bootstrap refresh so the session list loads with the now-valid
  // Bearer credential AND the now-resolved serverBase().
  onConnected: () => void;
};

/**
 * First-run setup screen for the mobile client (BET-177 Phase 1, redesigned
 * BET-186). Shown by MobileApp when serverBase() throws
 * ServerNotConfiguredError on a fresh iOS Capacitor install.
 *
 * Primary path is QR scan: the default view is instructions for getting a QR
 * from the MantaUI desktop app and scanning it with the iPhone Camera (the
 * `manta://pair` deep-link is handled in MobileApp's deepLink effect and
 * requires no interaction here). A "Manual setup" link opens a bottom sheet
 * for typed pairing.
 *
 * The manual sheet has two modes (see setupLogic.ts):
 *   • relay (default): Server URL is pre-filled with the official MantaUI
 *     relay. The relay routes to a box by Box ID, so a Box ID + code are
 *     required. authClaim routes on the boxId.
 *   • custom: the user edits the Server URL to their own box. A direct claim
 *     needs only URL + code, so the Box ID field is disabled.
 *
 * All non-React logic (URL/box-id/code validation, the submit gate, claim-input
 * construction, HTTP-outcome classification) is pure + unit-tested in
 * setupLogic.ts + pairStepLogic.ts + ../../shared/claim.mjs. This file is the
 * wiring.
 */
export function SetupScreen({ onConnected }: Props) {
  const [manualOpen, setManualOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [boxId, setBoxId] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const relayMode = isRelayServer(serverUrl);

  const submit = async () => {
    // Mirror the pure gate so an Enter keypress can't fire from a non-ready
    // state (the button is also disabled, but Enter bypasses that).
    if (!canConnectSetup({ serverUrl, boxId, code, submitting })) return;
    setSubmitting(true);
    setError(null);
    // authClaim POSTs the direct box or relay claim depending on which of
    // {serverUrl, boxId} is populated, classifies the outcome via the shared
    // classifier, and persists the returned token to localStorage on success.
    const result = await window.api.authClaim(
      buildSetupClaimInput({ serverUrl, boxId, code }),
    );
    if (result.ok) {
      // Token is already persisted by authClaim. Persist the resolved server
      // URL so serverBase() resolves on the next refresh (relay mode writes the
      // per-box relay proxy URL; custom mode writes the typed URL).
      localStorage.setItem(
        "manta_server",
        resolveSetupServerUrl({ serverUrl, boxId }),
      );
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

  return (
    <div className="mobile">
      <div className="h-full flex flex-col items-center justify-center gap-7 px-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div
            className="grid place-items-center rounded-2xl"
            style={{
              width: 56,
              height: 56,
              background: "linear-gradient(140deg, #5A88FF, #1740AE)",
              boxShadow: "0 8px 24px rgba(90,136,255,.25)",
            }}
            aria-hidden
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 17c3-6 6-9 9-9s6 3 9 9"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M7 17c2-3.5 3.4-5 5-5s3 1.5 5 5"
                stroke="#fff"
                strokeWidth="2"
                strokeLinecap="round"
                opacity=".6"
              />
            </svg>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-text text-xl font-semibold">Pair your phone</div>
            <div className="text-text-muted text-sm">
              Connect this device to your MantaUI desktop app.
            </div>
          </div>
        </div>

        <div className="w-full max-w-xs flex flex-col gap-4 rounded-2xl border border-border bg-bg-elev p-5 text-left">
          <Step n={1}>
            Open the <b className="text-text font-semibold">MantaUI desktop app</b>, then go to{" "}
            <b className="text-text font-semibold">Settings &rsaquo; Pair phone</b>.
          </Step>
          <Step n={2}>
            Tap <b className="text-text font-semibold">Generate code</b> to show a QR code.
          </Step>
          <Step n={3}>
            Point your iPhone <b className="text-text font-semibold">Camera</b> at the QR code. This
            app opens and connects automatically.
          </Step>
        </div>

        <button
          type="button"
          className="mobile-tap text-accent text-sm font-medium"
          onClick={() => setManualOpen(true)}
        >
          Manual setup
        </button>
      </div>

      {manualOpen && (
        <div
          className="mobile-sheet-backdrop"
          onClick={() => {
            if (!submitting) setManualOpen(false);
          }}
        >
          <div
            className="mobile-sheet"
            style={{ padding: "8px 24px max(env(safe-area-inset-bottom), 28px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              aria-hidden
              style={{
                width: 40,
                height: 4,
                borderRadius: 3,
                background: "#33406B",
                margin: "6px auto 10px",
              }}
            />
            <div className="flex flex-col gap-1 text-left mb-4">
              <div className="text-text text-lg font-semibold">Manual setup</div>
              <div className="text-text-muted text-xs leading-relaxed">
                Enter the details shown by the desktop app under Pair phone. The server URL defaults
                to the official MantaUI server; change it only if you self-host.
              </div>
            </div>

            <form onSubmit={onSubmitForm} className="flex flex-col gap-3.5">
              <Field label="Server URL">
                <input
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://relay.mantaui.com"
                  disabled={submitting}
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrl(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={serverUrl.trim() !== "" && !isValidServerUrl(serverUrl)}
                  className="w-full rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 text-sm font-mono outline-none focus:border-accent disabled:opacity-60"
                />
              </Field>

              <Field label="Box ID">
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="a1b2c3d4e5f6…"
                  disabled={submitting || !relayMode}
                  value={boxId}
                  onChange={(e) => {
                    setBoxId(e.target.value.trim());
                    setError(null);
                  }}
                  aria-invalid={
                    relayMode && boxId.trim() !== "" && !isValidBoxToken(boxId.trim())
                  }
                  className="w-full rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 text-sm font-mono outline-none focus:border-accent disabled:opacity-40"
                />
                <div className="text-text-faint text-[11px] mt-1">
                  Not needed if you are not using the official relay.
                </div>
              </Field>

              <Field label="Pairing code">
                <input
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
                  className="w-full text-center tracking-[0.4em] text-2xl rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 outline-none focus:border-accent disabled:opacity-60"
                />
              </Field>

              {error && (
                <div role="alert" className="text-red-400 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={!canConnectSetup({ serverUrl, boxId, code, submitting })}
                className="mobile-tap w-full px-5 py-3.5 rounded-xl bg-accent-soft text-white font-semibold disabled:opacity-40"
              >
                {submitting ? "Connecting…" : "Connect"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <div
        className="flex-none grid place-items-center rounded-full bg-accent-soft text-white text-xs font-bold"
        style={{ width: 22, height: 22, marginTop: 1 }}
      >
        {n}
      </div>
      <div className="text-text-muted text-[13px] leading-relaxed">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-text-muted self-start">{label}</label>
      {children}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { normalizeCode } from "../../shared/claim.mjs";
import {
  type DebugEntry,
  getDebugLog,
  subscribeDebugLog,
  clearDebugLog,
} from "./debugLog";
import { isValidBoxToken } from "../../shared/transport.mjs";
import {
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
  // QR-scan (deep-link) pairing status from MobileApp's deepLink effect.
  // Surfaced as a banner so a scanned-but-failed pairing shows feedback
  // instead of silence — the #1 "I scanned and nothing happened" symptom.
  pairStatus?: null | "pairing" | "failed" | "invalid";
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
 * The manual sheet asks for a Box ID + pairing code; the box's public
 * hostname (`https://<boxId>.boxes.mantaui.com`) is derived from the Box ID
 * via the shared `boxDirectUrl` helper, so no server-URL field is needed.
 * Every box serves its own public hostname directly.
 *
 * All non-React logic (URL/box-id/code validation, the submit gate,
 * claim-input construction, HTTP-outcome classification) is pure +
 * unit-tested in setupLogic.ts + pairStepLogic.ts + ../../shared/claim.mjs.
 * This file is the wiring.
 */
export function SetupScreen({ onConnected, pairStatus }: Props) {
  const [manualOpen, setManualOpen] = useState(false);
  const [boxId, setBoxId] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!canConnectSetup({ boxId, code, submitting })) return;
    setSubmitting(true);
    setError(null);
    const result = await window.api.authClaim(
      buildSetupClaimInput({ boxId, code }),
    );
    if (result.ok) {
      // Token is already persisted by authClaim. Persist the resolved server
      // URL (boxDirectUrl(boxId)) so serverBase() resolves on the next refresh.
      localStorage.setItem("manta_server", resolveSetupServerUrl({ boxId }));
      setSubmitting(false);
      onConnected();
      return;
    }
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
            <b className="text-text font-semibold">Settings &rsaquo; Connection</b>.
          </Step>
          <Step n={2}>
            Tap <b className="text-text font-semibold">Generate Pairing Code</b> to show a QR code.
          </Step>
          <Step n={3}>
            Point your iPhone <b className="text-text font-semibold">Camera</b> at the QR code. This
            app opens and connects automatically.
          </Step>
        </div>

        {pairStatus && <PairStatusBanner status={pairStatus} />}

        <button
          type="button"
          className="mobile-tap text-accent text-sm font-medium"
          onClick={() => setManualOpen(true)}
        >
          Manual setup
        </button>

        <DebugLogPanel />
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
                Enter the details shown under Settings &rsaquo; Connection in the desktop app.
                Your phone will connect directly to your box.
              </div>
            </div>

            <form onSubmit={onSubmitForm} className="flex flex-col gap-3.5">
              <Field label="Box ID">
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="a1b2c3d4e5f6…"
                  disabled={submitting}
                  value={boxId}
                  onChange={(e) => {
                    setBoxId(e.target.value.trim());
                    setError(null);
                  }}
                  aria-invalid={
                    boxId.trim() !== "" && !isValidBoxToken(boxId.trim())
                  }
                  className="w-full rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 text-sm font-mono outline-none focus:border-accent disabled:opacity-60"
                />
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
                disabled={!canConnectSetup({ boxId, code, submitting })}
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

function PairStatusBanner({
  status,
}: {
  status: "pairing" | "failed" | "invalid";
}) {
  const map = {
    pairing: {
      text: "QR scanned. Connecting…",
      color: "#5A88FF",
      bg: "rgba(90,136,255,.12)",
    },
    failed: {
      text: "Pairing failed. The code may have expired. Generate a new one and scan again.",
      color: "#FF7A88",
      bg: "rgba(255,122,136,.10)",
    },
    invalid: {
      text: "That QR code was not recognized. Make sure you scanned the pairing QR from the desktop app.",
      color: "#FF7A88",
      bg: "rgba(255,122,136,.10)",
    },
  }[status];
  return (
    <div
      role="status"
      className="w-full max-w-xs rounded-xl px-4 py-3 text-[13px] leading-relaxed text-left"
      style={{ background: map.bg, color: map.color, border: `1px solid ${map.color}33` }}
    >
      {status === "pairing" && (
        <span className="inline-block mr-2 align-middle animate-pulse">●</span>
      )}
      {map.text}
    </div>
  );
}

function DebugLogPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DebugEntry[]>(() => getDebugLog());

  useEffect(() => subscribeDebugLog(setEntries), []);

  return (
    <div className="w-full max-w-xs mt-1">
      <button
        type="button"
        className="mobile-tap text-text-faint text-[11px]"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} Debug log ({entries.length})
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-border bg-bg-elev p-2 text-left">
          <div
            className="max-h-52 overflow-y-auto font-mono text-[10px] leading-snug text-text-muted"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {entries.length === 0 ? (
              <div className="text-text-faint">
                No log yet. Scan a QR code, then reopen this.
              </div>
            ) : (
              entries.map((e, i) => (
                <div key={i}>
                  {new Date(e.t).toLocaleTimeString()} {e.msg}
                </div>
              ))
            )}
          </div>
          <div className="flex gap-3 mt-2">
            <button
              type="button"
              className="mobile-tap text-accent text-[11px]"
              onClick={() => {
                const text = getDebugLog()
                  .map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.msg}`)
                  .join("\n");
                try {
                  void navigator.clipboard?.writeText(text);
                } catch {
                  /* clipboard unavailable */
                }
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="mobile-tap text-text-faint text-[11px]"
              onClick={() => clearDebugLog()}
            >
              Clear
            </button>
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

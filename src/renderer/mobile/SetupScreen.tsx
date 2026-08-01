import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { normalizeCode } from "../../shared/claim.mjs";
import {
  type DebugEntry,
  getDebugLog,
  subscribeDebugLog,
  clearDebugLog,
} from "./debugLog";
import { isValidBoxToken } from "../../shared/transport.mjs";
import { normalizeVerifyCode } from "./pairPayload";
import { MantaMark } from "../onboardingUi";
import {
  canConnectSetup,
  buildSetupClaimInput,
  resolveSetupServerUrl,
  normalizeServerUrl,
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

const SERVER_URL_ERROR = "Server URL must start with http:// or https://";

/**
 * First-run setup screen for the mobile client (BET-177 Phase 1, redesigned
 * BET-186, BET-268). Shown by MobileApp when serverBase() throws
 * ServerNotConfiguredError on a fresh iOS Capacitor install.
 *
 * Primary path is QR scan: the default view is instructions for getting a QR
 * from the MantaUI desktop app and scanning it with the iPhone Camera (the
 * `manta://pair` deep-link is handled in MobileApp's deepLink effect and
 * requires no interaction here). A "Manual setup" link opens a bottom sheet
 * for typed pairing.
 *
 * The manual sheet asks for a Box ID + pairing code. By default the box's
 * public hostname (`https://<boxId>.boxes.mantaui.com`) is derived from the
 * Box ID via the shared `boxDirectUrl` helper. BET-268 adds an optional
 * Advanced "Server URL" field (collapsed by default) for tailnet boxes that
 * live at e.g. `http://100.x.y.z:8787`; when set, the claim + the persisted
 * manta_server use that URL verbatim.
 *
 * All non-React logic (URL/box-id/code validation, the submit gate,
 * claim-input construction, server-URL normalization, HTTP-outcome
 * classification) is pure + unit-tested in setupLogic.ts +
 * pairStepLogic.ts + ../../shared/claim.mjs. This file is the wiring.
 */
export function SetupScreen({ onConnected, pairStatus }: Props) {
  const [manualOpen, setManualOpen] = useState(false);
  const [boxId, setBoxId] = useState("");
  const [code, setCode] = useState("");
  // BET-514: optional four-char two-sided-confirm code (§5.3). Forwarded on
  // the claim so this device becomes a DISTINCT Stage-2 device, not the
  // shared primary token. Optional — blank keeps the legacy path.
  const [verifyCode, setVerifyCode] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Server URL is only "bad" when the user typed something non-empty that
  // doesn't match `^https?://` — empty stays the default path (no inline
  // error). Pure check via the shared helper.
  const serverUrlTrimmed = serverUrl.trim();
  const serverUrlInvalid =
    serverUrlTrimmed !== "" && normalizeServerUrl(serverUrlTrimmed) === null;

  const submit = async () => {
    if (!canConnectSetup({ boxId, code, submitting, serverUrl: serverUrlTrimmed })) return;
    setSubmitting(true);
    setError(null);
    const result = await window.api.authClaim(
      buildSetupClaimInput({
        boxId,
        code,
        verify: verifyCode,
        serverUrl: serverUrlTrimmed,
      }),
    );
    if (result.ok) {
      // Token is already persisted by authClaim. Persist the resolved server
      // URL (explicit override if Advanced was set, else boxDirectUrl(boxId))
      // so serverBase() resolves to the same listener the claim succeeded
      // against on the next refresh.
      localStorage.setItem(
        "manta_server",
        resolveSetupServerUrl({ boxId, serverUrl: serverUrlTrimmed }),
      );
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
      <div className="h-full flex flex-col items-center justify-center gap-8 px-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div
            className="grid place-items-center rounded-2xl"
            style={{
              width: 56,
              height: 56,
              background: "linear-gradient(140deg, var(--accent), var(--accent-soft))",
              boxShadow: "0 8px 24px rgb(var(--accent-rgb) / 0.25)",
            }}
            aria-hidden
          >
            {/* BET-421 §F: one brand mark for desktop and mobile — the shared
                MantaMark SVG (same arcs), white on the pair-screen circle. */}
            <MantaMark className="w-[30px] h-[30px] text-white" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-text text-display font-semibold">Pair your phone</div>
            <div className="text-text-muted text-body">
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
            Tap <b className="text-text font-semibold">Generate pairing code</b> to show a QR code.
          </Step>
          <Step n={3}>
            Point your iPhone <b className="text-text font-semibold">Camera</b> at the QR code. This
            app opens and connects automatically.
          </Step>
        </div>

        {pairStatus && <PairStatusBanner status={pairStatus} />}

        <button
          type="button"
          className="mobile-tap text-accent text-body font-medium"
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
                background: "var(--border-strong)",
                margin: "6px auto 10px",
              }}
            />
            <div className="flex flex-col gap-1 text-left mb-4">
              <div className="text-text text-title font-semibold">Manual setup</div>
              <div className="text-text-muted text-meta leading-relaxed">
                Enter the details shown under Settings &rsaquo; Connection in the desktop app.
                Your phone will connect directly to your box.
              </div>
            </div>

            <form onSubmit={onSubmitForm} className="flex flex-col gap-4">
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
                  className="w-full rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 text-body font-mono outline-none focus:border-accent disabled:opacity-60"
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
                  className="w-full text-center tracking-[0.4em] text-2xl font-mono rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 outline-none focus:border-accent disabled:opacity-60"
                />
              </Field>

              {/* Verify — optional four-char two-sided-confirm code (BET-514,
                  §5.3 "K7 Q2"). When the pairing code was minted WITH a
                  verify (desktop "Add a phone" / web pair page), typing it
                  here claims this device as a DISTINCT Stage-2 device rather
                  than reusing the desktop's primary box_token. Optional —
                  blank keeps the legacy path. */}
              <Field label="Verify (optional)">
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="K7Q2"
                  maxLength={4}
                  disabled={submitting}
                  value={verifyCode}
                  onChange={(e) => {
                    setVerifyCode(normalizeVerifyCode(e.target.value).slice(0, 4));
                    setError(null);
                  }}
                  className="w-full text-center tracking-[0.4em] text-2xl font-mono rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 outline-none focus:border-accent disabled:opacity-60"
                />
              </Field>

              {/* Advanced — optional server URL override (BET-268, tailnet
                  path). Collapsed by default; only renders the field when the
                  user opts in. */}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                  aria-controls="mobile-setup-server-url"
                  className="mobile-tap self-start text-meta text-text-muted inline-flex items-center gap-1"
                >
                  {advancedOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} Advanced
                </button>
                {advancedOpen && (
                  <>
                    <label
                      htmlFor="mobile-setup-server-url"
                      className="text-meta font-medium text-text-muted self-start"
                    >
                      Server URL
                    </label>
                    <input
                      id="mobile-setup-server-url"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="http://100.x.y.z:8787"
                      disabled={submitting}
                      value={serverUrl}
                      onChange={(e) => {
                        setServerUrl(e.target.value);
                        setError(null);
                      }}
                      aria-invalid={serverUrlInvalid}
                      aria-describedby={
                        serverUrlInvalid ? "mobile-setup-server-url-err" : undefined
                      }
                      className="w-full rounded-xl bg-bg-soft text-text placeholder:text-text-faint border border-border px-4 py-3 text-body outline-none focus:border-accent disabled:opacity-60"
                      style={{
                        borderColor: serverUrlInvalid ? "var(--danger)" : undefined,
                      }}
                    />
                    {serverUrlInvalid && (
                      <div
                        id="mobile-setup-server-url-err"
                        role="alert"
                        className="text-danger text-meta"
                      >
                        {SERVER_URL_ERROR}
                      </div>
                    )}
                  </>
                )}
              </div>

              {error && (
                <div role="alert" className="text-danger text-body">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={!canConnectSetup({ boxId, code, submitting, serverUrl: serverUrlTrimmed })}
                className="mobile-tap w-full px-5 py-4 rounded-xl bg-accent-soft text-white font-semibold disabled:opacity-40"
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
      color: "var(--accent)",
      bg: "var(--accent-bg)",
    },
    failed: {
      text: "Pairing failed. The code may have expired. Generate a new one and scan again.",
      color: "var(--danger)",
      bg: "var(--danger-bg)",
    },
    invalid: {
      text: "That QR code was not recognized. Make sure you scanned the pairing QR from the desktop app.",
      color: "var(--danger)",
      bg: "var(--danger-bg)",
    },
  }[status];
  return (
    <div
      role="status"
      className="w-full max-w-xs rounded-xl px-4 py-3 text-label leading-relaxed text-left"
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
        className="mobile-tap text-text-faint text-label inline-flex items-center gap-1"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} Debug log ({entries.length})
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-border bg-bg-elev p-2 text-left">
          <div
            className="max-h-52 overflow-y-auto font-mono text-meta leading-snug text-text-muted"
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
              className="mobile-tap text-accent text-label"
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
              className="mobile-tap text-text-faint text-label"
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
        className="flex-none grid place-items-center rounded-full bg-accent-soft text-white text-meta font-bold"
        style={{ width: 22, height: 22, marginTop: 1 }}
      >
        {n}
      </div>
      <div className="text-text-muted text-label leading-relaxed">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-meta font-medium text-text-muted self-start">{label}</label>
      {children}
    </div>
  );
}

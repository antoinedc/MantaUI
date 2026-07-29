// PairStep.tsx — Step 1 (Connect) of the desktop onboarding shell (BET-356).
//
// The user-visible collapse: the SSH picker is now the PRIMARY surface (BET-355
// ships the installer machinery; BET-356 makes it the default path). The
// manual code-entry form survives as a disclosure — the escape hatch for a
// box the user cannot reach over SSH (corporate VPN, jump host, manual VPS
// install). The two paths share the same `onPaired` callback so the shell
// advances identically regardless of which one closed the deal.
//
// We deliberately do NOT keep two co-equal flows (BET-356 constraint):
// the SSH path is primary, the manual form is hidden behind a
// `<details>` block the user has to open.
//
// Props:
//   onPaired — successful pair (SSH install + claim OR manual claim). The
//              shell decides what to do next — usually it runs the
//              post-pair verification (BET-356 §4 "verify by working").
//   onSkip   — user chose "Skip setup"; the shell persists onboardingSkipped
//              and drops to the normal app (handled by the shell's skip()).
//
// The deep-link manta://pair?box=…&code=… flow (#277, BET-335, BET-336)
// remains in scope: if a valid pair-link is pending at mount, the SSH
// picker is hidden and the manual form is pre-filled from it, so a single
// click on Connect IS the confirmation. The picker returns next time the
// user re-enters onboarding from a clean state.

import { useEffect, useRef, useState } from "react";
import { normalizeCode } from "../shared/claim.mjs";
import {
  canConnectSetup,
  normalizeServerUrl,
  prefillFromPairLink,
} from "./mobile/setupLogic";
import { isValidBoxToken } from "../shared/transport.mjs";
import { claimBox } from "./pairClaim";
import { useStore } from "./store";
import { SshInstallStep } from "./SshInstallStep";
import { getMantaPreload } from "./preloadAccess";

const ACCENT = "#5A88FF"; // matches Onboarding.tsx + the app's accent token
const DANGER = "#FF7A88"; // inline error text (no dedicated tailwind token)
const SERVER_URL_ERROR = "Server URL must start with http:// or https://";

export function PairStep({
  onPaired,
  onSkip,
}: {
  onPaired: () => void;
  onSkip: () => void;
}) {
  const hasSshInstaller = getMantaPreload() !== null;

  // Deep-link (BET-335) — if a manta://pair?... URL is pending in the store
  // at mount, prefill the manual form from it and force the disclosure open
  // so the user sees the address they're about to pair against. When no
  // link is pending, show the SSH picker as the primary surface.
  const pendingPairLink = useStore.getState().pendingPairLink;
  const prefill = prefillFromPairLink(pendingPairLink);
  const [disclosureOpen, setDisclosureOpen] = useState(() => Boolean(prefill));
  // On a renderer without an SSH installer (mobile / web), the picker is
  // unavailable — surface the manual form immediately rather than render an
  // empty shell.
  const showSshPicker = hasSshInstaller && !prefill;

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Connect to your box
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        Pick a host from your SSH config — the app will install MantaUI on it
        and pair automatically. You can skip this and connect manually below.
      </p>

      {showSshPicker && (
        <div className="mb-6">
          <SshInstallStep onPaired={onPaired} />
        </div>
      )}

      {/* Manual escape hatch — the SSH picker is the primary flow, but a
          box the user can't reach over SSH (jump host, corporate VPN) needs
          this path. Hidden by default; opens via a `<details>` disclosure
          so it doesn't compete visually with the SSH picker. */}
      <details
        open={disclosureOpen}
        onToggle={(e) => setDisclosureOpen((e.target as HTMLDetailsElement).open)}
        className="border border-border rounded-md bg-bg-soft"
      >
        <summary className="cursor-pointer px-3 py-2 text-xs text-text-muted hover:text-text select-none">
          Pair manually with a code
        </summary>
        <div className="px-3 pb-3 pt-1">
          <ManualPairForm
            prefill={prefill}
            onPaired={onPaired}
            onSkip={onSkip}
          />
        </div>
      </details>
    </div>
  );
}

// Manual code-entry form. Extracted from the previous "manual" mode of
// PairStep so the disclosure can mount it as a self-contained block. The
// pure validation/submit-gate lives in renderer/mobile/setupLogic.ts; this
// component is wiring + JSX only.
function ManualPairForm({
  prefill,
  onPaired,
  onSkip,
}: {
  prefill: ReturnType<typeof prefillFromPairLink>;
  onPaired: () => void;
  onSkip: () => void;
}) {
  const [boxId, setBoxId] = useState(() => prefill?.boxId ?? "");
  const [code, setCode] = useState(() => prefill?.code ?? "");
  const [serverUrl, setServerUrl] = useState(() => prefill?.serverUrl ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Deep-link failure reason (BET-335). Rendered in the same inline slot
  // a manual Connect failure uses; consume-on-read so a re-fire still
  // changes the value.
  const pairLinkError = useStore((s) => s.pairLinkError);
  useEffect(() => {
    if (!pairLinkError) return;
    setError(pairLinkError);
    useStore.getState().setPairLinkError(null);
    codeRef.current?.focus();
  }, [pairLinkError]);

  const serverUrlTrimmed = serverUrl.trim();
  const serverUrlInvalid =
    serverUrlTrimmed !== "" && normalizeServerUrl(serverUrlTrimmed) === null;

  const connectEnabled = canConnectSetup({
    boxId,
    code,
    submitting,
    serverUrl: serverUrlTrimmed,
  });

  const connect = async () => {
    if (!connectEnabled) return;
    setSubmitting(true);
    setError(null);
    const result = await claimBox({
      boxId: boxId.trim(),
      code,
      serverUrl: serverUrlTrimmed,
    });
    if (result.ok) {
      useStore.getState().setPendingPairLink(null);
      setSubmitting(false);
      onPaired();
      return;
    }
    setSubmitting(false);
    setError(result.message);
    codeRef.current?.focus();
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void connect();
  };

  const boxIdLooksBad = boxId.trim() !== "" && !isValidBoxToken(boxId.trim());

  return (
    <form onSubmit={onFormSubmit} className="flex flex-col gap-4">
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
          className="w-full rounded-md bg-bg border px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
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
          className="w-full rounded-md bg-bg border border-border px-3 py-2 text-center font-mono text-2xl tracking-[0.4em] text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
        />
        <p className="text-xs text-text-faint">
          Generated on the box with{" "}
          <code className="rounded bg-bg px-1.5 py-0.5 text-[11px] text-text-muted">
            manta pair
          </code>
        </p>
      </div>

      {/* Advanced — optional server URL override (BET-268, tailnet path) */}
      <ServerUrlField
        value={serverUrl}
        onChange={setServerUrl}
        disabled={submitting}
        invalid={serverUrlInvalid}
      />

      {error && (
        <div role="alert" className="text-sm" style={{ color: DANGER }}>
          {error}
        </div>
      )}

      {/* Footer: Skip setup (left) + Connect (right) */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="px-3.5 py-2 rounded-md text-sm text-text-muted hover:text-text transition-colors disabled:opacity-60"
        >
          Skip setup
        </button>
        <button
          type="submit"
          disabled={!connectEnabled}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
          style={{ background: ACCENT }}
        >
          {submitting ? "Connecting…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

// Optional server URL override — collapsed behind its own mini-disclosure
// inside the manual form. Most users leave this empty (the box's public
// hostname is derived from the box id); tailnet / private listeners override
// here.
function ServerUrlField({
  value,
  onChange,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="pair-server-url"
        className="self-start text-xs text-text-muted hover:text-text transition-colors disabled:opacity-60"
      >
        {open ? "▾" : "▸"} Advanced
      </button>
      {open && (
        <>
          <label
            htmlFor="pair-server-url"
            className="text-xs font-medium text-text-muted"
          >
            Server URL
          </label>
          <input
            id="pair-server-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://100.x.y.z:8787"
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={invalid ? "pair-server-url-err" : undefined}
            className="w-full rounded-md bg-bg border px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
            style={{ borderColor: invalid ? DANGER : undefined }}
          />
          {invalid && (
            <div
              id="pair-server-url-err"
              role="alert"
              className="text-xs"
              style={{ color: DANGER }}
            >
              {SERVER_URL_ERROR}
            </div>
          )}
        </>
      )}
    </div>
  );
}

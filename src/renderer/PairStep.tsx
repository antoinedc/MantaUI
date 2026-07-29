// PairStep.tsx — Step 1 (Connect) of the desktop onboarding shell (BET-356).
//
// One heading, one primary action (BET-382). The SSH picker is the primary
// surface; the manual pairing form sits behind a plain text button labelled
// "Pair to an existing box" / "Hide" so a box the user can't reach over SSH
// (corporate VPN, jump host, manual VPS install) still has an escape hatch.
// The two paths share the same `onPaired` callback so the shell advances
// identically regardless of which one closed the deal.
//
// The deep-link manta://pair?box=…&code=… flow (#277, BET-335, BET-336)
// remains in scope: if a valid pair-link is pending at mount, the SSH
// picker is hidden and the manual form is pre-filled from it (one row,
// three fields: Host · Box ID · Code), so a single click on Connect IS the
// confirmation. The picker returns next time the user re-enters onboarding
// from a clean state.
//
// Props:
//   onPaired — successful pair (SSH install + claim OR manual claim). The
//              shell decides what to do next — usually it runs the
//              post-pair verification (BET-356 §4 "verify by working").
//
// Onboarding.tsx's `skip` / store.skipOnboarding are still reachable from
// Settings ("re-run onboarding" path) and stay wired up — the prop is gone
// from PairStep but the action is not.

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

export function PairStep({ onPaired }: { onPaired: () => void }) {
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
        Connect your box
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        Pick the machine you want to run Manta on. It installs itself over SSH
        and pairs with this app — no terminal needed.
      </p>

      {showSshPicker && (
        <div className="mb-6">
          <SshInstallStep onPaired={onPaired} />
        </div>
      )}

      <button
        type="button"
        onClick={() => setDisclosureOpen((v) => !v)}
        className="text-xs text-text-faint hover:text-text-muted underline underline-offset-4 decoration-border-strong transition-colors mt-6"
      >
        {disclosureOpen ? "Hide" : "Pair to an existing box"}
      </button>
      {disclosureOpen && (
        <ManualPairForm prefill={prefill} onPaired={onPaired} />
      )}
    </div>
  );
}

// Manual code-entry form. Extracted from PairStep so the disclosure can
// mount it as a self-contained block. The pure validation/submit-gate lives
// in renderer/mobile/setupLogic.ts (canConnectSetup / normalizeServerUrl);
// this component is wiring + JSX only — no validation logic is duplicated
// here (BET-382).
//
// Layout (BET-382): one row of three fields on ≥640px (Host · Box ID · Code),
// stacked to one column under `sm`. The "Host" input replaces the old
// "Advanced → Server URL" disclosure — the value still flows through
// `serverUrl` state and the same `Server URL must start with http:// or
// https://` validation, so the tailnet path (BET-268) and the deep-link
// prefill (BET-336) keep working unchanged.
function ManualPairForm({
  prefill,
  onPaired,
}: {
  prefill: ReturnType<typeof prefillFromPairLink>;
  onPaired: () => void;
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
    <form onSubmit={onFormSubmit} className="flex flex-col gap-4 mt-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1.5fr_1.5fr_0.9fr] gap-2.5 items-end">
        {/* Host — replaces the old Advanced → Server URL disclosure. The
            value is still named `serverUrl` and still flows through
            normalizeServerUrl / canConnectSetup, so the tailnet path
            (BET-268) and the deep-link server= override (BET-336) work
            unchanged. The validation error renders inline under this input
            only (the grid cell wraps input + error). */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="pair-host"
            className="text-[11px] font-medium text-text-muted"
          >
            Host
          </label>
          <input
            id="pair-host"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://box.mantaui.com"
            disabled={submitting}
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
              setError(null);
            }}
            aria-invalid={serverUrlInvalid}
            aria-describedby={serverUrlInvalid ? "pair-host-err" : undefined}
            className="w-full rounded-md bg-bg border px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
            style={{ borderColor: serverUrlInvalid ? DANGER : undefined }}
          />
          {serverUrlInvalid && (
            <div
              id="pair-host-err"
              role="alert"
              className="text-xs"
              style={{ color: DANGER }}
            >
              {SERVER_URL_ERROR}
            </div>
          )}
        </div>

        {/* Box ID */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="pair-box-id"
            className="text-[11px] font-medium text-text-muted"
          >
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

        {/* Pairing code — 6 digits, monospace, centered. Drops the
            previous text-2xl + tracking-[0.4em] (oversized); becomes a
            normal-size input that still reads as "this is a code". */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="pair-code"
            className="text-[11px] font-medium text-text-muted"
          >
            Code
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
            className="w-full rounded-md bg-bg border border-border px-3 py-2 text-center font-mono tracking-[0.22em] text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="text-sm" style={{ color: DANGER }}>
          {error}
        </div>
      )}

      {/* Footer: hint (left) + Connect (right). The Skip-setup button was
          removed in BET-382; `skip` / skipOnboarding remain reachable from
          Settings for users who need to re-run onboarding. */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-text-faint">
          Run{" "}
          <code className="rounded bg-bg px-1.5 py-0.5 text-[11px] text-text-muted">
            manta pair
          </code>{" "}
          on the box to get a code.
        </p>
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

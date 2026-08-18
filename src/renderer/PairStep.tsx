// PairStep.tsx — Step 1 (Connect) of the desktop onboarding shell (BET-356).
//
// One Connect panel, two modes (BET-962). Zone A is either the SSH host
// picker (default — `ssh` mode, rendered by SshInstallStep) or the manual
// code-entry fields (`manual` mode). A plain text link under zone A toggles
// between them: "Enter a pairing code instead" ↔ "Back to the host picker".
// Zones B, C and D behave identically in both modes — both feed the SAME
// four-zone ConnectPanel through the single deriveConnectPanel descriptor, so
// there is exactly one function deciding what the panel says.
//
// The manual path:
//   - A pending deep-link (manta://pair?box=…&code=…) forces manual mode on
//     mount with the fields pre-filled — one click on Connect confirms.
//   - A clipboard pair-link (BET-704) switches zone A to manual mode, fills
//     the fields through the SAME pendingPairLink path (no second prefill
//     mechanism), and renders a "from clipboard" chip beside the address.
//   - A successful claim lands on the same "Your box is ready" + Next → state
//     the SSH path ends on, so both pairing paths converge.
//
// Both modes call `onPaired` when the panel's Next is pressed; the shell
// decides what to do next (usually post-pair verification, BET-356 §4).
//
// Onboarding.tsx's `skip` / store.skipOnboarding stays reachable from
// Settings and is unaffected.

import { useEffect, useRef, useState } from "react";
import {
  canConnectSetup,
  normalizeServerUrl,
  prefillFromPairLink,
} from "../shared/setupLogic";
import { detectPairClipboard } from "../shared/pairPayload";
import { PairingCodeInput } from "./PairingCodeInput";
import { isValidBoxToken } from "../shared/transport.mjs";
import { claimBox } from "./pairClaim";
import { useStore } from "./store";
import { SshInstallStep } from "./SshInstallStep";
import { getMantaPreload } from "./preloadAccess";
import { channelConfig } from "../shared/channel.mjs";
import { ConnectPanel } from "./ConnectPanel";
import { deriveConnectPanel, type ConnectActionId } from "./connectPanelLogic";
import { MantaLoader } from "./MantaLoader";

const DANGER = "var(--danger)"; // inline error text
const SERVER_URL_ERROR = "Server URL must start with http:// or https://";

// BET-373 (review cycle 1): the pending pair link stored by App.tsx was
// already accepted against THIS channel's scheme (App.tsx's
// PAIR_PARSE_SCHEME) — parsing it here with a different (default) scheme
// would silently drop the payload on staging/dev. Same constant App.tsx
// and PairingQR.tsx already build from `src/shared/channel.mjs`.
//
// BET-373 (review cycle 3): `__MANTA_CHANNEL__` is only DEFINEd by
// electron-vite's build config (electron.vite.config.ts); it is not bound
// under vitest/node, so a direct reference throws a ReferenceError at
// import time. PairStep.test.tsx (BET-382) renders this component
// directly, so — unlike App.tsx/PairingQR.tsx, which no test imports
// today — this module needed the same `typeof` guard src/main/index.ts
// and src/main/installer/installer.ts already use for exactly this
// reason. Falls back to "prod", matching those call sites.
const PAIR_PREFILL_SCHEME = channelConfig(
  typeof __MANTA_CHANNEL__ === "string" ? __MANTA_CHANNEL__ : "prod",
).urlScheme;

export function PairStep({ onPaired }: { onPaired: () => void }) {
  const hasSshInstaller = getMantaPreload() !== null;

  // Deep-link (BET-335) — if a manta://pair?... URL is pending in the store
  // at mount, prefill the manual form from it and force manual mode so the
  // user sees the address they're about to pair against. When no link is
  // pending and an SSH installer exists, show the picker as the default mode.
  const pendingPairLink = useStore.getState().pendingPairLink;
  const prefill = prefillFromPairLink(pendingPairLink, PAIR_PREFILL_SCHEME);

  // Mode of zone A (BET-962). A pending deep-link forces manual mode on
  // mount; on a renderer without an SSH installer the picker is unavailable,
  // so manual mode becomes the default. Otherwise the picker is primary.
  const [mode, setMode] = useState<"ssh" | "manual">(() =>
    prefill ? "manual" : hasSshInstaller ? "ssh" : "manual",
  );
  // Whether the current prefill came from the clipboard (vs a deep-link) —
  // renders the "from clipboard" chip beside the address.
  const [fromClipboard, setFromClipboard] = useState(false);

  // Clipboard pair-link detection (BET-704): a user who received a pairing
  // link elsewhere (chat message, terminal copy) shouldn't have to retype
  // it. Checked on mount AND on window focus while this step is shown — no
  // polling/intervals. A hit switches zone A to manual mode and routes
  // through the SAME pendingPairLink mechanism the OS deep-link handler uses
  // (App.tsx's onPairLink → setPendingPairLink → prefillFromPairLink), so
  // there is exactly one prefill code path. The user still clicks Connect —
  // this never auto-claims.
  const lastClipboardRef = useRef<string | null>(null);

  useEffect(() => {
    const preload = getMantaPreload();
    if (!preload) return;

    const check = () => {
      void (async () => {
        let text: string;
        try {
          text = await preload.readClipboardText();
        } catch {
          return; // clipboard read failed — silently no-op
        }
        const trimmed = (text ?? "").trim();
        if (!trimmed || trimmed === lastClipboardRef.current) return;
        if (!detectPairClipboard(trimmed, PAIR_PREFILL_SCHEME)) return;
        lastClipboardRef.current = trimmed;
        useStore.getState().setPendingPairLink(trimmed);
        setFromClipboard(true);
        setMode("manual");
      })();
    };

    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  return (
    <div>
      <h2 className="text-display font-semibold tracking-tight text-text mb-2">
        Connect your server
      </h2>
      <p className="text-body text-text-muted leading-relaxed mb-8 max-w-md">
        Pick the machine you want to run Manta on. It installs itself over SSH
        and pairs with this app — no terminal needed.
      </p>

      {mode === "ssh" ? (
        <div className="mb-6">
          <SshInstallStep
            onPaired={onPaired}
            // BET-962: the picker's "Enter a pairing code instead" link (and
            // the install-failed "Pair manually" action) switch zone A to
            // manual mode — there is no separate disclosure any more.
            onPairManually={() => setMode("manual")}
          />
        </div>
      ) : (
        // Keyed on pendingPairLink so a clipboard "Use it" click prefills a
        // manual panel that is ALREADY open (a fresh mount is the only way
        // this component's useState-seeded fields pick up a new prefill —
        // the same mechanism the deep-link path already relies on).
        <ManualPairPanel
          key={pendingPairLink ?? "no-prefill"}
          prefill={prefill}
          fromClipboard={fromClipboard}
          onPaired={onPaired}
          onBackToPicker={() => setMode("ssh")}
        />
      )}
    </div>
  );
}

// Manual code-entry mode of the Connect panel's zone A (BET-962). Renders the
// same Host / Box ID / Code grid the old standalone ManualPairForm had —
// moved unchanged into zone A — but no longer owns status, actions or the
// footer button: those are the Connect panel's zones B and D, fed by
// deriveConnectPanel below. Pure validation stays in shared/setupLogic.ts
// (canConnectSetup / normalizeServerUrl); this component is wiring + JSX only.
function ManualPairPanel({
  prefill,
  fromClipboard,
  onPaired,
  onBackToPicker,
}: {
  prefill: ReturnType<typeof prefillFromPairLink>;
  fromClipboard: boolean;
  onPaired: () => void;
  onBackToPicker: () => void;
}) {
  const [boxId, setBoxId] = useState(() => prefill?.boxId ?? "");
  const [code, setCode] = useState(() => prefill?.code ?? "");
  const [serverUrl, setServerUrl] = useState(() => prefill?.serverUrl ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // Deep-link failure reason (BET-335). Rendered as the claim error the
  // manual panel surfaces; consume-on-read so a re-fire still changes the
  // value.
  const pairLinkError = useStore((s) => s.pairLinkError);
  useEffect(() => {
    if (!pairLinkError) return;
    setClaimError(pairLinkError);
    useStore.getState().setPairLinkError(null);
    codeRef.current?.focus();
  }, [pairLinkError]);

  const serverUrlTrimmed = serverUrl.trim();
  const serverUrlInvalid =
    serverUrlTrimmed !== "" && normalizeServerUrl(serverUrlTrimmed) === null;

  const canConnect = canConnectSetup({
    boxId,
    code,
    submitting,
    serverUrl: serverUrlTrimmed,
  });

  const connectState = deriveConnectPanel({
    mode: "manual",
    paired,
    claimError,
    prefillPresent: Boolean(prefill),
    canConnect,
    submitting,
  });

  const connect = async () => {
    if (!canConnect) return;
    setSubmitting(true);
    setClaimError(null);
    const result = await claimBox({
      boxId: boxId.trim(),
      code,
      serverUrl: serverUrlTrimmed,
    });
    if (result.ok) {
      useStore.getState().setPendingPairLink(null);
      setSubmitting(false);
      // Hold the step on the "Connected" + Next → state (BET-962 converges
      // the manual path on the SSH path's ending) instead of auto-advancing.
      setPaired(true);
      return;
    }
    setSubmitting(false);
    setClaimError(result.message);
    codeRef.current?.focus();
  };

  function handleAction(id: ConnectActionId) {
    switch (id) {
      case "connect":
        void connect();
        break;
      case "discard":
        // Toss the pending prefill and fall back to idle code entry.
        useStore.getState().setPendingPairLink(null);
        setBoxId("");
        setCode("");
        setServerUrl("");
        setClaimError(null);
        break;
      case "cancel":
        setSubmitting(false);
        break;
      case "retry":
        void connect();
        break;
      case "next":
        onPaired();
        break;
      default:
        break;
    }
  }

  const boxIdLooksBad = boxId.trim() !== "" && !isValidBoxToken(boxId.trim());

  // Zone A — the manual code-entry fields, in the same responsive grid the
  // old standalone form used, plus the mode-switch link back to the picker.
  // Zone A is not rendered at all once `targetCollapsed` (submitting/paired) —
  // `targetSummary` replaces it, so there are no `disabled` copies of these
  // fields. The host label for the summary is the address the user paired
  // against (or the pending deep-link's server).
  const hostLabel = serverUrlTrimmed || prefill?.serverUrl || "your server";
  const targetSummary = (
    <div className="flex items-center gap-2 min-w-0">
      {paired ? (
        <span aria-hidden className="w-2 h-2 rounded-full shrink-0 bg-ok" />
      ) : (
        <MantaLoader size="inline" />
      )}
      <span className="text-body font-medium text-text truncate">
        {paired ? `Connected to ${hostLabel}` : `Setting up ${hostLabel}`}
      </span>
    </div>
  );

  const zoneA = (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[1.5fr_1.5fr_0.9fr] gap-3 items-end">
        {/* Host — the value still flows through `serverUrl` state and the same
            `Server URL must start with http:// or https://` validation, so the
            tailnet path (BET-268) and the deep-link server= override (BET-336)
            keep working unchanged. A clipboard-detected link shows the
            "from clipboard" chip beside the address. */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="pair-host"
            className="text-label font-medium text-text-muted flex items-center gap-2"
          >
            Host
            {fromClipboard && prefill && (
              <span className="inline-flex items-center gap-2 text-meta rounded-full px-2 py-1 bg-accent-bg text-accent border border-accent">
                from clipboard
              </span>
            )}
          </label>
          <input
            id="pair-host"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://server.mantaui.com"
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
              setClaimError(null);
            }}
            aria-invalid={serverUrlInvalid}
            aria-describedby={serverUrlInvalid ? "pair-host-err" : undefined}
            className="w-full rounded-sm bg-bg border px-3 py-2 text-body font-mono text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
            style={{ borderColor: serverUrlInvalid ? DANGER : undefined }}
          />
          {serverUrlInvalid && (
            <div
              id="pair-host-err"
              role="alert"
              className="text-meta"
              style={{ color: DANGER }}
            >
              {SERVER_URL_ERROR}
            </div>
          )}
        </div>

        {/* Box ID */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="pair-box-id"
            className="text-label font-medium text-text-muted"
          >
            Server ID{" "}
            <span className="font-normal text-text-faint">
              (optional if Host set)
            </span>
          </label>
          <input
            id="pair-box-id"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="0d5784a7a43451f4ad70dd3d9ee5cf72"
            value={boxId}
            onChange={(e) => {
              setBoxId(e.target.value.trim());
              setClaimError(null);
            }}
            aria-invalid={boxIdLooksBad}
            className="w-full rounded-sm bg-bg border px-3 py-2 text-body font-mono text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
            style={{ borderColor: boxIdLooksBad ? DANGER : undefined }}
          />
        </div>

        {/* Pairing code — 6 digits, monospace, centered. */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="pair-code"
            className="text-label font-medium text-text-muted"
          >
            Code
          </label>
          <PairingCodeInput
            id="pair-code"
            ref={codeRef}
            hasError={claimError != null}
            value={code}
            onChange={(v) => {
              setCode(v);
              setClaimError(null);
            }}
            className="w-full rounded-sm bg-bg border border-border px-3 py-2 text-center font-mono tracking-[0.22em] text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
        </div>
      </div>

      {/* BET-962: mode switch back to the host picker — zone A link. */}
      <button
        type="button"
        onClick={onBackToPicker}
        className="text-meta text-text-faint hover:text-text-muted underline underline-offset-4 decoration-border-strong transition-colors"
      >
        Back to the host picker
      </button>
    </div>
  );

  return (
    <ConnectPanel
      state={connectState}
      target={zoneA}
      targetSummary={targetSummary}
      logLines={[]}
      onAction={handleAction}
    />
  );
}

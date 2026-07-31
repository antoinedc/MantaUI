// ProvidersStep.tsx — Step 2 (Connect a provider) of the desktop onboarding
// shell (BET-49-T4, BET-315, BET-356). Mounts into Onboarding.tsx's step-2
// slot.
//
// BET-356 behaviour: this step auto-skips when the box already has a
// connected provider. On mount, the step probes `opencodeProviderAuth
// ({action: "status"})`; if any row reports `connected: true` it calls
// `onContinue()` immediately and renders nothing. The user sees step 2
// for at most one frame on a resumed flow with a pre-connected box.
//
// When zero providers are connected, the step renders the registry-driven
// connect list (one row per provider declared in
// src/server/subscriptionProviders.mjs). Each Connect delegates to the
// shared <ConnectProvider> card (BET-312, BET-354) — same component the
// Settings → Subscriptions card consumes, so an in-app Anthropic sign-in
// works identically here and there.
//
// Helpers (canContinueProviders) used to live in `providersStepLogic.ts`;
// they're now inlined because that file became dead weight after the model
// picker was removed from onboarding (the surviving helpers had only this
// single consumer). Inlining keeps the "providersStep" surface area to one
// file. The custom-provider form + its validator (BET-421 §D) live in
// CustomProviderForm.tsx / chatUtils.ts and are shared with Settings.
//
// `canContinueProviders(statuses)` is still the Continue gate — a
// subscription connected seconds ago counts immediately because the same
// `status` action drives the row badges and the gate, by construction
// (BET-315). The shell's auto-skip on mount relies on the same probe.
//
// Props:
//   onBack     — go to the previous step (Connect).
//   onContinue — finalize onboarding (create welcome project + verify the
//                box actually answers). The shell wraps this with the
//                "verify by working" orchestrator (BET-356 §4).

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { SubscriptionStatus } from "../shared/types";
import { ConnectProvider } from "./ConnectProvider";
import { CustomProviderForm } from "./CustomProviderForm";
import { StepFooter } from "./onboardingUi";

const DANGER = "var(--danger)";
const SUCCESS = "var(--ok)";

// Continue gate: at least one provider must be connected. Mirrors the
// gate ProvidersStep has had since BET-315 (the `status` action is the
// single source of truth — the same probe that drives the row badges
// drives this gate, so a subscription counted as connected here is the
// one whose models appear in chat sessions).
export function canContinueProviders(statuses: SubscriptionStatus[]): boolean {
  return statuses.some((s) => s.connected);
}

export function ProvidersStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const [statuses, setStatuses] = useState<SubscriptionStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoSkipped, setAutoSkipped] = useState(false);
  // Exactly one row can be mid-mutation at a time.
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);

  // Refresh + auto-skip on mount. The auto-skip path calls `onContinue`
  // exactly once (latched via `autoSkipped`) so a late-arriving status
  // response after the auto-skip fires cannot double-advance the shell.
  // The shell's own progress dot math already collapses a "step 2 for
  // one frame" jump — the user sees no flicker.
  const refresh = useCallback(async () => {
    setLoadError(null);
    if (typeof window.api.opencodeProviderAuth !== "function") {
      setLoadError("Couldn't reach the box to check providers.");
      setStatuses([]);
      return;
    }
    try {
      const res = await window.api.opencodeProviderAuth({ action: "status" });
      if (res.action !== "status") {
        setLoadError("Unexpected response from the box.");
        setStatuses([]);
        return;
      }
      setStatuses(res.providers);
      // Auto-skip: with at least one provider connected, this step is
      // done before the user sees it. Latch so a re-fetch (e.g. after a
      // custom provider save) cannot fire onContinue a second time.
      if (!autoSkipped && res.providers.some((p) => p.connected)) {
        setAutoSkipped(true);
        onContinue();
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatuses([]);
    }
  }, [autoSkipped, onContinue]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canContinue = canContinueProviders(statuses ?? []);

  const onConnectDone = useCallback(
    (_ok: boolean) => {
      setConnectingId(null);
      void refresh();
    },
    [refresh],
  );

  // Render nothing while the auto-skip path is in flight (the shell will
  // have already advanced). Returning null here is what keeps the user
  // from seeing a flash of the provider list before onContinue fires.
  if (autoSkipped) return null;

  return (
    <div>
      <h2 className="text-display font-semibold tracking-tight text-text mb-2">
        Connect your subscriptions
      </h2>
      <p className="text-body text-text-muted leading-relaxed mb-6 max-w-md">
        Sign in with a subscription you already pay for. You can add more later.
      </p>

      {loadError && (
        <div role="alert" className="text-body mb-4" style={{ color: DANGER }}>
          {loadError}{" "}
          <button
            onClick={() => void refresh()}
            className="underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Subscriptions — one row per provider from the registry. */}
      <div className="space-y-2">
        {(statuses ?? []).map((s) => {
          const isConnecting = connectingId === s.id;
          const anyConnecting = connectingId !== null;
          return (
            <div key={s.id} className="border border-border rounded p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-body text-text truncate">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-text-faint"> · {s.plan}</span>
                  </div>
                  <div className="text-label text-text-faint flex items-center gap-2 mt-px">
                    <span
                      aria-hidden
                      className={`inline-block w-1.5 h-1.5 rounded-full ${
                        s.connected ? "bg-ok" : "bg-text-faint"
                      }`}
                    />
                    <span>{s.connected ? "connected" : "not connected"}</span>
                  </div>
                </div>
                {isConnecting ? null : s.connected ? (
                  <span
                    className="text-label font-medium inline-flex items-center"
                    style={{ color: SUCCESS }}
                  >
                    <Check size={14} aria-hidden="true" />
                  </span>
                ) : (
                  <button
                    onClick={() => setConnectingId(s.id)}
                    disabled={anyConnecting}
                    className="px-3 py-2 text-meta bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
                  >
                    Connect
                  </button>
                )}
              </div>
              {isConnecting && (
                <ConnectProvider
                  id={s.id}
                  label={s.label}
                  onDone={onConnectDone}
                  onCancel={() => setConnectingId(null)}
                />
              )}
            </div>
          );
        })}
        {statuses !== null && statuses.length === 0 && (
          <div className="text-body text-text-faint">
            No providers available.
          </div>
        )}
      </div>

      {/* Custom endpoint — demoted to a secondary link that reveals the form. */}
      <div className="mt-6">
        <button
          onClick={() => setShowCustom((v) => !v)}
          className="text-meta text-text-muted underline decoration-dotted hover:text-text"
        >
          {showCustom ? "Hide custom endpoint" : "Use your own API endpoint instead"}
        </button>
        {showCustom && (
          <div className="mt-3">
            <CustomProviderForm
              onSaved={async () => {
                setShowCustom(false);
                await refresh();
              }}
            />
          </div>
        )}
      </div>

      {/* Footer: Back (left) + Continue (right). Continue gated on ≥1 connected. */}
      <StepFooter
        onBack={onBack}
        onContinue={onContinue}
        continueDisabled={!canContinue}
      />
    </div>
  );
}

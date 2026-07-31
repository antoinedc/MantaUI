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
// Helpers (canContinueProviders, customDraftError) used to live in
// `providersStepLogic.ts`; they're now inlined because that file became
// dead weight after the model picker was removed from onboarding (the
// surviving helpers had only this single consumer). Inlining keeps the
// "providersStep" surface area to one file.
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
import { StepFooter } from "./onboardingUi";

const ACCENT_SOLID = "var(--accent-solid)";
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

// Validation for the custom-endpoint add form. id + baseURL are required;
// key is optional (some self-hosted endpoints are keyless). Returns the
// reason it's invalid, or null when the draft is submittable.
type ProviderDraft = { id: string; name: string; baseURL: string; apiKey: string };

export function customDraftError(draft: ProviderDraft): string | null {
  if (!draft.id.trim()) return "Provider id is required.";
  if (!draft.baseURL.trim()) return "Base URL is required.";
  if (!/^https?:\/\//i.test(draft.baseURL.trim())) return "Base URL must start with http:// or https://.";
  return null;
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

  const submitCustom = async (
    draft: ProviderDraft,
    onDone: () => Promise<void>,
  ): Promise<string | null> => {
    try {
      const res = await window.api.opencodeSetProviders({
        upsert: [
          {
            id: draft.id.trim(),
            name: draft.name.trim() || draft.id.trim(),
            baseURL: draft.baseURL.trim(),
            apiKey: draft.apiKey,
            enabledModels: [],
          },
        ],
      });
      if (!res.ok) return res.error ?? "Couldn't save the provider.";
      try {
        await window.api.opencodeRestart();
      } catch (e) {
        return `Provider saved, but restarting opencode failed: ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
      await onDone();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  // Render nothing while the auto-skip path is in flight (the shell will
  // have already advanced). Returning null here is what keeps the user
  // from seeing a flash of the provider list before onContinue fires.
  if (autoSkipped) return null;

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
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
            <div key={s.id} className="border border-border rounded p-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-body text-text truncate">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-text-faint"> · {s.plan}</span>
                  </div>
                  <div className="text-label text-text-faint flex items-center gap-1.5 mt-0.5">
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
                    className="px-2.5 py-1.5 text-meta bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
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
            <CustomForm
              onDone={async () => {
                setShowCustom(false);
                await refresh();
              }}
              submit={submitCustom}
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

function CustomForm({
  onDone,
  submit,
}: {
  onDone: () => Promise<void>;
  submit: (draft: ProviderDraft, onDone: () => Promise<void>) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<ProviderDraft>({
    id: "",
    name: "",
    baseURL: "",
    apiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  const onSubmit = async () => {
    const draftErr = customDraftError(draft);
    if (draftErr) {
      setError(draftErr);
      return;
    }
    setBusy(true);
    setError(null);
    const err = await submit(draft, onDone);
    if (err) setError(err);
    setBusy(false);
  };

  return (
    <div className="rounded-md border border-border bg-bg-soft p-3 space-y-2.5">
      <div className="text-micro font-semibold uppercase text-text-faint">
        Add a custom provider
      </div>
      <CustomInput
        label="Provider id"
        placeholder="e.g. groq"
        value={draft.id}
        disabled={busy}
        onChange={(v) => set({ id: v })}
      />
      <CustomInput
        label="Name (optional)"
        placeholder="e.g. Groq"
        value={draft.name}
        disabled={busy}
        onChange={(v) => set({ name: v })}
      />
      <CustomInput
        label="Base URL"
        placeholder="https://api.groq.com/openai/v1"
        value={draft.baseURL}
        disabled={busy}
        onChange={(v) => set({ baseURL: v })}
      />
      <CustomInput
        label="API key (optional)"
        placeholder="key"
        value={draft.apiKey}
        type="password"
        disabled={busy}
        onChange={(v) => set({ apiKey: v })}
      />
      {error && (
        <div role="alert" className="text-meta" style={{ color: DANGER }}>
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={busy || !draft.id.trim() || !draft.baseURL.trim()}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-body font-medium text-on-accent transition-opacity disabled:opacity-40"
        style={{ background: ACCENT_SOLID }}
      >
        {busy ? "Adding…" : "Add provider"}
      </button>
    </div>
  );
}

function CustomInput(props: {
  label: string;
  placeholder: string;
  value: string;
  type?: "text" | "password";
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-label text-text-muted">{props.label}</span>
      <input
        type={props.type ?? "text"}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded bg-bg border border-border px-2.5 py-2 text-body text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

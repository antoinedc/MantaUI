import { useCallback, useEffect, useState } from "react";
import type { SubscriptionStatus } from "../shared/types";
import {
  canContinueProviders,
  customDraftError,
  type ProviderDraft,
} from "./providersStepLogic";
import { ConnectProvider } from "./ConnectProvider";
import { StepFooter } from "./onboardingUi";

// ProvidersStep.tsx — Step 2 (Providers) of the desktop onboarding shell
// (BET-49-T4, BET-315). Mounts into Onboarding.tsx's step-2 slot.
//
// Registry-driven (BET-315): one row per provider declared in
// src/server/subscriptionProviders.mjs. Rows come from the `status` action
// (the same source the Settings → Subscriptions card consumes, BET-314) — no
// provider id, label, or plan is hardcoded here. The hardcoded Anthropic /
// OpenAI / Custom cards and the deferred-Anthropic-sign-in hint block are
// gone; in-app Anthropic sign-in is now shipped via the shared
// <ConnectProvider> (BET-312), so Claude is just another row whose Connect
// button starts the OAuth flow.
//
// Each row's Connect button delegates to <ConnectProvider> with
// `confirmRestart={false}` — no sessions exist during onboarding, so the
// opencode restart that every connect ends on is free, and a confirm bar
// would be noise. Disconnect (and the destructive-confirm pattern from
// Settings) are deliberately NOT exposed here; BET-315's "Do not" list
// is explicit on that point. Settings handles reconnects later.
//
// Below the subscription rows sits a demoted custom-endpoint form: just a
// text link ("Use your own API endpoint instead") that reveals the existing
// add-a-custom-provider form. The form's validation (customDraftError) is
// unchanged; only its prominence moves.
//
// Continue is gated on ≥1 connected provider via `canContinueProviders`,
// fed by the `status` action — so a subscription connected seconds ago
// counts immediately (BET-315 deliverable 3). The gate is still correct:
// the same source that drives the badges drives the Step 3 model list, so
// a provider counted as connected here is one whose models appear in
// Step 3.
//
// This component owns its OWN footer (Back + Continue), like PairStep,
// because Continue must be gated on ≥1 connected provider — the shell's
// generic footer can't express that. The shell suppresses its footer for
// this step.
//
// Props:
//   onBack     — go to the previous step (Pair).
//   onContinue — advance to Step 3 (Model). Enabled once ≥1 provider connected.

const ACCENT = "#5A88FF";
const DANGER = "#FF7A88";
const SUCCESS = "#22C79A";

export function ProvidersStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const [statuses, setStatuses] = useState<SubscriptionStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Exactly one row can be mid-mutation at a time. Registry id (anthropic /
  // openai / kimi-for-coding); null when idle.
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // Custom-endpoint form is collapsed behind a link by default.
  const [showCustom, setShowCustom] = useState(false);

  // Refresh the live connected picture from the registry-backed `status`
  // action. The same call drives Settings → SubscriptionsCard (BET-314),
  // so an opencode restart triggered by either surface is visible to the
  // other after its next refresh.
  const refresh = useCallback(async () => {
    setLoadError(null);
    // Guard method existence (BET-254): if window.api was never swapped to
    // the httpApi client (regression), opencodeProviderAuth is undefined and
    // calling it throws a synchronous TypeError that bypasses .catch and
    // hangs the step. Surface the missing method via the existing error
    // state instead.
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
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setStatuses([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canContinue = canContinueProviders(statuses ?? []);

  // ConnectProvider fires `onDone(true)` on success; close the inline card
  // and refetch so the row flips to connected (and the Continue gate opens).
  const onConnectDone = useCallback(
    (_ok: boolean) => {
      setConnectingId(null);
      void refresh();
    },
    [refresh],
  );

  // Custom-form write path. The shared saveProviderAndRestart pattern from
  // the prior implementation is reproduced inline here because the only
  // remaining consumer is the custom form itself — pulling it back into a
  // shared helper would re-introduce a second call site for a one-call
  // function. Restart failure is non-fatal to the config write but still
  // surfaced (the card won't flip until a manual restart).
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

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Connect your subscriptions
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-6 max-w-md">
        Sign in with a subscription you already pay for. You can add more later.
      </p>

      {loadError && (
        <div role="alert" className="text-sm mb-4" style={{ color: DANGER }}>
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
                  <div className="text-sm text-text truncate">
                    <span className="font-medium">{s.label}</span>
                    <span className="text-text-faint"> · {s.plan}</span>
                  </div>
                  <div className="text-[11px] text-text-faint flex items-center gap-1.5 mt-0.5">
                    <span
                      aria-hidden
                      className={`inline-block w-1.5 h-1.5 rounded-full ${
                        s.connected ? "bg-green-400" : "bg-text-faint"
                      }`}
                    />
                    <span>{s.connected ? "connected" : "not connected"}</span>
                  </div>
                </div>
                {isConnecting ? null : s.connected ? (
                  <span
                    className="text-[11px] font-medium"
                    style={{ color: SUCCESS }}
                  >
                    ✓
                  </span>
                ) : (
                  <button
                    onClick={() => setConnectingId(s.id)}
                    disabled={anyConnecting}
                    className="px-2.5 py-1.5 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
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
          <div className="text-sm text-text-faint">
            No providers available.
          </div>
        )}
      </div>

      {/* Custom endpoint — demoted to a secondary link that reveals the form. */}
      <div className="mt-6">
        <button
          onClick={() => setShowCustom((v) => !v)}
          className="text-xs text-text-muted underline decoration-dotted hover:text-text"
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

// Custom endpoint add form. Same validation + write path as before — only
// its prominence in the step has changed. Kept as a local component so the
// step file remains the single owner of the add-a-custom-provider UX
// during onboarding; Settings' ProvidersCard handles the post-onboarding
// case separately.
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
      <div className="text-[11px] uppercase tracking-wider text-text-faint">
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
        <div role="alert" className="text-xs" style={{ color: DANGER }}>
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={busy || !draft.id.trim() || !draft.baseURL.trim()}
        className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
        style={{ background: ACCENT }}
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
      <span className="text-[11px] text-text-muted">{props.label}</span>
      <input
        type={props.type ?? "text"}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded bg-bg border border-border px-2.5 py-2 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

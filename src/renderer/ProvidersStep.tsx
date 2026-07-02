import { useCallback, useEffect, useState } from "react";
import type { DiscoverResult, OpencodeModel } from "../shared/types";
import {
  ANTHROPIC_ID,
  OPENAI_ID,
  OPENAI_BASE_URL,
  canContinueProviders,
  canSubmitProviderKey,
  isProviderConnected,
} from "./providersStepLogic";

// ProvidersStep.tsx — Step 2 (Providers) of the desktop onboarding shell
// (BET-49-T4). Mounts into Onboarding.tsx's step-2 slot.
//
// Cards: Anthropic / OpenAI / Custom (per docs/onboarding/mockup.html). The
// SINGLE source of connected state is opencode's `/provider` endpoint, surfaced
// as window.api.opencodeModels() (connected-only; NEVER /api/model — it leaks
// apiKey). A provider is "connected" iff at least one of its models appears in
// that list (see providersStepLogic.connectedProviderIds).
//
//   • Anthropic connected → "Connected" badge. NOT connected → a "requires setup
//     on the box" pointer (the device-login flow is EXPLICITLY out of scope —
//     flagged discuss-phase item in the parent; do not improvise it here).
//   • OpenAI: an API-key form. On submit we write the provider block via the
//     existing window.api.opencodeSetProviders(), restart opencode so /provider
//     re-reads credentials, then re-fetch models — the card flips to Connected.
//   • Custom: id / name / baseURL / apiKey form, same setProviders code path.
//
// Provider-auth failure surfaces as an inline error on THAT card only (never a
// global banner) so one broken key doesn't block the others.
//
// This component owns its own footer (Back + Continue) — like PairStep — because
// "Continue" is gated on ≥1 connected provider (canContinueProviders), which the
// shell's generic goNext footer can't express. The shell suppresses its footer
// for step 2 and lets us drive advancement.
//
// All non-React decisions (connected derivation, both gates, the key-form submit
// gate) live in providersStepLogic.ts (pure, unit-tested).

const ACCENT = "#7c9cff";
const DANGER = "#f87171";

type CardKey = typeof OPENAI_ID | "custom";

export function ProvidersStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  // null = still loading the first /provider read. [] = loaded, none connected.
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Which card's key form is expanded (only one at a time). null = none.
  const [openForm, setOpenForm] = useState<CardKey | null>(null);
  const [busy, setBusy] = useState<CardKey | null>(null);
  // Per-card inline error (keyed by card) — one broken key never blocks the rest.
  const [cardError, setCardError] = useState<Partial<Record<CardKey, string>>>({});

  // OpenAI form: just a key (id/name/baseURL are fixed).
  const [openaiKey, setOpenaiKey] = useState("");
  // Custom form: full id/name/baseURL/apiKey.
  const [custom, setCustom] = useState({ id: "", name: "", baseURL: "", apiKey: "" });

  const loadModels = useCallback(async () => {
    try {
      const list = await window.api.opencodeModels();
      setModels(list);
      setLoadError(null);
    } catch (e) {
      // A failed /provider read must not look like "nothing connected" — surface
      // it, and leave models as an empty list so the gate stays closed.
      setModels([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const anthropicConnected = isProviderConnected(models, ANTHROPIC_ID);
  const openaiConnected = isProviderConnected(models, OPENAI_ID);
  const canContinue = canContinueProviders(models);

  // Write a provider block, restart opencode so /provider re-reads credentials,
  // then re-fetch models so the card flips to Connected. Errors land inline on
  // the given card. Shared by the OpenAI and Custom forms (one code path).
  const connectProvider = useCallback(
    async (
      card: CardKey,
      input: { id: string; name: string; baseURL: string; apiKey: string },
    ) => {
      if (busy) return;
      setBusy(card);
      setCardError((e) => ({ ...e, [card]: undefined }));
      try {
        const res = await window.api.opencodeSetProviders({
          upsert: [
            {
              id: input.id.trim(),
              name: input.name.trim() || input.id.trim(),
              baseURL: input.baseURL.trim(),
              apiKey: input.apiKey,
              enabledModels: [],
            },
          ],
        });
        if (!res.ok) {
          setCardError((e) => ({ ...e, [card]: res.error ?? "Couldn't save this provider." }));
          return;
        }
        // Best-effort discovery so a bad key surfaces as an auth error on the
        // card rather than a silently-empty "still not connected" after restart.
        try {
          const disc: DiscoverResult = await window.api.opencodeDiscoverModels(
            input.baseURL.trim(),
            input.apiKey,
          );
          if (!disc.ok) {
            setCardError((e) => ({
              ...e,
              [card]: `${disc.error}${disc.detail ? `: ${disc.detail}` : ""}`,
            }));
            return;
          }
        } catch {
          // Discovery is advisory; the restart + re-read below is authoritative.
        }
        // Restart so opencode's /provider picks up the new credentials, then
        // re-read the connected set.
        try {
          await window.api.opencodeRestart();
        } catch (e) {
          setCardError((e2) => ({
            ...e2,
            [card]: `Saved, but restart failed: ${e instanceof Error ? e.message : String(e)}`,
          }));
          return;
        }
        await loadModels();
        setOpenForm(null);
      } catch (e) {
        setCardError((er) => ({ ...er, [card]: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(null);
      }
    },
    [busy, loadModels],
  );

  const submitOpenAI = () => {
    if (
      !canSubmitProviderKey({
        id: OPENAI_ID,
        baseURL: OPENAI_BASE_URL,
        apiKey: openaiKey,
        submitting: busy === OPENAI_ID,
      })
    )
      return;
    void connectProvider(OPENAI_ID, {
      id: OPENAI_ID,
      name: "OpenAI",
      baseURL: OPENAI_BASE_URL,
      apiKey: openaiKey,
    });
  };

  const submitCustom = () => {
    if (
      !canSubmitProviderKey({
        id: custom.id,
        baseURL: custom.baseURL,
        apiKey: custom.apiKey,
        submitting: busy === "custom",
      })
    )
      return;
    void connectProvider("custom", custom);
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Choose your providers
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        Select the AI providers you want to use. You can add more later.
      </p>

      {loadError && (
        <div role="alert" className="text-sm mb-4" style={{ color: DANGER }}>
          Couldn't read providers from the box: {loadError}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* Anthropic — read-only connected state; setup is out of scope. */}
        <div className="rounded-lg border border-border bg-bg-soft p-4">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-md flex items-center justify-center text-sm font-semibold shrink-0"
              style={{ background: "#1b1e25", color: ACCENT, border: "1px solid #262932" }}
            >
              A
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text">Anthropic</div>
              {models === null ? (
                <div className="text-xs text-text-faint">Checking…</div>
              ) : anthropicConnected ? (
                <div className="text-xs" style={{ color: "#22c55e" }}>
                  Connected
                </div>
              ) : (
                <div className="text-xs text-text-faint">Not connected</div>
              )}
            </div>
          </div>
          {models !== null && !anthropicConnected && (
            <div className="mt-3 rounded-md border border-dashed border-border p-3 text-xs text-text-muted leading-relaxed">
              Anthropic requires setup on the box — sign in to Claude there (e.g.
              via the opencode Claude auth flow), then reopen this step. bui can't
              complete Anthropic login from here.
            </div>
          )}
        </div>

        {/* OpenAI — enabled via an API-key form (mockup's disabled state was an
            artifact; see BET-48 note). */}
        <ProviderKeyCard
          letter="O"
          name="OpenAI"
          connected={openaiConnected}
          loading={models === null}
          open={openForm === OPENAI_ID}
          onToggle={() =>
            setOpenForm((f) => (f === OPENAI_ID ? null : OPENAI_ID))
          }
          error={cardError[OPENAI_ID]}
          busy={busy === OPENAI_ID}
        >
          <label className="text-[11px] font-medium text-text-muted">API key</label>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            value={openaiKey}
            disabled={busy === OPENAI_ID}
            onChange={(e) => setOpenaiKey(e.target.value)}
            className="w-full rounded-md bg-bg border border-border px-3 py-2 text-sm text-text font-mono outline-none focus:border-accent disabled:opacity-60"
          />
          <FormActions
            onSubmit={submitOpenAI}
            disabled={
              !canSubmitProviderKey({
                id: OPENAI_ID,
                baseURL: OPENAI_BASE_URL,
                apiKey: openaiKey,
                submitting: busy === OPENAI_ID,
              })
            }
            busy={busy === OPENAI_ID}
            label="Connect OpenAI"
          />
        </ProviderKeyCard>

        {/* Custom — id/name/baseURL/apiKey, same setProviders path. */}
        <ProviderKeyCard
          letter="+"
          name="Custom"
          connected={false}
          loading={false}
          statusOverride="Add provider"
          open={openForm === "custom"}
          onToggle={() => setOpenForm((f) => (f === "custom" ? null : "custom"))}
          error={cardError.custom}
          busy={busy === "custom"}
        >
          <div className="flex flex-col gap-2">
            <input
              placeholder="id (e.g. voska)"
              value={custom.id}
              disabled={busy === "custom"}
              onChange={(e) => setCustom((c) => ({ ...c, id: e.target.value }))}
              className="w-full rounded-md bg-bg border border-border px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-60"
            />
            <input
              placeholder="name (e.g. VoskaAI)"
              value={custom.name}
              disabled={busy === "custom"}
              onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))}
              className="w-full rounded-md bg-bg border border-border px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-60"
            />
            <input
              placeholder="baseURL (https://api.voska.org/v1)"
              value={custom.baseURL}
              disabled={busy === "custom"}
              onChange={(e) => setCustom((c) => ({ ...c, baseURL: e.target.value }))}
              className="w-full rounded-md bg-bg border border-border px-3 py-2 text-sm text-text font-mono outline-none focus:border-accent disabled:opacity-60"
            />
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="API key"
              value={custom.apiKey}
              disabled={busy === "custom"}
              onChange={(e) => setCustom((c) => ({ ...c, apiKey: e.target.value }))}
              className="w-full rounded-md bg-bg border border-border px-3 py-2 text-sm text-text font-mono outline-none focus:border-accent disabled:opacity-60"
            />
            <FormActions
              onSubmit={submitCustom}
              disabled={
                !canSubmitProviderKey({
                  id: custom.id,
                  baseURL: custom.baseURL,
                  apiKey: custom.apiKey,
                  submitting: busy === "custom",
                })
              }
              busy={busy === "custom"}
              label="Add provider"
            />
          </div>
        </ProviderKeyCard>
      </div>

      {/* Own footer — Back + Continue (gated on ≥1 connected provider). */}
      <div className="flex items-center justify-between gap-3 mt-8">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-md text-sm text-text-muted hover:text-text transition-colors"
        >
          <BackArrow />
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!canContinue}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
          style={{ background: ACCENT }}
        >
          Continue
          <FwdArrow />
        </button>
      </div>
    </div>
  );
}

// A provider card whose body (an API-key form) expands when tapped. Anthropic
// doesn't use this (it's read-only); OpenAI + Custom do.
function ProviderKeyCard({
  letter,
  name,
  connected,
  loading,
  statusOverride,
  open,
  onToggle,
  error,
  busy,
  children,
}: {
  letter: string;
  name: string;
  connected: boolean;
  loading: boolean;
  statusOverride?: string;
  open: boolean;
  onToggle: () => void;
  error?: string;
  busy: boolean;
  children: React.ReactNode;
}) {
  const status = loading
    ? "Checking…"
    : connected
      ? "Connected"
      : statusOverride ?? "Not connected";
  const statusColor = connected ? "#22c55e" : "#6b7280";
  return (
    <div className="rounded-lg border border-border bg-bg-soft p-4">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-expanded={open}
        className="w-full flex items-center gap-3 text-left disabled:opacity-60"
      >
        <div
          className="w-9 h-9 rounded-md flex items-center justify-center text-sm font-semibold shrink-0"
          style={{ background: "#1b1e25", color: ACCENT, border: "1px solid #262932" }}
        >
          {letter}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text">{name}</div>
          <div className="text-xs" style={{ color: statusColor }}>
            {status}
          </div>
        </div>
      </button>
      {error && (
        <div role="alert" className="mt-2 text-xs" style={{ color: DANGER }}>
          {error}
        </div>
      )}
      {open && <div className="mt-3 flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function FormActions({
  onSubmit,
  disabled,
  busy,
  label,
}: {
  onSubmit: () => void;
  disabled: boolean;
  busy: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onSubmit}
      disabled={disabled}
      className="self-start inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
      style={{ background: ACCENT }}
    >
      {busy ? "Connecting…" : label}
    </button>
  );
}

function BackArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function FwdArrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

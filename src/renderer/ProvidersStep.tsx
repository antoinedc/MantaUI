import { useCallback, useEffect, useState } from "react";
import type { OpencodeModel, ProviderEndpoint } from "../shared/types";
import {
  ANTHROPIC_ID,
  OPENAI_ID,
  OPENAI_BASE_URL,
  canContinueProviders,
  connectedProviderIds,
  customDraftError,
  openaiKeyError,
  type ProviderDraft,
} from "./providersStepLogic";

// ProvidersStep.tsx — Step 2 (Providers) of the desktop onboarding shell
// (BET-49-T4). Mounts into Onboarding.tsx's step-2 slot.
//
// Shows three cards per docs/onboarding/mockup.html — Anthropic / OpenAI /
// Custom — reflecting LIVE connected state:
//   • "connected" is derived from opencode's own served-model list
//     (window.api.opencodeModels()), which main builds from GET /provider
//     filtered by `connected[]` (opencode.ts:listModels). We deliberately do
//     NOT call /api/model (it embeds apiKey) — reused audit point.
//   • Anthropic connects via the box's Claude-auth plugin; when it isn't
//     connected we show a "requires setup on the box" pointer. Driving the
//     device-login flow from the desktop is EXPLICITLY OUT OF SCOPE (parent
//     BET-49 "Anthropic OAuth addendum") — we do not improvise it here.
//   • OpenAI / Custom are added through the EXISTING providers.ts write path
//     (window.api.opencodeSetProviders → setProviders/upsertProviderBlock).
//     No new provider-fetch code paths.
//
// After a successful add we restart opencode (opencodeRestart) so `/provider`
// re-auths and the new provider shows as connected + surfaces its models to
// Step 3 — otherwise the just-added key wouldn't count toward the ≥1-connected
// Continue gate.
//
// This component owns its OWN footer (Back + Continue), like PairStep, because
// Continue must be gated on ≥1 connected provider — the shell's generic footer
// can't express that. The shell suppresses its footer for this step.
//
// Props:
//   onBack     — go to the previous step (Pair).
//   onContinue — advance to Step 3 (Model). Enabled once ≥1 provider connected.

const ACCENT = "#7c9cff";
const DANGER = "#f87171";
const SUCCESS = "#4ade80";

type AddForm = null | "openai" | "custom";

export function ProvidersStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [endpoints, setEndpoints] = useState<ProviderEndpoint[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Reload the live connected picture (served models + configured endpoints).
  // opencodeModels drives the connected badges + the Continue gate; endpoints
  // tells us whether an OpenAI block already exists so the card reflects it.
  const load = useCallback(async () => {
    setLoadError(null);
    const [m, eps] = await Promise.all([
      window.api.opencodeModels().catch(() => {
        setLoadError("Couldn't reach the box to check providers.");
        return [] as OpencodeModel[];
      }),
      window.api.opencodeGetProviders().catch(() => [] as ProviderEndpoint[]),
    ]);
    setModels(m);
    setEndpoints(eps);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const connected = connectedProviderIds(models ?? []);
  const canContinue = canContinueProviders(models ?? []);

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
          {loadError}{" "}
          <button onClick={() => void load()} className="underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* Provider cards row (Anthropic / OpenAI / Custom). */}
      <ProviderCards
        loading={models === null}
        connected={connected}
        openaiConfigured={endpoints.some((e) => e.id === OPENAI_ID)}
        onReload={load}
      />

      {/* Footer: Back (left) + Continue (right). Continue gated on ≥1 connected. */}
      <div className="flex items-center justify-between gap-3 mt-8">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-md text-sm text-text-muted hover:text-text transition-colors"
        >
          <ArrowLeft />
          Back
        </button>
        <button
          onClick={onContinue}
          disabled={!canContinue}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
          style={{ background: ACCENT }}
        >
          Continue
          <ArrowRight />
        </button>
      </div>
    </div>
  );
}

function ProviderCards({
  loading,
  connected,
  openaiConfigured,
  onReload,
}: {
  loading: boolean;
  connected: Set<string>;
  openaiConfigured: boolean;
  onReload: () => Promise<void>;
}) {
  const [form, setForm] = useState<AddForm>(null);

  return (
    <div className="space-y-3">
      <div className="flex gap-2.5">
        <ProviderCard
          letter="A"
          name="Anthropic"
          connected={connected.has(ANTHROPIC_ID)}
          statusConnected="Connected"
          statusDisconnected="Requires setup on the box"
          loading={loading}
          onClick={undefined}
        />
        <ProviderCard
          letter="O"
          name="OpenAI"
          connected={connected.has(OPENAI_ID)}
          statusConnected="Connected"
          statusDisconnected={openaiConfigured ? "Key added — restart pending" : "Add API key"}
          loading={loading}
          onClick={() => setForm((f) => (f === "openai" ? null : "openai"))}
          active={form === "openai"}
        />
        <ProviderCard
          plus
          name="Custom"
          connected={false}
          statusConnected="Add provider"
          statusDisconnected="Add provider"
          loading={loading}
          onClick={() => setForm((f) => (f === "custom" ? null : "custom"))}
          active={form === "custom"}
        />
      </div>

      {/* Anthropic-not-connected pointer (device-login flow is out of scope). */}
      {!loading && !connected.has(ANTHROPIC_ID) && (
        <div className="rounded-md border border-border bg-bg-soft px-3 py-2.5 text-xs text-text-muted leading-relaxed">
          Anthropic isn't connected yet. Sign in to Claude on the box (e.g.{" "}
          <code className="rounded bg-bg px-1.5 py-0.5 text-[11px] text-text-muted">
            opencode auth login
          </code>
          ), then reopen this step. In-app Anthropic sign-in is coming soon.
        </div>
      )}

      {form === "openai" && (
        <OpenAiForm
          onDone={async () => {
            setForm(null);
            await onReload();
          }}
        />
      )}
      {form === "custom" && (
        <CustomForm
          onDone={async () => {
            setForm(null);
            await onReload();
          }}
        />
      )}
    </div>
  );
}

function ProviderCard({
  letter,
  plus,
  name,
  connected,
  statusConnected,
  statusDisconnected,
  loading,
  onClick,
  active,
}: {
  letter?: string;
  plus?: boolean;
  name: string;
  connected: boolean;
  statusConnected: string;
  statusDisconnected: string;
  loading: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  const clickable = onClick !== undefined;
  const status = loading ? "Checking…" : connected ? statusConnected : statusDisconnected;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className="flex-1 flex flex-col items-center gap-3 rounded-md border p-4 text-center transition-colors disabled:cursor-default"
      style={{
        borderColor: connected || active ? ACCENT : "#262932",
        background: connected || active ? "#1b1e25" : "transparent",
        boxShadow: connected || active ? `0 0 0 3px rgba(124,156,255,0.15)` : undefined,
      }}
    >
      <div
        className="w-10 h-10 rounded flex items-center justify-center text-base font-bold"
        style={{
          background: connected ? ACCENT : "#14161b",
          border: `1.5px solid ${connected ? ACCENT : "#262932"}`,
          color: connected ? "#0e0f12" : "#9aa0aa",
        }}
      >
        {plus ? <PlusIcon /> : letter}
      </div>
      <div>
        <div className="text-[13px] font-semibold text-text">{name}</div>
        <div
          className="text-[11px] mt-0.5"
          style={{ color: connected ? SUCCESS : "#6b7280" }}
        >
          {status}
        </div>
      </div>
    </button>
  );
}

// OpenAI: only a key is needed (baseURL pinned to OPENAI_BASE_URL). Writes via
// the existing setProviders path, then restarts opencode so the key auths and
// the card flips to connected.
function OpenAiForm({ onDone }: { onDone: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const keyErr = openaiKeyError(apiKey);
    if (keyErr) {
      setError(keyErr);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.opencodeSetProviders({
        upsert: [
          {
            id: OPENAI_ID,
            name: "OpenAI",
            baseURL: OPENAI_BASE_URL,
            apiKey: apiKey.trim(),
            enabledModels: [],
          },
        ],
      });
      if (!res.ok) {
        setError(res.error ?? "Couldn't save the OpenAI key.");
        return;
      }
      // Restart so /provider re-auths and OpenAI shows as connected + its
      // models reach Step 3. Failure here is non-fatal to the config write,
      // but surface it (the card just won't flip until a manual restart).
      try {
        await window.api.opencodeRestart();
      } catch (e) {
        setError(
          `Key saved, but restarting opencode failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardForm title="Connect OpenAI" error={error}>
      <PasswordInput
        label="API key"
        placeholder="sk-…"
        value={apiKey}
        disabled={busy}
        onChange={(v) => {
          setApiKey(v);
          setError(null);
        }}
      />
      <FormSubmit busy={busy} disabled={!apiKey.trim()} onClick={submit}>
        {busy ? "Connecting…" : "Connect"}
      </FormSubmit>
    </CardForm>
  );
}

// Custom: id/name/baseURL/apiKey — same setProviders code path as OpenAI.
function CustomForm({ onDone }: { onDone: () => Promise<void> }) {
  const [draft, setDraft] = useState<ProviderDraft>({ id: "", name: "", baseURL: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  const submit = async () => {
    const draftErr = customDraftError(draft);
    if (draftErr) {
      setError(draftErr);
      return;
    }
    setBusy(true);
    setError(null);
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
      if (!res.ok) {
        setError(res.error ?? "Couldn't save the provider.");
        return;
      }
      try {
        await window.api.opencodeRestart();
      } catch (e) {
        setError(
          `Provider saved, but restarting opencode failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardForm title="Add a custom provider" error={error}>
      <TextInput label="Provider id" placeholder="e.g. groq" value={draft.id} disabled={busy} onChange={(v) => set({ id: v })} />
      <TextInput label="Name (optional)" placeholder="e.g. Groq" value={draft.name} disabled={busy} onChange={(v) => set({ name: v })} />
      <TextInput label="Base URL" placeholder="https://api.groq.com/openai/v1" value={draft.baseURL} disabled={busy} onChange={(v) => set({ baseURL: v })} />
      <PasswordInput label="API key (optional)" placeholder="key" value={draft.apiKey} disabled={busy} onChange={(v) => set({ apiKey: v })} />
      <FormSubmit busy={busy} disabled={!draft.id.trim() || !draft.baseURL.trim()} onClick={submit}>
        {busy ? "Adding…" : "Add provider"}
      </FormSubmit>
    </CardForm>
  );
}

// ── Small shared form primitives (local to this step; not exported) ──────────

function CardForm({
  title,
  error,
  children,
}: {
  title: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-soft p-3 space-y-2.5">
      <div className="text-[11px] uppercase tracking-wider text-text-faint">{title}</div>
      {children}
      {error && (
        <div role="alert" className="text-xs" style={{ color: DANGER }}>
          {error}
        </div>
      )}
    </div>
  );
}

function TextInput({
  label,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-muted">{label}</span>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded bg-bg border border-border px-2.5 py-2 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

function PasswordInput(props: {
  label: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-muted">{props.label}</span>
      <input
        type="password"
        autoComplete="off"
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded bg-bg border border-border px-2.5 py-2 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

function FormSubmit({
  busy,
  disabled,
  onClick,
  children,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-sm font-medium text-bg transition-opacity disabled:opacity-40"
      style={{ background: ACCENT }}
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function ArrowLeft() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

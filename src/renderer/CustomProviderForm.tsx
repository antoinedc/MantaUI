// CustomProviderForm.tsx — BET-421 §D. The single shared "add a custom
// OpenAI-compatible provider" form used by BOTH the onboarding ProvidersStep
// AND Settings → Accounts (ProvidersCard). Per the issue, the four sign-in
// shapes are NOT the same — Custom is the only one that's a plain endpoint —
// so it gets its own component rather than being folded into ConnectProvider.
//
// Behaviour (BET-421 §D):
//   - The provider id is DERIVED from the name (slugifyProviderId), never
//     asked for. opencode ids are ASCII-safe keys persisted in opencode.jsonc.
//   - The endpoint is PROBED before saving: opencodeDiscoverModels(baseURL,
//     apiKey) is called and the models the endpoint actually reports are
//     shown as a checklist (all pre-checked). Save is disabled until a probe
//     succeeds — a dead/keyless/unreachable endpoint can't be saved blind.
//   - On save: opencodeSetProviders upsert with the checked model ids, then
//     opencodeRestart so /provider re-auths, then onSaved().
//
// The shared validator (customProviderDraftError) and id derivation
// (slugifyProviderId) live in chatUtils.ts so both this form and any future
// caller share one source of truth.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { DiscoverResult } from "../shared/types";
import {
  slugifyProviderId,
  customProviderDraftError,
} from "./chatUtils";
import { Field } from "./Field";
import { Checkbox } from "./Checkbox";

const ACCENT_SOLID = "var(--accent-solid)";
const DANGER = "var(--danger)";

type Phase = "editing" | "probing" | "ready";

export function CustomProviderForm({
  onSaved,
  compact = false,
}: {
  onSaved: () => Promise<void> | void;
  /** compact: Settings card styling (tighter padding, smaller labels). */
  compact?: boolean;
}) {
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<{ id: string }[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const derivedId = slugifyProviderId(name);
  const draftErr = customProviderDraftError({ name, baseURL });

  const reset = () => {
    setPhase("editing");
    setModels(null);
    setChecked(new Set());
    setError(null);
  };

  const probe = async () => {
    if (draftErr) {
      setError(draftErr);
      return;
    }
    setPhase("probing");
    setError(null);
    setModels(null);
    setChecked(new Set());
    try {
      const r: DiscoverResult = await window.api.opencodeDiscoverModels(
        baseURL.trim(),
        apiKey,
      );
      if (!r.ok) {
        setError(
          `${r.error === "unreachable" ? "Couldn't reach the endpoint" : r.error === "unauthorized" ? "The endpoint rejected the key" : "The endpoint didn't return a model list"}${r.detail ? `: ${r.detail}` : ""}`,
        );
        setPhase("editing");
        return;
      }
      setModels(r.models);
      setChecked(new Set(r.models.map((m) => m.id)));
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("editing");
    }
  };

  const toggle = (id: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (phase !== "ready" || !models) return;
    if (checked.size === 0) {
      setError("Select at least one model.");
      return;
    }
    setPhase("probing"); // reuse the busy flag for the save call
    setError(null);
    try {
      const res = await window.api.opencodeSetProviders({
        upsert: [
          {
            id: derivedId,
            name: name.trim(),
            baseURL: baseURL.trim(),
            apiKey,
            enabledModels: [...checked],
          },
        ],
      });
      if (!res.ok) {
        setError(res.error ?? "Couldn't save the provider.");
        setPhase("ready");
        return;
      }
      try {
        await window.api.opencodeRestart();
      } catch (e) {
        setError(
          `Provider saved, but restarting opencode failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        setPhase("ready");
        return;
      }
      setName("");
      setBaseURL("");
      setApiKey("");
      reset();
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("ready");
    }
  };

  const busy = phase === "probing";

  if (compact) {
    return (
      <div className="border border-dashed border-border rounded-xs p-2 space-y-1">
        <div className="text-micro font-semibold uppercase text-text-faint">
          Add endpoint
        </div>
        <CustomInput
          placeholder="name (e.g. VoskaAI)"
          value={name}
          disabled={busy}
          onChange={setName}
          onReset={phase !== "editing" ? reset : undefined}
        />
        <CustomInput
          placeholder="baseURL (https://api.voska.org/v1)"
          value={baseURL}
          disabled={busy}
          onChange={setBaseURL}
        />
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="API key (optional)"
          value={apiKey}
          disabled={busy}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full bg-bg-soft border border-border px-2 py-1 text-meta rounded-xs"
        />
        {derivedId && (
          <div className="text-micro text-text-faint">
            id: <code>{derivedId}</code>
          </div>
        )}
        {error && <div className="text-meta text-danger">{error}</div>}
        {phase === "ready" && models && (
          <ModelList
            models={models}
            checked={checked}
            onToggle={toggle}
            disabled={busy}
          />
        )}
        <div className="flex gap-2 pt-1">
          {phase !== "ready" ? (
            <button
              onClick={() => void probe()}
              disabled={busy || draftErr !== null}
              className="px-3 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
            >
              {busy ? "Probing…" : "Probe"}
            </button>
          ) : (
            <button
              onClick={() => void save()}
              disabled={busy || checked.size === 0}
              className="px-3 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
            >
              {busy ? "Saving…" : `Save ${checked.size} model${checked.size === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-border bg-bg-soft p-3 space-y-3">
      <div className="text-micro font-semibold uppercase text-text-faint">
        Add a custom provider
      </div>
      <CustomInput
        label="Name"
        placeholder="e.g. VoskaAI"
        value={name}
        disabled={busy}
        onChange={setName}
        onReset={phase !== "editing" ? reset : undefined}
      />
      {derivedId && (
        <div className="text-meta text-text-faint -mt-1">
          Provider id: <code className="text-text-muted">{derivedId}</code>
        </div>
      )}
      <CustomInput
        label="Base URL"
        placeholder="https://api.voska.org/v1"
        value={baseURL}
        disabled={busy}
        onChange={setBaseURL}
      />
      <CustomInput
        label="API key (optional)"
        placeholder="key"
        value={apiKey}
        type="password"
        disabled={busy}
        onChange={setApiKey}
      />
      {error && (
        <div role="alert" className="text-meta" style={{ color: DANGER }}>
          {error}
        </div>
      )}
      {phase === "ready" && models && (
        <ModelList
          models={models}
          checked={checked}
          onToggle={toggle}
          disabled={busy}
        />
      )}
      <div className="flex items-center gap-2">
        {phase !== "ready" ? (
          <button
            type="button"
            onClick={() => void probe()}
            disabled={busy || draftErr !== null}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-sm text-body font-medium text-on-accent transition-opacity disabled:opacity-40"
            style={{ background: ACCENT_SOLID }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {busy ? "Probing…" : "Probe endpoint"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || checked.size === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-sm text-body font-medium text-on-accent transition-opacity disabled:opacity-40"
            style={{ background: ACCENT_SOLID }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {busy ? "Saving…" : `Save ${checked.size} model${checked.size === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}

function ModelList({
  models,
  checked,
  onToggle,
  disabled,
}: {
  models: { id: string }[];
  checked: Set<string>;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-meta text-text-muted">
        {models.length} model{models.length === 1 ? "" : "s"} found — uncheck any you don't want.
      </div>
      <div className="max-h-40 overflow-auto rounded-xs border border-border bg-bg p-2 space-y-1">
        {models.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-2 text-meta"
          >
            <Checkbox
              checked={checked.has(m.id)}
              onChange={() => onToggle(m.id)}
              disabled={disabled}
              ariaLabel={m.id}
            />
            <span className="text-text-muted">{m.id}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomInput(props: {
  label?: string;
  placeholder: string;
  value: string;
  type?: "text" | "password";
  disabled: boolean;
  onChange: (v: string) => void;
  onReset?: () => void;
}) {
  return (
    <Field
      label={props.label}
      ariaLabel={props.placeholder}
      placeholder={props.placeholder}
      value={props.value}
      type={props.type ?? "text"}
      mono={false}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
      footer={
        props.onReset ? (
          <button
            type="button"
            onClick={props.onReset}
            className="text-micro text-text-faint underline decoration-dotted hover:text-text self-start"
          >
            Edit details
          </button>
        ) : undefined
      }
    />
  );
}

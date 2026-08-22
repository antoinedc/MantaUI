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
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { DiscoverResult } from "../shared/types";
import {
  slugifyProviderId,
  customProviderDraftError,
} from "./chatUtils";
import { Field } from "./Field";
import { Button } from "./Button";
import { ModelChecklist } from "./ModelChecklist";

type Phase = "editing" | "probing" | "ready";

export function CustomProviderForm({
  onSaved,
}: {
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  // Names the slow part of save() so the button can announce it: "Saving…"
  // while the provider is written, then "Restarting opencode…" (BET-1009).
  const [saveStep, setSaveStep] = useState<"save" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<{ id: string }[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const derivedId = slugifyProviderId(name);
  const draftErr = customProviderDraftError({ name, baseURL });

  const reset = () => {
    setPhase("editing");
    setSaveStep(null);
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

  const bulkChange = (ids: string[], next: boolean) => {
    setChecked((s) => {
      const out = new Set(s);
      for (const id of ids) next ? out.add(id) : out.delete(id);
      return out;
    });
  };

  const save = async () => {
    if (phase !== "ready" || !models) return;
    if (checked.size === 0) {
      setError("Select at least one model.");
      return;
    }
    setPhase("probing"); // keep the busy flag for disabling
    setError(null);
    try {
      setSaveStep("save");
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
        setSaveStep(null);
        return;
      }
      setSaveStep("restart");
      try {
        await window.api.opencodeRestart();
      } catch (e) {
        setError(
          `Provider saved, but restarting opencode failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        setPhase("ready");
        setSaveStep(null);
        return;
      }
      // Stay busy (and mounted) until the parent's re-probe resolves — clearing
      // first is what left a blank gap while opencode was still restarting.
      await onSaved();
      setName("");
      setBaseURL("");
      setApiKey("");
      setSaveStep(null);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("ready");
      setSaveStep(null);
    }
  };

  const busy = phase === "probing";
  const inSave = saveStep !== null;

  return (
    <div className="rounded-md border border-dashed border-border p-4 space-y-3">
      <div className="text-micro font-semibold uppercase text-text-faint">
        Add endpoint
      </div>
      <CustomInput
        label="Name"
        placeholder="e.g. VoskaAI"
        value={name}
        disabled={busy}
        onChange={setName}
        onReset={phase !== "editing" ? reset : undefined}
        help={
          derivedId ? (
            <>
              Provider id: <code className="text-text-muted">{derivedId}</code>
            </>
          ) : undefined
        }
      />
      <CustomInput
        label="Base URL"
        placeholder="https://api.voska.org/v1"
        value={baseURL}
        disabled={busy}
        onChange={setBaseURL}
      />
      <CustomInput
        label="API key (optional)"
        placeholder="sk-…"
        value={apiKey}
        type="password"
        autoComplete="off"
        disabled={busy}
        onChange={setApiKey}
      />
      {error && (
        <div role="alert" className="text-meta text-danger">
          {error}
        </div>
      )}
      {phase === "ready" && models && (
        <ModelChecklist
          models={models}
          checked={checked}
          onToggle={toggle}
          disabled={busy}
          onBulkChange={bulkChange}
        />
      )}
      <div className="flex items-center gap-2">
        {inSave || phase === "ready" ? (
          <Button
            tone="primary"
            type="button"
            onClick={() => void save()}
            disabled={busy || checked.size === 0}
          >
            {inSave ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {saveStep === "save" ? "Saving…" : saveStep === "restart" ? "Restarting opencode…" : `Save ${checked.size} model${checked.size === 1 ? "" : "s"}`}
          </Button>
        ) : (
          <Button
            tone="primary"
            type="button"
            onClick={() => void probe()}
            disabled={busy || draftErr !== null}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {busy ? "Probing…" : "Probe endpoint"}
          </Button>
        )}
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
  autoComplete?: string;
  help?: ReactNode;
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
      autoComplete={props.autoComplete}
      help={props.help}
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

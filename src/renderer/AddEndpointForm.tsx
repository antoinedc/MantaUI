// BET-420 — ONE add-endpoint form with ONE validator, shared by Settings
// (Accounts section) and onboarding (ProvidersStep). Both surfaces must
// reject a scheme-less URL identically. Previously the Settings form
// (ProvidersCard) accepted any non-empty string while only the onboarding
// form checked the http(s):// scheme — they drifted.
//
// This file owns the form markup + the validator. The actual save (and
// whether a restart follows) is the caller's job, passed as `onAdd`, so
// Settings can route the restart through the panel-level banner while
// onboarding restarts inline as it always has.

import { useState } from "react";

export type EndpointDraft = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
};

export const EMPTY_ENDPOINT_DRAFT: EndpointDraft = {
  id: "",
  name: "",
  baseURL: "",
  apiKey: "",
};

/**
 * Validate an endpoint draft. Returns the reason it's invalid, or null when
 * the draft is submittable. id + baseURL are required; key is optional (some
 * self-hosted endpoints are keyless). The baseURL MUST carry an http:// or
 * https:// scheme — this is the check that was missing on the Settings side.
 */
export function validateEndpointDraft(d: EndpointDraft): string | null {
  if (!d.id.trim()) return "Provider id is required.";
  if (!d.baseURL.trim()) return "Base URL is required.";
  if (!/^https?:\/\//i.test(d.baseURL.trim())) {
    return "Base URL must start with http:// or https://.";
  }
  return null;
}

export function AddEndpointForm({
  onAdd,
  busy,
}: {
  /** Save the draft. Return an error string on failure, or null on success. */
  onAdd: (draft: EndpointDraft) => Promise<string | null>;
  busy: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<EndpointDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  const submit = async () => {
    const draftErr = validateEndpointDraft(draft);
    if (draftErr) {
      setError(draftErr);
      return;
    }
    setError(null);
    const err = await onAdd(draft);
    if (err) {
      setError(err);
      return;
    }
    setDraft(EMPTY_ENDPOINT_DRAFT);
  };

  const canSubmit =
    !busy && draft.id.trim().length > 0 && draft.baseURL.trim().length > 0;

  return (
    <div className="rounded-md border border-dashed border-border bg-bg-soft p-3 space-y-3">
      <div className="text-micro font-semibold uppercase text-text-faint">
        Add a custom endpoint
      </div>
      <EndpointInput
        label="Provider id"
        placeholder="e.g. groq"
        value={draft.id}
        disabled={busy}
        onChange={(v) => set({ id: v })}
      />
      <EndpointInput
        label="Name (optional)"
        placeholder="e.g. Groq"
        value={draft.name}
        disabled={busy}
        onChange={(v) => set({ name: v })}
      />
      <EndpointInput
        label="Base URL"
        placeholder="https://api.groq.com/openai/v1"
        value={draft.baseURL}
        disabled={busy}
        onChange={(v) => set({ baseURL: v })}
      />
      <EndpointInput
        label="API key (optional)"
        placeholder="key"
        value={draft.apiKey}
        type="password"
        disabled={busy}
        onChange={(v) => set({ apiKey: v })}
      />
      {error && (
        <div role="alert" className="text-meta text-danger">
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="px-3 py-1 text-meta bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? "Adding…" : "Add endpoint"}
      </button>
    </div>
  );
}

function EndpointInput(props: {
  label: string;
  placeholder: string;
  value: string;
  type?: "text" | "password";
  disabled: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
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
        className="w-full rounded bg-bg border border-border px-3 py-2 text-body text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

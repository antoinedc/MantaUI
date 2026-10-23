// ===== SecretEditor =====
//
// The inline editor for ONE secret, shared by the chat popover's SecretsCard
// and Settings → Secrets (spec: docs/superpowers/specs/2026-10-23-secrets-edit-
// and-settings.md). Name + hint are editable text; the VALUE is never shown —
// it is locked behind "Replace value…", which swaps in an empty password input
// (and "Keep current" backs out). Scope is a read-only badge: scope and owner
// are immutable here.
//
// Every press reports its outcome: a failed save shows the server's error
// inline and stays open; success clears the draft value and closes.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Lock } from "lucide-react";
import type { SecretMeta, SecretPatch } from "../shared/types";
import { Button } from "./Button";
import { MetaBadge } from "./chatShared";
import { editorState, relativeAge } from "./secretsView";

const INPUT =
  "w-full min-w-0 rounded-xs border bg-bg px-2 py-1 text-text outline-none focus:border-accent";

export function secretScopeLabel(s: Pick<SecretMeta, "scope" | "project">): string {
  return s.scope === "shared" ? "shared" : s.scope === "project" ? `project:${s.project ?? "?"}` : "session";
}

export type SecretSaveResult = { ok: boolean; error?: string };

export function SecretEditor({
  secret,
  now,
  layout = "stack",
  overriddenIn = 0,
  onSave,
  onClose,
  onDelete,
}: {
  secret: SecretMeta;
  now: number;
  /** "stack": narrow popover. "grid": name + hint side by side (Settings). */
  layout?: "stack" | "grid";
  /** Sessions that shadow this secret with a same-named one (Settings only). */
  overriddenIn?: number;
  onSave: (patch: SecretPatch) => Promise<SecretSaveResult>;
  /** Cancel, Esc, or after a successful save. */
  onClose: () => void;
  /** When given, a Delete button is shown (the caller owns the confirm). */
  onDelete?: () => void;
}) {
  const [key, setKey] = useState(secret.key);
  const [hint, setHint] = useState(secret.hint ?? "");
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    if (replacing) valueRef.current?.focus();
  }, [replacing]);

  const st = editorState(secret, { key, hint, replacing, value });
  const canSave = st.canSave && !saving;

  const submit = () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    onSave(st.patch)
      .then((r) => {
        if (r.ok) {
          setValue("");
          setReplacing(false);
          onClose();
        } else {
          setError(r.error || "Couldn't save this secret.");
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't save this secret."))
      .finally(() => setSaving(false));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!saving) onClose();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      submit();
    }
  };

  const nameInput = (
    <input
      ref={nameRef}
      value={key}
      onChange={(e) => { setKey(e.target.value); setError(null); }}
      aria-label="Secret name"
      aria-invalid={st.keyError ? true : undefined}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className={`${INPUT} font-mono ${st.keyError ? "border-danger/60" : "border-border"}`}
    />
  );
  const hintInput = (
    <input
      value={hint}
      onChange={(e) => { setHint(e.target.value); setError(null); }}
      aria-label="Hint for the agent"
      placeholder="hint for the agent (optional)"
      className={`${INPUT} border-border`}
    />
  );
  const valueRow = (
    <div className="flex items-center gap-2 rounded-xs border border-dashed border-border bg-bg px-2 py-1">
      {replacing ? (
        <>
          <input
            ref={valueRef}
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            aria-label="New value"
            placeholder="new value (stored on the server; never shown again)"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent font-mono text-text outline-none"
          />
          <button
            type="button"
            onClick={() => { setReplacing(false); setValue(""); }}
            className="shrink-0 rounded-xs px-2 py-px text-text-faint hover:text-text"
          >
            Keep current
          </button>
        </>
      ) : (
        <>
          <Lock size={13} aria-hidden="true" className="shrink-0 text-text-faint" />
          <span aria-hidden="true" className="font-mono tracking-widest text-text-faint">••••••••••••</span>
          <span className="min-w-0 flex-1 truncate text-label text-text-faint">
            stored{secret.updatedAt ? ` · set ${relativeAge(secret.updatedAt, now, true)}` : ""}
          </span>
          <button
            type="button"
            onClick={() => setReplacing(true)}
            className="shrink-0 rounded-xs border px-2 py-px text-accent-tx"
            style={{ borderColor: "rgb(var(--accent-rgb) / 0.55)" }}
          >
            Replace value…
          </button>
        </>
      )}
    </div>
  );

  return (
    <div
      data-esc-owned
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2 rounded-sm border px-3 py-2"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.45)", backgroundColor: "rgb(var(--accent-rgb) / 0.06)" }}
    >
      {layout === "grid" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            {nameInput}
            <MetaBadge>{secretScopeLabel(secret)}</MetaBadge>
          </div>
          {hintInput}
          <div className="col-span-2">{valueRow}</div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            {nameInput}
            <MetaBadge>{secretScopeLabel(secret)}</MetaBadge>
          </div>
          {valueRow}
          {hintInput}
        </>
      )}

      {st.keyError && <div role="alert" className="text-label text-danger">{st.keyError}</div>}
      {st.renamed && !st.keyError && (
        <div className="rounded-xs border border-warn/40 bg-warn-bg px-2 py-1 text-label text-warn">
          Renaming <span className="font-mono">{secret.key}</span> → <span className="font-mono">{key}</span>.
          Agents or notes that ask for the old name won&apos;t find it.
        </div>
      )}
      {error && <div role="alert" className="break-words text-label text-danger">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label text-text-faint">
          {overriddenIn > 0
            ? `Overridden in ${overriddenIn} session${overriddenIn === 1 ? "" : "s"} · `
            : ""}
          {secret.updatedAt ? `Updated ${relativeAge(secret.updatedAt, now, true)} · ` : ""}⏎ save · esc cancel
        </span>
        <span className="ml-auto flex items-center gap-2">
          {onDelete && <Button tone="danger" onClick={onDelete} disabled={saving}>Delete</Button>}
          <Button tone="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button tone="primary" onClick={submit} disabled={!canSave} loading={saving}>
            {saving ? "Saving…" : st.renamed ? "Rename & save" : "Save"}
          </Button>
        </span>
      </div>
    </div>
  );
}

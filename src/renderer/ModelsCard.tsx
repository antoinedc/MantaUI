// ===== ModelsCard (BET-215, server-first WS09) =====
//
// The Settings → Models table. Every rule — which models exist, what Main / Sub /
// Default mean for each, the deprecated lock, which controls are allowed, the
// search text and the config writes — lives on the BOX (`models:table` and the
// `models:set-*` writes, src/server/modelsTable.mjs). This card only renders the
// rows it is given and calls one write per control; it never reads config and
// re-derives row state.
//
// Per-row controls:
//   - **Default**  : single-select radio. Enabled only when the box says
//                    `canMakeDefault` (title = the box's `defaultHint`).
//   - **Main**     : off hides the model from the composer's picker. Hiding the
//                    current default clears it in the same save (the box does it).
//   - **Sub**      : dispatchable as a subagent; the box reconciles opencode's
//                    agent blocks and says whether that worked.
//   - **Edit**     : name / description / context size override.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { useStore } from "./store";
import type { ModelsTableResult, ModelsTableRow, ModelsWriteReply } from "../shared/types";
import { Checkbox } from "./Checkbox";
import { Tag } from "./Tag";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { refreshModelCatalog } from "./modelCatalog";
import { useCachedResource } from "./useCachedResource";
import { MantaLoader } from "./MantaLoader";
import { UPDATE_YOUR_BOX, isUnknownChannel } from "./modelsPicker";

const UNSUPPORTED = "unsupported" as const;
type TableData = ModelsTableResult | typeof UNSUPPORTED;

const TIER_CLASS: Record<string, string> = {
  fast: "bg-ok-bg text-ok",
  balanced: "bg-accent-bg text-accent-tx",
  deep: "bg-accent-bg text-accent-tx",
};

/** What the card tells the user after a write (box copy, verbatim). */
type Feedback =
  | { kind: "ok"; message: string }
  | { kind: "partial"; message: string; retry: boolean }
  | { kind: "error"; message: string };

// The overlay dialog for editing a model's display name / description / context
// size. Prefilled from the box's `editable` values; Save sends the three strings
// AS TYPED and the box decides what differs from the provider's own values. A
// refused save keeps the dialog open with the box's message (under the context
// field when it names that field).
function EditModelModal({
  row,
  open = true,
  onSave,
  onCancel,
}: {
  row: ModelsTableRow;
  open?: boolean;
  onSave: (fields: { name: string; description: string; context: string }) => Promise<{ message: string; field?: string } | null>;
  onCancel: () => void;
}) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(row.editable.name);
  const [description, setDescription] = useState(row.editable.description);
  const [context, setContext] = useState(row.editable.context != null ? String(row.editable.context) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave({ name, description, context });
    setSaving(false);
    if (err) setError(err);
  };

  const fieldCls =
    "w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent";

  return (
    <Modal open={open} size="md" onDismiss={onCancel} label={`Edit ${row.name}`}>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-body font-semibold text-text">Edit model</div>
            <div className="text-meta text-text-faint">
              {row.providerID} / {row.modelID}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-muted hover:text-text leading-none inline-flex items-center"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <label className="block">
          <span className="block text-micro font-semibold uppercase text-text-muted mb-1">Name</span>
          <input ref={nameRef} type="text" value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
        </label>

        <label className="block">
          <span className="block text-micro font-semibold uppercase text-text-muted mb-1">Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${fieldCls} resize-y`} />
        </label>

        <label className="block">
          <span className="block text-micro font-semibold uppercase text-text-muted mb-1">Context size (tokens)</span>
          <input
            type="text"
            inputMode="numeric"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="e.g. 200000"
            className={fieldCls}
          />
          {error?.field === "context" && (
            <span role="alert" className="block text-meta text-danger mt-1">
              {error.message}
            </span>
          )}
        </label>

        {error && error.field !== "context" && (
          <div role="alert" className="text-meta text-danger">
            {error.message}
          </div>
        )}

        <div className="text-meta text-text-faint">Leave a field blank to keep the provider's default for it.</div>

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onCancel} tone="ghost">
            Cancel
          </Button>
          <Button onClick={() => void save()} tone="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// The Main + Sub column toggles use the Checkbox primitive (BET-589).
export function ModelsCard() {
  // The default shown in the banner is the box's saved value, echoed in every table reply.
  const { data, loading, error, refresh } = useCachedResource<TableData>("models", async () => {
    try {
      return await window.api.modelsTable();
    } catch (e) {
      if (isUnknownChannel(e)) return UNSUPPORTED;
      throw e;
    }
  });
  // A write's reply carries the new table; show it at once instead of waiting for the refetch.
  const [replied, setReplied] = useState<ModelsTableResult | null>(null);
  const table: TableData | null = replied ?? data;
  const unsupported = table === UNSUPPORTED;
  const rows = table && table !== UNSUPPORTED ? table.rows : null;

  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // Keeps the edit modal rendered with the last-edited row while it plays its close exit.
  const lastEditRow = useRef<ModelsTableRow | null>(null);

  // Another device's write (or this one's, with the card closed) refreshes the table.
  useEffect(() => {
    const off = window.api.onModelsUpdated?.(() => {
      void refresh().then(() => setReplied(null));
    });
    return () => off?.();
  }, [refresh]);

  // Apply a successful reply: new table, mirror the saved default into the store
  // (new drafts seed from it), and refresh the composer's model list.
  const applyReply = useCallback((reply: Extract<ModelsWriteReply, { ok: true }>) => {
    setReplied(reply.table);
    const d = reply.table.defaultKey ? reply.table.rows.find((r) => r.key === reply.table.defaultKey) : null;
    useStore.setState({ defaultModel: d ? { providerID: d.providerID, modelID: d.modelID } : null });
    refreshModelCatalog();
    if (reply.outcome && reply.outcome !== "applied") {
      setFeedback({ kind: "partial", message: reply.message, retry: reply.retry === true });
    } else {
      setFeedback({ kind: "ok", message: reply.message });
    }
  }, []);

  const run = useCallback(
    async (
      key: string,
      call: () => Promise<ModelsWriteReply>,
      // The edit dialog shows its own errors (under the field); the card banner stays quiet then.
      surfaceErrors = true,
    ): Promise<ModelsWriteReply | null> => {
      if (busy) return null;
      setBusy(key);
      setFeedback(null);
      try {
        const reply = await call();
        if (reply.ok) applyReply(reply);
        else if (surfaceErrors) setFeedback({ kind: "error", message: reply.message });
        return reply;
      } catch (e) {
        if (surfaceErrors) {
          setFeedback({
            kind: "error",
            message: isUnknownChannel(e) ? UPDATE_YOUR_BOX : `Couldn't save — ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        return null;
      } finally {
        setBusy(null);
      }
    },
    [busy, applyReply],
  );

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = searchQuery.trim().toLowerCase();
    return q ? rows.filter((r) => r.searchText.includes(q)) : rows;
  }, [rows, searchQuery]);

  const defaultLine = table && table !== UNSUPPORTED ? table.defaultLine : null;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-meta text-text-faint">
          <b className="text-text-muted">Default</b> = the model new &amp; cleared sessions start on (exactly one; must be Main-available).{" "}
          <b className="text-text-muted">Main</b> = selectable as the chat main agent (off hides it from the composer's model picker).{" "}
          <b className="text-text-muted">Sub</b> = dispatchable as a subagent.
        </div>
      </div>

      {unsupported ? (
        <div className="text-meta text-text-faint">{UPDATE_YOUR_BOX}</div>
      ) : (
        <>
          {/* The saved default, as the box reports it. */}
          <div
            className={`flex items-center gap-2 bg-bg-soft border border-border rounded-xs px-3 py-2 ${
              defaultLine ? "" : "text-text-faint italic"
            }`}
          >
            <span className="text-micro font-semibold uppercase text-text-faint">Default</span>
            {defaultLine ? (
              <span className="text-label text-text font-semibold inline-flex items-center gap-2">
                {defaultLine.name}
                <span className="text-text-faint font-normal">{defaultLine.providerID}</span>
              </span>
            ) : (
              <span className="text-label">No default set — opencode default (server decides)</span>
            )}
          </div>

          {error && <div className="text-meta text-danger">{error}</div>}
          {feedback && (
            <div
              role={feedback.kind === "error" ? "alert" : "status"}
              className={`flex items-center gap-3 text-meta ${
                feedback.kind === "error" ? "text-danger" : feedback.kind === "partial" ? "text-warn" : "text-text-faint"
              }`}
            >
              <span>{feedback.message}</span>
              {feedback.kind === "partial" && feedback.retry && (
                <button
                  type="button"
                  className="text-accent hover:underline disabled:opacity-40"
                  disabled={busy != null}
                  onClick={() => void run("__retry__", () => window.api.modelsRetrySubSync())}
                >
                  Try again
                </button>
              )}
            </div>
          )}

          <input
            type="text"
            placeholder="Search models by name, provider, capability…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded-xs focus:outline-none focus:border-accent"
          />

          {loading && !table ? (
            <div className="py-2">
              <MantaLoader size="inline" label="Loading models" />
            </div>
          ) : (
            <div className="border border-border rounded-xs overflow-x-auto">
              <table className="w-full text-body">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2">Model</th>
                    <th className="text-center text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2 w-[80px]">
                      Default
                      <span className="block text-meta normal-case tracking-normal text-text-faint font-normal mt-px">main</span>
                    </th>
                    <th className="text-center text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2 w-[80px]">
                      Main
                      <span className="block text-meta normal-case tracking-normal text-text-faint font-normal mt-px">agent</span>
                    </th>
                    <th className="text-center text-micro font-semibold uppercase text-text-faint font-semibold px-3 py-2 w-[80px]">
                      Sub
                      <span className="block text-meta normal-case tracking-normal text-text-faint font-normal mt-px">agent</span>
                    </th>
                    <th className="w-[48px]" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-meta text-text-faint">
                        No models found
                      </td>
                    </tr>
                  )}
                  {filtered.map((r) => {
                    const isBusy = busy === r.key;
                    const rowDisabled = isBusy || r.deprecatedLocked;
                    return (
                      <tr
                        key={r.key}
                        className={`border-b border-border/40 hover:bg-bg-soft/40 ${r.deprecatedLocked ? "opacity-60" : ""}`}
                      >
                        <td className="px-3 py-2 align-middle">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-body text-text font-medium">{r.name}</span>
                            <span className="text-meta text-text-faint">{r.providerID}</span>
                            {r.contextLabel && <Tag numeric>{r.contextLabel}</Tag>}
                            {r.deprecated && <Tag numeric>deprecated</Tag>}
                            {r.tier && (
                              <span className={`px-2 py-px rounded-xs text-meta ${TIER_CLASS[r.tier] ?? ""}`}>{r.tier}</span>
                            )}
                          </div>
                          {r.description && <div className="text-label text-text-faint mt-1 max-w-[440px]">{r.description}</div>}
                          {r.deprecatedLocked && (
                            <button
                              type="button"
                              onClick={() => void run(r.key, () => window.api.modelsOptIn({ keys: [r.key] }))}
                              disabled={isBusy}
                              className="mt-1 text-meta text-accent hover:underline disabled:opacity-40"
                            >
                              Enable deprecated (also registers as a subagent)
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 align-middle text-center">
                          <input
                            type="radio"
                            name="defaultModel"
                            checked={r.isDefault}
                            disabled={!r.canMakeDefault || rowDisabled}
                            onChange={() => void run(r.key, () => window.api.modelsSetDefault({ key: r.key }))}
                            title={r.defaultHint ?? "Set as default main model"}
                            className="appearance-none w-4 h-4 rounded-full border-[1.5px] border-border-strong bg-bg cursor-pointer checked:border-accent checked:bg-accent-solid disabled:opacity-30 disabled:cursor-not-allowed relative"
                            style={r.isDefault ? { backgroundColor: "var(--accent-solid)", borderColor: "var(--accent)" } : undefined}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle text-center">
                          <Checkbox
                            checked={r.isMain}
                            disabled={rowDisabled}
                            onChange={() => void run(r.key, () => window.api.modelsSetMain({ key: r.key, on: !r.isMain }))}
                            ariaLabel={`Main availability for ${r.name}`}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle text-center">
                          <Checkbox
                            checked={r.isSub}
                            disabled={rowDisabled}
                            onChange={() => void run(r.key, () => window.api.modelsSetSub({ key: r.key, on: !r.isSub }))}
                            ariaLabel={`Sub availability for ${r.name}`}
                          />
                        </td>
                        <td className="px-3 py-2 align-middle text-center">
                          <button
                            type="button"
                            onClick={() => setEditing(r.key)}
                            disabled={rowDisabled}
                            className="inline-flex items-center justify-center p-2 rounded-xs text-text-faint hover:text-text hover:bg-fill-hover disabled:opacity-30 disabled:cursor-not-allowed"
                            aria-label={`Edit ${r.name}`}
                            title="Edit name / description / context"
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {rows &&
        (() => {
          const target = editing ? (rows.find((r) => r.key === editing) ?? null) : null;
          // Keep the modal MOUNTED (so Modal can play its exit) even after the user closes it.
          if (target) lastEditRow.current = target;
          const row = lastEditRow.current ?? rows[0];
          if (!row) return null;
          return (
            <EditModelModal
              key={row.key}
              row={row}
              open={!!target}
              onSave={async (fields) => {
                const reply = await run(row.key, () => window.api.modelsSetOverride({ key: row.key, fields }), false);
                if (reply?.ok) {
                  setEditing(null);
                  return null;
                }
                return reply ? { message: reply.message, field: reply.field } : { message: "Couldn't save — try again." };
              }}
              onCancel={() => setEditing(null)}
            />
          );
        })()}
    </div>
  );
}

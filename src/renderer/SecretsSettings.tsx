// ===== Settings → Secrets =====
//
// Every secret on the box, grouped Shared / Projects / Sessions, with the same
// inline editor as the chat popover (SecretEditor), add and delete. Spec:
// docs/superpowers/specs/2026-10-23-secrets-edit-and-settings.md.
//
// Values never reach this component: the list is metadata only, and editing a
// value means REPLACING it. Every press reports its outcome — a failed
// mutation shows an error banner (role=alert); a successful one is visible as
// the row/editor/dialog closing and the list refetching.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Folder, MessageSquare, Pencil, Trash2 } from "lucide-react";
import type { SecretMeta, SecretPatch, SecretScope } from "../shared/types";
import { useStore } from "./store";
import { Button } from "./Button";
import { ChipGroup } from "./Chip";
import { ConfirmModal } from "./ConfirmModal";
import { Eyebrow } from "./Eyebrow";
import { Field } from "./Field";
import { IconButton } from "./IconButton";
import { MantaLoader } from "./MantaLoader";
import { MetaBadge } from "./chatShared";
import { Modal } from "./Modal";
import { SecretEditor, type SecretSaveResult } from "./SecretEditor";
import {
  buildAddInput,
  canAddSecret,
  computeOverrides,
  countByScope,
  filterSecrets,
  findSlotConflict,
  groupSecrets,
  isStale,
  isValidSecretKey,
  KEY_ERROR,
  listChatWindows,
  overriddenInCount,
  relativeAge,
  type AddDraft,
  type ScopeFilter,
  type SessionGroup,
} from "./secretsView";

const ROW_GRID = "grid grid-cols-[minmax(0,300px)_minmax(0,1fr)_96px_64px] items-center gap-3";
const SELECT =
  "w-full bg-bg-soft border border-border-strong rounded-md px-3 py-2 text-body text-text focus:outline-none focus:border-accent";

type Confirm = { title: string; body: ReactNode; confirmLabel: string; run: () => Promise<void> };

export function SecretsSettings({ onNavigated }: {
  /** Called after "Open chat" activates a window, so Settings can close. */
  onNavigated: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const activateWindow = useStore((s) => s.activateWindow);

  const [all, setAll] = useState<SecretMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.secretsList(undefined, true);
      setAll(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't reach the server to load secrets.");
    }
  }, []);

  // Refetch on open and every 10s while the section is visible (the renderer
  // does not receive the server's secrets.updated bus event).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const list = all ?? [];
  const now = Date.now();
  const counts = useMemo(() => countByScope(list, query), [list, query]);
  const visible = useMemo(() => filterSecrets(list, query, filter), [list, query, filter]);
  const groups = useMemo(() => groupSecrets(visible, projects), [visible, projects]);
  const overrides = useMemo(() => computeOverrides(list, projects), [list, projects]);

  const saveRow = async (id: string, patch: SecretPatch): Promise<SecretSaveResult> => {
    try {
      const r = await window.api.secretsUpdate(id, patch);
      if (r && r.ok === false) return { ok: false, error: r.error || "Couldn't save this secret." };
      setActionError(null);
      await refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't save this secret." };
    }
  };

  const deleteIds = async (ids: string[]): Promise<void> => {
    let failed = 0;
    let lastErr = "";
    for (const id of ids) {
      try {
        await window.api.secretsDelete(id);
      } catch (e) {
        failed++;
        lastErr = e instanceof Error ? e.message : "request failed";
      }
    }
    await refresh();
    setEditingId(null);
    setActionError(
      failed === 0
        ? null
        : `Couldn't delete ${failed} of ${ids.length} secret${ids.length === 1 ? "" : "s"} (${lastErr}). They are still on the server.`,
    );
  };

  const askDelete = (s: SecretMeta) =>
    setConfirm({
      title: `Delete ${s.key}?`,
      body: "Agents that ask for this secret will no longer find it. This can't be undone.",
      confirmLabel: "Delete",
      run: () => deleteIds([s.id]),
    });

  const askDeleteGroup = (g: SessionGroup) =>
    setConfirm({
      title: `Delete ${g.items.length} secret${g.items.length === 1 ? "" : "s"} from a closed chat?`,
      body: `${g.items.map((s) => s.key).join(", ")} — stored for ${g.label}, a chat that no longer exists. This can't be undone.`,
      confirmLabel: "Delete all",
      run: () => deleteIds(g.items.map((s) => s.id)),
    });

  const openChat = async (g: SessionGroup) => {
    if (!g.window) return;
    try {
      await activateWindow(g.window.tmuxSession, g.window.windowIndex);
      onNavigated();
    } catch (e) {
      setActionError(`Couldn't open ${g.label}: ${e instanceof Error ? e.message : "request failed"}`);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirming(true);
    try {
      await confirm.run();
    } finally {
      setConfirming(false);
      setConfirm(null);
    }
  };

  const renderRow = (s: SecretMeta) => {
    if (editingId === s.id) {
      return (
        <div key={s.id} className="px-3 py-2">
          <SecretEditor
            secret={s}
            now={now}
            layout="grid"
            overriddenIn={overriddenInCount(list, s, projects)}
            onSave={(patch) => saveRow(s.id, patch)}
            onClose={() => setEditingId(null)}
            onDelete={() => askDelete(s)}
          />
        </div>
      );
    }
    const ov = overrides.get(s.id);
    return (
      <div
        key={s.id}
        onDoubleClick={() => setEditingId(s.id)}
        className={`group ${ROW_GRID} px-3 py-2 text-meta hover:bg-fill focus-within:bg-fill`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-text">{s.key}</span>
          {ov && (
            <MetaBadge tone="warn" title={`Overrides the ${ov} secret of the same name for ${s.scope === "session" ? "this chat" : "this project"}`}>
              overrides {ov}
            </MetaBadge>
          )}
        </span>
        <span className={`truncate ${s.hint ? "text-text-muted" : "italic text-text-faint"}`} title={s.hint || undefined}>
          {s.hint || "no hint"}
        </span>
        <span className={`font-mono ${isStale(s.updatedAt, now) ? "text-warn" : "text-text-faint"}`}>
          {relativeAge(s.updatedAt, now)}
        </span>
        <span className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton label={`Edit ${s.key}`} icon={<Pencil />} onClick={() => setEditingId(s.id)} />
          <IconButton label={`Delete ${s.key}`} icon={<Trash2 />} onClick={() => askDelete(s)} />
        </span>
      </div>
    );
  };

  const table = (rows: SecretMeta[], header?: ReactNode) => (
    <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border bg-bg-soft">
      {header}
      {rows.map(renderRow)}
    </div>
  );

  const groupHeader = (icon: ReactNode, title: ReactNode, meta: string, right?: ReactNode) => (
    <div className="flex items-center gap-2 bg-raised px-3 py-2 text-meta text-text-muted">
      {icon}
      <span className="min-w-0 truncate">{title}</span>
      <span className="text-text-faint">{meta}</span>
      <span className="ml-auto flex items-center gap-2">{right}</span>
    </div>
  );

  const countLabel = (n: number) => `${n} secret${n === 1 ? "" : "s"}`;
  const showShared = groups.shared.length > 0;
  const showProjects = groups.projects.length > 0;
  const showSessions = groups.sessions.length > 0;

  return (
    <div className="space-y-5">
      <p className="max-w-[80ch] text-body text-text-faint">
        Credentials your agents can use without ever seeing them. Values are stored on the box and are never shown
        again — you can replace a value, not read it. When names collide, a session secret beats a project secret,
        which beats a shared one.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Field ariaLabel="Search secrets" placeholder="Search name or hint…" value={query} onChange={(e) => setQuery(e.target.value)} mono={false} />
        </div>
        <ChipGroup<ScopeFilter>
          label="Filter secrets by scope"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: `All ${counts.all}` },
            { value: "shared", label: `Shared ${counts.shared}` },
            { value: "project", label: `Projects ${counts.project}` },
            { value: "session", label: `Sessions ${counts.session}` },
          ]}
        />
        <span className="ml-auto">
          <Button tone="primary" onClick={() => setAddOpen(true)}>+ Add secret</Button>
        </span>
      </div>

      {loadError && (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-danger/40 bg-danger-bg px-4 py-3 text-body text-danger">
          <span className="flex-1 break-words">Couldn&apos;t load secrets: {loadError}</span>
          <Button tone="default" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-danger/40 bg-danger-bg px-4 py-3 text-body text-danger">
          <span className="flex-1 break-words">{actionError}</span>
          <Button tone="ghost" onClick={() => setActionError(null)}>Dismiss</Button>
        </div>
      )}

      {all === null && !loadError ? (
        <div className="py-2"><MantaLoader size="inline" label="Loading secrets" /></div>
      ) : all !== null && list.length === 0 ? (
        <div className="text-body text-text-faint">
          No secrets yet. Add one; agents use it through the secret_provide tool without ever seeing the value.
        </div>
      ) : all !== null && visible.length === 0 ? (
        <div className="text-body text-text-faint">No secrets match.</div>
      ) : (
        <>
          {showShared && (
            <section aria-label="Shared secrets">
              <Eyebrow>Shared · available to every session on this box</Eyebrow>
              {table(groups.shared)}
            </section>
          )}
          {showProjects && (
            <section aria-label="Project secrets">
              <Eyebrow>Projects · available to every chat in that workspace</Eyebrow>
              <div className="space-y-3">
                {groups.projects.map((g) => (
                  <div key={g.project}>
                    {table(g.items, groupHeader(<Folder size={14} aria-hidden="true" />, <span className="font-mono text-text">{g.project}</span>, countLabel(g.items.length)))}
                  </div>
                ))}
              </div>
            </section>
          )}
          {showSessions && (
            <section aria-label="Session secrets">
              <Eyebrow>Sessions · available only to one chat</Eyebrow>
              <div className="space-y-3">
                {groups.sessions.map((g) => (
                  <div key={g.sessionID}>
                    {table(
                      g.items,
                      groupHeader(
                        <MessageSquare size={14} aria-hidden="true" />,
                        g.window ? <span className="text-text">{g.label}</span> : <span className="font-mono">{g.label}</span>,
                        countLabel(g.items.length),
                        g.window ? (
                          <Button tone="ghost" onClick={() => void openChat(g)}>Open chat ↗</Button>
                        ) : (
                          <>
                            <MetaBadge title="No open chat window carries this session">chat closed</MetaBadge>
                            <Button tone="danger" onClick={() => askDeleteGroup(g)}>Delete all</Button>
                          </>
                        ),
                      ),
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {addOpen && (
        <AddSecretDialog
          all={list}
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); setActionError(null); void refresh(); }}
        />
      )}

      <ConfirmModal
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body}
        confirmLabel={confirming ? "Deleting…" : (confirm?.confirmLabel ?? "Delete")}
        onConfirm={() => void runConfirm()}
        onCancel={() => { if (!confirming) setConfirm(null); }}
      />
    </div>
  );
}

function AddSecretDialog({ all, onClose, onAdded }: {
  all: SecretMeta[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const projects = useStore((s) => s.projects);
  const chats = useMemo(() => listChatWindows(projects), [projects]);
  const [draft, setDraft] = useState<AddDraft>({
    scope: "shared",
    project: projects[0]?.tmuxSession ?? "",
    sessionID: chats[0]?.sessionID ?? "",
    key: "",
    value: "",
    hint: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<AddDraft>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };
  const keyBad = draft.key !== "" && !isValidSecretKey(draft.key);
  const conflict = canAddSecret(draft) ? findSlotConflict(all, draft) : null;
  const canSave = canAddSecret(draft) && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const r = await window.api.secretsSet(buildAddInput(draft));
      if (r && r.ok === false) {
        setError(r.error || "Couldn't save this secret.");
        return;
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this secret.");
    } finally {
      setSaving(false);
    }
  };

  const scopeOptions: { value: SecretScope; label: string }[] = [
    { value: "shared", label: "Every session" },
    { value: "project", label: "A project" },
    { value: "session", label: "One chat" },
  ];

  return (
    <Modal size="md" open onDismiss={saving ? undefined : onClose} label="Add secret">
      <div className="space-y-3">
        <h3 className="text-title font-semibold">Add secret</h3>
        <div className="space-y-1">
          <div className="block text-micro font-semibold uppercase text-text-muted">Available to</div>
          <ChipGroup<SecretScope> label="Available to" value={draft.scope} options={scopeOptions} onChange={(scope) => set({ scope })} />
        </div>
        {draft.scope === "project" && (
          projects.length === 0 ? (
            <div className="text-meta text-text-faint">No workspaces yet.</div>
          ) : (
            <select aria-label="Project" value={draft.project} onChange={(e) => set({ project: e.target.value })} className={SELECT}>
              {projects.map((p) => <option key={p.tmuxSession} value={p.tmuxSession}>{p.tmuxSession}</option>)}
            </select>
          )
        )}
        {draft.scope === "session" && (
          chats.length === 0 ? (
            <div className="text-meta text-text-faint">No chats are open.</div>
          ) : (
            <select aria-label="Chat" value={draft.sessionID} onChange={(e) => set({ sessionID: e.target.value })} className={SELECT}>
              {chats.map((c) => <option key={c.sessionID} value={c.sessionID}>{c.label}</option>)}
            </select>
          )
        )}
        <Field
          id="add-secret-key"
          label="Name"
          placeholder="GITHUB_PAT"
          value={draft.key}
          onChange={(e) => set({ key: e.target.value })}
          help={keyBad ? <span className="text-danger">{KEY_ERROR}</span> : undefined}
        />
        <Field
          id="add-secret-value"
          label="Value"
          type="password"
          autoComplete="off"
          placeholder="stored on the box · never shown again"
          value={draft.value}
          onChange={(e) => set({ value: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
        />
        <Field
          id="add-secret-hint"
          label="Hint for the agent (optional)"
          mono={false}
          placeholder="e.g. git push token"
          value={draft.hint}
          onChange={(e) => set({ hint: e.target.value })}
        />
        {conflict && (
          <div className="rounded-xs border border-warn/40 bg-warn-bg px-2 py-1 text-label text-warn">
            A secret named {conflict.key} already exists here — saving replaces its value.
          </div>
        )}
        {error && <div role="alert" className="break-words text-label text-danger">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button tone="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button tone="primary" onClick={() => void submit()} disabled={!canSave} loading={saving}>
            {saving ? "Saving…" : conflict ? "Replace" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

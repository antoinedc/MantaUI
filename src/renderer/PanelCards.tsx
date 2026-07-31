// ===== Composer-pinned session cards =====
//
// Extracted from ChatPanel.tsx (M0.5). Cards that pin above the composer to
// manage per-session resources the agent's opencode tools create:
//   - ScheduledTasksCard: scheduled prompts (⏰) with per-row cancel.
//   - WebhooksCard: inbound webhooks (🪝) with per-row revoke + URL copy.
//   - SecretsCard: agent-usable secrets (🔑) — add form + metadata-only list
//     (values never re-enter the renderer).
//
// All three are cards (not footer items) so they render on BOTH desktop and
// mobile with no mobile-CSS edits.

import { memo, useEffect, useRef, useState } from "react";
import { Clock, Webhook, Key, Bot, X } from "lucide-react";
import type {
  DelegateApproval,
  DelegateApprovalTool,
  ScheduledJob,
  SecretMeta,
  SecretScope,
  WebhookMeta,
} from "../shared/types";
import { describeCron, describeNextRun } from "./chatUtils";
import { MetaBadge } from "./chatShared";

// ScheduledTasksCard — pinned card above the composer showing this session's
// scheduled prompts (created by the AI's `schedule` opencode tool) with a
// per-row delete. See docs/manta-tools-scheduler.md.
export const ScheduledTasksCard = memo(function ScheduledTasksCard({
  jobs,
  error,
  onDelete,
  onClose,
}: {
  jobs: ScheduledJob[];
  error: string | null;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  // Click-outside-to-dismiss: the close (×) button sits directly above the
  // first row's cancel button, so a mis-tap on the close used to delete a job.
  // Dismissing by clicking anywhere outside the card removes that hazard.
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer registration to the next tick so the same click that opened the
    // card (from the toolbar button) doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div
      ref={cardRef}
      className="rounded-md border bg-bg-elev px-3 py-2 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center">
          <Clock size={16} aria-hidden="true" />
        </span>
        <span className="text-text">Scheduled</span>
        {jobs.length > 0 && <span className="text-text-faint">· {jobs.length}</span>}
        <button
          onClick={onClose}
          className="ml-auto px-2 rounded text-text-faint hover:text-text-muted inline-flex items-center"
          title="Close (or click outside)"
          aria-label="Close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <div className="text-danger break-words">{error}</div>
      ) : jobs.length === 0 ? (
        <div className="text-text-muted">No scheduled tasks in this session.</div>
      ) : (
        <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
          {jobs.map((j) => {
            const next = describeNextRun(j.cron, j.recurring);
            return (
              <div key={j.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-text truncate" title={j.prompt}>
                    {j.label || j.prompt}
                  </div>
                  <div className="flex items-center gap-2 text-text-faint font-mono text-label">
                    <span className="shrink-0">
                      {describeCron(j.cron, j.recurring)}
                    </span>
                    {next && (
                      <span
                        className="shrink-0 truncate"
                        title="Next run"
                        style={{ color: "var(--accent)" }}
                      >
                        · next {next}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onDelete(j.id)}
                  className="shrink-0 px-2 py-px rounded text-danger hover:bg-danger-bg border border-danger/30 text-label"
                  title="Cancel this scheduled task"
                >
                  Cancel
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// WebhooksCard — pinned card above the composer listing this session's inbound
// webhooks (created by the AI's `webhook` opencode tool) with a per-row revoke.
// List is metadata only — the signing secret is shown once at create (in the
// agent's tool result) and never re-exposed here. See docs/manta-tools-webhook.md.
export const WebhooksCard = memo(function WebhooksCard({
  hooks,
  error,
  onDelete,
  onClose,
}: {
  hooks: WebhookMeta[];
  error: string | null;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  const copyUrl = (url: string, id: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
      },
      () => { /* clipboard blocked — no-op */ },
    );
  };
  return (
    <div
      ref={cardRef}
      className="rounded-md border bg-bg-elev px-3 py-2 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center">
          <Webhook size={16} aria-hidden="true" />
        </span>
        <span className="text-text">Webhooks</span>
        {hooks.length > 0 && <span className="text-text-faint">· {hooks.length}</span>}
        <button
          onClick={onClose}
          className="ml-auto px-2 rounded text-text-faint hover:text-text-muted inline-flex items-center"
          title="Close (or click outside)"
          aria-label="Close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <div className="text-danger break-words">{error}</div>
      ) : hooks.length === 0 ? (
        <div className="text-text-muted">
          No webhooks in this session. Ask the agent to create one (e.g. “have
          Multica ping this session when the task finishes”).
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
          {hooks.map((h) => {
            const last =
              h.lastDeliveredAt != null
                ? `${new Date(h.lastDeliveredAt).toLocaleString()} · ${h.deliveries}×`
                : "never fired";
            return (
              <div key={h.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-text truncate" title={h.label}>
                      {h.label}
                    </span>
                    {h.unsigned && (
                      <MetaBadge
                        tone="danger"
                        title="No signature required — anyone with the URL can trigger this hook"
                      >
                        unsigned
                      </MetaBadge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-text-faint font-mono text-label">
                    {h.url && (
                      <button
                        onClick={() => copyUrl(h.url as string, h.id)}
                        className="shrink-0 truncate max-w-[200px] hover:text-text-muted underline decoration-dotted"
                        title={`Copy delivery URL\n${h.url}`}
                      >
                        {copied === h.id ? "copied!" : h.url.replace(/^https?:\/\//, "")}
                      </button>
                    )}
                    <span className="shrink-0 truncate" title="Last delivery">
                      · {last}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => onDelete(h.id)}
                  className="shrink-0 px-2 py-px rounded text-danger hover:bg-danger-bg border border-danger/30 text-label"
                  title="Revoke this webhook (further POSTs will 404)"
                >
                  Revoke
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// SecretsCard — pinned card above the composer for managing the secrets the
// agent can use. The user types a key + value here; the value travels to the
// box (renderer → IPC/RPC → manta-server store) and is NEVER returned or shown
// again — the list is metadata only (key, scope, hint). Agents read secrets via
// the secret_list / secret_provide opencode tools, which materialize the value
// to a 0600 file on the box and hand the agent only the path, so the value
// never enters the AI transcript.
export const SecretsCard = memo(function SecretsCard({
  secrets,
  error,
  sessionId,
  onSave,
  onDelete,
  onClose,
}: {
  secrets: SecretMeta[];
  error: string | null;
  sessionId: string;
  onSave: (input: {
    key: string;
    value: string;
    scope: SecretScope;
    sessionID?: string | null;
    hint?: string;
  }) => Promise<boolean>;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<SecretScope>("shared");
  const [hint, setHint] = useState("");
  const [saving, setSaving] = useState(false);

  const keyValid = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key);
  const canSave = keyValid && value.length > 0 && !saving;

  const submit = () => {
    if (!canSave) return;
    setSaving(true);
    void onSave({
      key,
      value,
      scope,
      // Pass sessionID for session scope (the owner) AND project scope (so the
      // server resolves the workspace name from this chat's session).
      sessionID: scope === "session" || scope === "project" ? sessionId : null,
      hint: hint.trim() || undefined,
    }).then((ok) => {
      setSaving(false);
      if (ok) {
        // Clear value immediately (don't keep the secret in component state),
        // and reset the form for the next entry.
        setKey("");
        setValue("");
        setHint("");
      }
    });
  };

  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center">
          <Key size={16} aria-hidden="true" />
        </span>
        <span className="text-text">Secrets</span>
        {secrets.length > 0 && <span className="text-text-faint">· {secrets.length}</span>}
        <button
          onClick={onClose}
          className="ml-auto px-1 rounded text-text-faint hover:text-text-muted inline-flex items-center"
          title="Close"
          aria-label="Close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {/* Add / update form */}
      <div className="flex flex-col gap-2 mb-2">
        <div className="flex flex-wrap gap-2">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="KEY (e.g. GITHUB_PAT)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`min-w-0 flex-1 rounded border bg-bg px-2 py-1 font-mono text-text outline-none ${
              key && !keyValid ? "border-danger/60" : "border-border"
            }`}
          />
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as SecretScope)}
            className="rounded border border-border bg-bg px-2 py-1 text-text outline-none"
            title="shared = every session · project = every chat in this workspace · session = only this chat"
          >
            <option value="shared">shared</option>
            <option value="project">this project</option>
            <option value="session">this session</option>
          </select>
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="value (stored on the box; never shown again)"
          type="password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-text outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="hint for the agent (optional, e.g. 'git push token')"
            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-text outline-none"
          />
          <button
            onClick={submit}
            disabled={!canSave}
            className="shrink-0 px-2 py-1 rounded border disabled:opacity-40"
            style={{ borderColor: "rgb(var(--accent-rgb) / 0.53)", color: "var(--accent)" }}
            title="Store this secret on the box"
          >
            {saving ? "saving…" : "Save"}
          </button>
        </div>
        {key && !keyValid && (
          <div className="text-danger text-label">
            Key must start with a letter/underscore, then letters/digits/underscores (max 64).
          </div>
        )}
      </div>

      {error && <div className="text-danger break-words mb-1">{error}</div>}

      {/* Existing secrets (metadata only — no values) */}
      {secrets.length === 0 ? (
        <div className="text-text-muted">
          No secrets yet. Add one above; the agent uses it via the secret_provide tool
          without ever seeing the value.
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-border pt-2 max-h-[40vh] overflow-y-auto">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-text font-mono truncate">{s.key}</span>
                  <MetaBadge
                    title={
                      s.scope === "shared"
                        ? "Available to every session"
                        : s.scope === "project"
                          ? `Available to every chat in project "${s.project ?? ""}"`
                          : "Available only to this session"
                    }
                  >
                    {s.scope === "shared"
                      ? "shared"
                      : s.scope === "project"
                        ? `project:${s.project ?? "?"}`
                        : "session"}
                  </MetaBadge>
                </div>
                {s.hint && (
                  <div className="text-text-faint text-label truncate" title={s.hint}>
                    {s.hint}
                  </div>
                )}
              </div>
              <button
                onClick={() => onDelete(s.id)}
                className="shrink-0 px-2 py-px rounded text-danger hover:bg-danger-bg border border-danger/30 inline-flex items-center"
                title="Delete this secret"
                aria-label="Delete this secret"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// DelegateApprovalCard — ONE pre-flight approval shown in the parent's panel
// before a background job is created (BET-418 §A). The model's `delegate`
// call declared the access it needs (`tools`); the user picks Start (create
// the job with that ruleset), Edit access (trim/augment the ruleset first),
// or Not now (decline — the delegate call returns declined). A catch-all deny
// is appended server-side so any tool NOT listed is refused, not prompted.
// Mirrors the other cards' markup so it renders on desktop + mobile.
export const DelegateApprovalCard = memo(function DelegateApprovalCard({
  approval,
  onApprove,
  onDecline,
}: {
  approval: DelegateApproval;
  onApprove: (tools: DelegateApprovalTool[]) => void;
  onDecline: () => void;
}) {
  // Edit-access mode: a local, editable copy of the tools list. Start sends
  // the (possibly edited) list; the server rebuilds the ruleset + catch-all.
  const [editing, setEditing] = useState(false);
  const [tools, setTools] = useState<DelegateApprovalTool[]>(
    Array.isArray(approval.tools) ? approval.tools.map((t) => ({ ...t })) : [],
  );
  useEffect(() => {
    setTools(Array.isArray(approval.tools) ? approval.tools.map((t) => ({ ...t })) : []);
    setEditing(false);
  }, [approval.id]);
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center">
          <Bot size={16} aria-hidden="true" />
        </span>
        <span className="text-text">Background job approval</span>
        <span className="text-text-faint truncate">· {approval.name}</span>
        <button
          onClick={onDecline}
          className="ml-auto px-1.5 rounded text-text-faint hover:text-text-muted inline-flex items-center"
          title="Not now (decline)"
          aria-label="Not now"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="text-text-muted mb-1 line-clamp-2">{approval.prompt}</div>
      <div className="text-text-faint mb-1">Will be allowed to:</div>
      {tools.length === 0 ? (
        <div className="text-text-faint text-label">No tools declared.</div>
      ) : (
        <div className="flex flex-col gap-1 mb-1">
          {tools.map((t, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {editing ? (
                <>
                  <input
                    className="flex-1 min-w-0 rounded border border-border bg-bg-soft px-1.5 py-0.5 font-mono text-text"
                    value={t.permission}
                    onChange={(e) =>
                      setTools((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, permission: e.target.value } : p)),
                      )
                    }
                    placeholder="permission"
                  />
                  <input
                    className="flex-1 min-w-0 rounded border border-border bg-bg-soft px-1.5 py-0.5 font-mono text-text"
                    value={t.pattern}
                    onChange={(e) =>
                      setTools((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, pattern: e.target.value } : p)),
                      )
                    }
                    placeholder="pattern"
                  />
                  <button
                    onClick={() => setTools((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 px-1 rounded text-danger hover:bg-danger-bg border border-danger/30"
                    title="Remove"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </>
              ) : (
                <MetaBadge title={`${t.permission}: ${t.pattern}`}>
                  {t.permission}: {t.pattern}
                </MetaBadge>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <button
          onClick={() => setTools((prev) => [...prev, { permission: "bash", pattern: "" }])}
          className="text-label text-text-faint hover:text-text-muted mb-1"
        >
          + Add rule
        </button>
      )}
      <div className="text-text-faint text-label mb-2">
        Anything not listed is denied (the job will not ask again).
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onApprove(tools)}
          className="px-2.5 py-1 rounded text-bg font-medium"
          style={{ backgroundColor: "var(--accent)" }}
          title="Start the job with this access"
        >
          Start job
        </button>
        <button
          onClick={() => setEditing((v) => !v)}
          className="px-2 py-1 rounded border border-border-strong text-text hover:bg-bg-soft"
        >
          {editing ? "Done editing" : "Edit access"}
        </button>
        <button
          onClick={onDecline}
          className="px-2 py-1 rounded text-text-faint hover:text-text-muted"
        >
          Not now
        </button>
      </div>
    </div>
  );
});

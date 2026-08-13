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

import { memo, useEffect, useState } from "react";
import { Clock, Bell, Webhook, Key, Bot, ArrowLeft, Square, X, GitPullRequest } from "lucide-react";
import type {
  DelegateApproval,
  DelegateApprovalTool,
  DelegateJob,
  ForgePullRequestResult,
  ScheduledJob,
  SecretMeta,
  SecretScope,
  WebhookMeta,
} from "../shared/types";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Field } from "./Field";
import { canMerge, describeCron, describeNextRun, formatJobSummary } from "./chatUtils";
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
  return (
    <div
      className="rounded-sm border bg-bg-elev px-3 py-2 text-meta"
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
          className="ml-auto px-2 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
          title="Close"
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
                  <div className="text-text truncate flex items-center gap-2" title={j.prompt}>
                    {j.kind === "notify" && (
                      <Bell size={12} aria-hidden="true" className="shrink-0 text-text-faint" />
                    )}
                    <span className="truncate">{j.label || j.prompt}</span>
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
                  className="shrink-0 px-2 py-px rounded-xs text-danger hover:bg-danger-bg border border-danger/30 text-label"
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
  const [copied, setCopied] = useState<string | null>(null);
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
      className="rounded-sm border bg-bg-elev px-3 py-2 text-meta"
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
          className="ml-auto px-2 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
          title="Close"
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
                  className="shrink-0 px-2 py-px rounded-xs text-danger hover:bg-danger-bg border border-danger/30 text-label"
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
      className="rounded-sm border bg-bg-elev px-3 py-2 text-meta"
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
          className="ml-auto px-1 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
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
            className={`min-w-0 flex-1 rounded-xs border bg-bg px-2 py-1 font-mono text-text outline-none ${
              key && !keyValid ? "border-danger/60" : "border-border"
            }`}
          />
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as SecretScope)}
            className="rounded-xs border border-border bg-bg px-2 py-1 text-text outline-none"
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
          className="w-full rounded-xs border border-border bg-bg px-2 py-1 font-mono text-text outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="hint for the agent (optional, e.g. 'git push token')"
            className="min-w-0 flex-1 rounded-xs border border-border bg-bg px-2 py-1 text-text outline-none"
          />
          <button
            onClick={submit}
            disabled={!canSave}
            className="shrink-0 px-2 py-1 rounded-xs border disabled:opacity-40"
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
                className="shrink-0 px-2 py-px rounded-xs text-danger hover:bg-danger-bg border border-danger/30 inline-flex items-center"
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
      className="rounded-sm border bg-bg-elev px-3 py-2 text-meta"
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
          className="ml-auto px-2 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
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
            <div key={i} className="flex items-center gap-2">
              {editing ? (
                <>
                  <input
                    className="flex-1 min-w-0 rounded-xs border border-border bg-bg-soft px-2 py-px font-mono text-text"
                    value={t.permission}
                    onChange={(e) =>
                      setTools((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, permission: e.target.value } : p)),
                      )
                    }
                    placeholder="permission"
                  />
                  <input
                    className="flex-1 min-w-0 rounded-xs border border-border bg-bg-soft px-2 py-px font-mono text-text"
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
                    className="shrink-0 px-1 rounded-xs text-danger hover:bg-danger-bg border border-danger/30"
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
          className="px-3 py-1 rounded-xs text-bg font-medium"
          style={{ backgroundColor: "var(--accent)" }}
          title="Start the job with this access"
        >
          Start job
        </button>
        <button
          onClick={() => setEditing((v) => !v)}
          className="px-2 py-1 rounded-xs border border-border-strong text-text hover:bg-bg-soft"
        >
          {editing ? "Done editing" : "Edit access"}
        </button>
        <button
          onClick={onDecline}
          className="px-2 py-1 rounded-xs text-text-faint hover:text-text-muted"
        >
          Not now
        </button>
      </div>
    </div>
  );
});

// ReadOnlyJobBar — replaces the composer for a background-job session (BET-418
// §D). A job is read-only: no composer, no permission/question cards, no model
// picker, no fork/compact/clear. The only live action is Stop (running jobs).
// "Go to parent" navigates to the parent session's window. Once terminal, the
// bar shows the outcome (branch + files changed) and Stop is hidden; the view
// closes when the user navigates away (the window is removed on terminal, so
// the sidebar no longer lists it).
export const ReadOnlyJobBar = memo(function ReadOnlyJobBar({
  job,
  parentName,
  onGoToParent,
  onStop,
  modelName,
}: {
  job: DelegateJob;
  parentName: string | null;
  onGoToParent: () => void;
  onStop: () => void;
  modelName: string | null;
}) {
  const terminal = job.status !== "running";
  return (
    <div className="shrink-0 px-4 py-2 border-t border-border bg-bg-elev text-meta">
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center">
          <Bot size={14} aria-hidden="true" />
        </span>
        <span className="text-text">
          {modelName
            ? <>Read-only — this is a background job running <strong>{modelName}</strong>.</>
            : "Read-only — this is a background job."}
        </span>
        {parentName && (
          <span className="text-text-faint">It reports to {parentName}.</span>
        )}
      </div>
      {terminal ? (
        <div className="text-text-faint">
          {formatJobSummary(job)}
          {job.status === "failed" || job.status === "stopped"
            ? ` · ${job.error ?? job.status}`
            : ""}
        </div>
      ) : (
        <div className="text-text-faint">{job.activity || "running…"}</div>
      )}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={onGoToParent}
          className="px-2 py-1 rounded-xs border border-border-strong text-text hover:bg-bg-soft inline-flex items-center gap-1"
          title="Go to the parent session"
        >
          <ArrowLeft size={12} aria-hidden="true" /> Go to parent
        </button>
        {!terminal && (
          <button
            onClick={onStop}
            className="px-2 py-1 rounded-xs text-warn hover:bg-warn-bg border border-warn/30 inline-flex items-center gap-1"
            title="Stop this job"
          >
            <Square size={12} aria-hidden="true" /> Stop
          </button>
        )}
      </div>
    </div>
  );
});

// ===== Forge ship + merge (BET-794) =====

// ShipConfirmCard — the [SH1] human gate. Always shown before anything is
// pushed or opened; never auto-submitted. Reads top-down: a context line, an
// editable title, an editable body, then the actions (primary "Open pull
// request", a Draft toggle, ghost Cancel). Order matters: one submit action
// with a modifier, not two submit actions.
export const ShipConfirmCard = memo(function ShipConfirmCard({
  proposal,
  busy,
  error,
  onApprove,
  onDecline,
}: {
  proposal: { head: string; base: string; fileCount: number; title?: string; body?: string };
  busy: boolean;
  error: string | null;
  onApprove: (input: { title: string; body: string; draft: boolean }) => void;
  onDecline: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  useEffect(() => {
    // Seed the editable fields from the server / agent draft (design §4.5
    // step 1 — honouring the repo's PR template); the user can still edit them.
    setTitle(proposal?.title ?? "");
    setBody(proposal?.body ?? "");
    setDraft(true);
  }, [proposal?.head, proposal?.title, proposal?.body]);
  const canSubmit = title.trim().length > 0 && !busy;
  return (
    <div
      className="rounded-sm border bg-bg-elev px-3 py-2 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center shrink-0">
          <GitPullRequest size={15} aria-hidden="true" />
        </span>
        <span className="text-text-faint text-meta">
          Open a pull request · {proposal.head}{" "}
          <span style={{ color: "var(--accent)" }}>→</span> {proposal.base} ·{" "}
          {proposal.fileCount} file{proposal.fileCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <Field
          ariaLabel="Pull request title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Pull request title"
          mono={false}
          disabled={busy}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe the change…"
          spellCheck={false}
          disabled={busy}
          rows={3}
          aria-label="Pull request body"
          className="w-full bg-bg-soft border border-border-strong rounded-md text-meta text-text-muted px-4 py-3 focus:outline-none focus:border-accent resize-y"
        />
      </div>
      {error && <div className="text-danger break-words mt-1">{error}</div>}
      <div className="flex items-center gap-2 mt-2">
        <Button tone="primary" disabled={!canSubmit} onClick={() => onApprove({ title, body, draft })}>
          {busy ? "Opening…" : "Open pull request"}
        </Button>
        <Chip on={draft} onClick={() => setDraft((d) => !d)} title="Toggle draft mode">
          Draft
        </Chip>
        <Button tone="ghost" onClick={onDecline} disabled={busy}>
          Cancel
        </Button>
      </div>
      <div className="text-text-faint text-label mt-1">
        Never auto-submitted — nothing is pushed or opened until you confirm here.
      </div>
    </div>
  );
});

// ForgeCard — the session's forge surface. When the repo has a pull request it
// shows its state + a Merge control gated by canMerge (with a visible reason),
// and surfaces the distinguished merge-failure kind. When there is none and the
// box is connected, it offers the Ship action that opens the ShipConfirmCard.
export const ForgeCard = memo(function ForgeCard({
  result,
  loading,
  shipOpen,
  busy,
  mergeError,
  onShip,
  onMerge,
}: {
  result?: ForgePullRequestResult | null;
  loading: boolean;
  shipOpen: boolean;
  busy: boolean;
  mergeError: string | null;
  onShip: () => void;
  onMerge: () => void;
}) {
  const pr = result?.pr ?? null;
  const rollup = result?.rollup ?? "none";
  const merge = canMerge({
    rollup,
    unresolvedThreads: pr?.unresolvedThreads ?? 0,
    mergeable: pr?.mergeable ?? null,
  });
  const rollupColor =
    rollup === "green" ? "var(--ok)" : rollup === "red" ? "var(--danger)" : rollup === "yellow" ? "var(--warn)" : "var(--tx3)";
  return (
    <div
      className="rounded-sm border bg-bg-elev px-3 py-2 text-meta"
      style={{ borderColor: "rgb(var(--accent-rgb) / 0.33)" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: "var(--accent)" }} className="inline-flex items-center">
          <GitPullRequest size={16} aria-hidden="true" />
        </span>
        {loading ? (
          <span className="text-text-faint">Checking GitHub…</span>
        ) : pr ? (
          <>
            <span className="text-text truncate" title={pr.title}>
              #{pr.number} {pr.title}
            </span>
            <MetaBadge title="The normalised PR state">{pr.state}</MetaBadge>
            {/* Traffic-light for checks; null = not mergeable (reason below). */}
            <span
              className="inline-flex items-center gap-1 text-text-faint"
              title={`Checks: ${rollup}`}
            >
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: rollupColor }} />
              <span className="font-mono text-label">{result?.checks?.length ?? 0}</span>
            </span>
          </>
        ) : (
          <span className="text-text-faint">No open pull request on this branch</span>
        )}
      </div>

      {pr ? (
        <>
          {/* Can I merge? Disabled with a visible reason; green rollup + no
              threads + mergeable true are ALL required. */}
          <div className="text-text-faint text-label mb-1">
            {merge.can
              ? "Ready to merge — checks green, threads resolved."
              : `Can't merge yet — ${merge.reason}.`}
          </div>
          {!merge.can && pr.mergeBlockedReason && (
            <div className="text-text-faint text-label mb-1">
              GitHub: {pr.mergeBlockedReason}
            </div>
          )}
          {mergeError && (
            <div className="text-danger break-words mb-1">
              {mergeError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              tone="primary"
              disabled={!merge.can || busy}
              onClick={onMerge}
              title={merge.can ? "Merge this pull request" : merge.reason ?? "not mergeable"}
            >
              {busy ? "Merging…" : "Merge"}
            </Button>
            <span className="text-text-faint text-label">
              {pr.headRef} → {pr.baseRef}
            </span>
          </div>
        </>
      ) : (
        shipOpen === false && !loading && (
          <div className="flex items-center gap-2">
            <Button tone="ghost" onClick={onShip} title="Push the current branch and open a pull request">
              Ship as pull request
            </Button>
          </div>
        )
      )}
    </div>
  );
});

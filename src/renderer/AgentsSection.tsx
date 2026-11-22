// The sidebar's Agents section (Agents Phase 1, spec §8): one row per agent on
// the box, a "+" that opens a native <dialog> to create one. Clicking a row opens
// the agent's direct chat (a window in the hidden "manta-agents" tmux session).
//
// Every control here does something visible or says why it can't: a failed open
// is an error toast, a failed create is an inline alert in the dialog, an invalid
// agent's row is disabled with its error as the tooltip.

import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { AgentInfo } from "../shared/types";
import { IconButton } from "./IconButton";
import { Button } from "./Button";
import { useStore } from "./store";
import { agentInitial, leadAgent } from "./agentDispatch";
import { Tag } from "./Tag";
import { refreshPackageAgents, usePackageAgents } from "./packageAgents";

const ROW_CLASS =
  "group relative z-[1] flex w-full items-center gap-2 rounded-md min-h-[var(--row-h)] px-[var(--row-px)] py-[var(--row-py)] text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";

const FIELD_CLASS =
  "w-full rounded-md border border-border bg-bg px-2 py-2 text-body text-text placeholder:text-text-quiet outline-none focus-visible:ring-2 focus-visible:ring-accent";

function AgentRow({
  agent,
  opening,
  onOpen,
}: {
  agent: AgentInfo;
  opening: boolean;
  onOpen: () => void;
}) {
  const invalid = !!agent.error;
  const isLead = agent.role === "lead" && !invalid;
  const noticeId = useId();
  const showNotice = !!agent.notice;
  return (
    <>
      <button
        type="button"
        data-rail-row=""
        data-testid="agent-row"
        data-slug={agent.slug}
        disabled={invalid || opening}
        onClick={onOpen}
        aria-describedby={showNotice ? noticeId : undefined}
        title={invalid ? `${agent.name || agent.slug}: ${agent.error}` : agent.description || agent.name}
        className={`${ROW_CLASS} ${invalid ? "opacity-50 cursor-not-allowed" : "hover:bg-fill-hover"}`}
      >
        <span
          aria-hidden="true"
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-sm bg-fill-hover text-micro font-semibold text-text"
          style={agent.color ? { backgroundColor: agent.color, color: "#fff" } : undefined}
        >
          {agentInitial(agent)}
        </span>
        <span className="flex-1 min-w-0 truncate text-label font-medium text-text">{agent.name || agent.slug}</span>
        {isLead && (
          <Tag size="sm" tone="accent" title="Leads every chat and hands work to the other agents">
            lead
          </Tag>
        )}
        {opening && <span className="shrink-0 text-micro text-text-faint">Opening…</span>}
        {invalid && <span className="shrink-0 text-micro text-danger">invalid</span>}
      </button>
      {showNotice && (
        <p id={noticeId} data-testid="agent-notice" className="m-0 px-[var(--row-px)] pb-1 text-micro text-text-faint">
          {agent.notice}
        </p>
      )}
    </>
  );
}

function CreateAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    // No close() in a cleanup: under StrictMode the effect runs twice, and a
    // cleanup close() queues a "close" event that lands after the reopen and
    // unmounts the dialog. Unmounting removes it from the top layer anyway.
    if (!d.open) d.showModal();
    // showModal() focuses the first focusable control; the name field is the one we want.
    nameRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.agentsCreate({ name: name.trim(), description: description.trim() });
      onCreated();
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't create the agent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="new-agent-title"
      onClose={onClose}
      className="w-[360px] max-w-[92vw] rounded-lg border border-border bg-bg-elev p-4 text-text shadow-md backdrop:bg-bg/[0.7]"
    >
      <form method="dialog" onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <h2 id="new-agent-title" className="text-body font-semibold">
          New agent
        </h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-agent-name" className="text-meta text-text-muted">
            Name
          </label>
          <input
            id="new-agent-name"
            ref={nameRef}
            type="text"
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Reviewer"
            autoComplete="off"
            className={FIELD_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-agent-description" className="text-meta text-text-muted">
            What does it do? (one line)
          </label>
          <input
            id="new-agent-description"
            type="text"
            required
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Reviews pull requests for bugs and risky changes."
            autoComplete="off"
            className={FIELD_CLASS}
          />
        </div>
        {error && (
          <p role="alert" className="m-0 text-meta text-danger break-words" data-testid="new-agent-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button tone="default" onClick={() => dialogRef.current?.close()}>
            Cancel
          </Button>
          <Button tone="primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

export function AgentsSection({
  onOpenWindow,
}: {
  /** Select a window of the agents' tmux session (the caller re-lists the tree and activates it). */
  onOpenWindow: (tmuxSession: string, windowIndex: number) => Promise<void>;
}) {
  const { agents } = usePackageAgents();
  const pushAppToast = useStore((s) => s.pushAppToast);
  const [creating, setCreating] = useState(false);
  const [openingSlug, setOpeningSlug] = useState<string | null>(null);

  // A box without the feature (or the demo transport) has no agents to show.
  if (!agents || agents.length === 0) return null;

  // The valid lead first, then the rest in the box's order (one row per package, no synthetic rows).
  const lead = leadAgent(agents);
  const ordered = lead ? [lead, ...agents.filter((a) => a !== lead)] : agents;

  const open = async (agent: AgentInfo) => {
    if (openingSlug) return;
    setOpeningSlug(agent.slug);
    try {
      const r = await window.api.agentsOpenChat({ slug: agent.slug });
      await onOpenWindow(r.tmuxSession, r.windowIndex);
    } catch (e) {
      pushAppToast({
        tone: "error",
        message: `Couldn't open ${agent.name || agent.slug}: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setOpeningSlug(null);
    }
  };

  return (
    <div className="px-1 pb-2" data-testid="agents-section">
      <div className="flex items-center justify-between px-1 py-1">
        <h3 className="m-0 text-micro font-semibold uppercase tracking-wider text-text-quiet">Agents</h3>
        <IconButton icon={<Plus />} label="New agent" title="New agent" onClick={() => setCreating(true)} />
      </div>
      <div className="space-y-px">
        {ordered.map((a) => (
          <AgentRow key={a.slug} agent={a} opening={openingSlug === a.slug} onOpen={() => void open(a)} />
        ))}
      </div>
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={() => refreshPackageAgents()}
        />
      )}
    </div>
  );
}

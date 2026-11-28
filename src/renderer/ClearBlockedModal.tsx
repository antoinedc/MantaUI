// "Clear conversation…" of an agent's conversation, when it can't be cleared (docs/screens/agents/chat-tasks-decisions.md §5): a task
// started from the conversation is running, paused or still starting, and its result comes back HERE — clearing would lose it. The
// dialog opens already in this state (from the job store), and also when the box refused a Clear that was pressed (a race): same words.
// The tasks are listed so "it" is concrete; Open Fleet is where a task is stopped; there is no Clear button in this state.

import { useEffect, useRef } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { clearRefusalSentence, withStop, type BlockingTask } from "./chatTask";

export type ClearBlock = {
  tasks: BlockingTask[];
  /** The box's own refusal sentence, when Clear was pressed and refused (shown as it is, with a full stop). */
  refusal: string | null;
  onOpenFleet: () => void;
  /** The dialog was closed: a stored refusal is forgotten (the tasks may be done by the next press). */
  onDismiss?: () => void;
};

export function ClearBlockedModal({ open, agentName, block, onClose }: { open: boolean; agentName: string; block: ClearBlock; onClose: () => void }) {
  const title = `Clear your conversation with ${agentName}?`;
  return (
    <Modal size="sm" open={open} onDismiss={onClose} label={title}>
      <Body title={title} agentName={agentName} block={block} onClose={onClose} />
    </Modal>
  );
}

function Body({ title, agentName, block, onClose }: { title: string; agentName: string; block: ClearBlock; onClose: () => void }) {
  const sentence = block.refusal ? withStop(block.refusal) : clearRefusalSentence(agentName, block.tasks.length);
  const actions = useRef<HTMLDivElement | null>(null);
  // Close is the safe default: focus starts on it (the dialog's own focus trap leaves focus alone when something inside holds it)
  useEffect(() => {
    (actions.current?.lastElementChild as HTMLElement | null)?.focus();
  }, []);
  return (
    <>
      <div className="space-y-4">
        <h3 className="text-title font-semibold">{title}</h3>
        <div role="alert" className="rounded-md border border-warn/40 bg-fill px-3 py-2 text-body text-text">
          {sentence}
        </div>
        {block.tasks.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-label text-text-muted" aria-label="Tasks running from this conversation">
            {block.tasks.map((t) => (
              <li key={t.key} className="break-words">
                {[t.title, t.project, t.status].filter(Boolean).join(" · ")}
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-body text-text-faint">Its result comes back to this conversation, so clearing now would lose it. Stop a task from Fleet.</p>
        <div ref={actions} className="flex justify-end gap-2">
          <Button
            tone="default"
            onClick={() => {
              onClose();
              block.onOpenFleet();
            }}
          >
            Open Fleet
          </Button>
          <Button tone="primary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </>
  );
}

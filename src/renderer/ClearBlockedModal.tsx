// "Clear conversation…" of an agent's conversation, when it can't be cleared (docs/screens/agents/chat-tasks-decisions.md §5): a task
// started from the conversation is running, paused or still starting, and its result comes back HERE — clearing would lose it. The
// dialog opens already in this state (from the job store), and also when the box refused a Clear that was pressed (a race): same words.
// The tasks are listed so "it" is concrete; Open Fleet is where a task is stopped; there is no Clear button in this state.
//
// A native modal <dialog> opened with showModal() (guide `dialog`, the same as StopTaskDialog): the browser gives it the inert page,
// focus containment, the top layer and Escape; nothing here re-implements any of that. Close is the focused choice (autofocus).
// Which button closed it is read from `returnValue` in the `close` listener ("" = Escape = just close). It is only in the page while
// open, so a closed one never leaves its text behind.

import { useEffect, useId, useRef } from "react";
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
  return open ? <Dialog agentName={agentName} block={block} onClose={onClose} /> : null;
}

function Dialog({ agentName, block, onClose }: { agentName: string; block: ClearBlock; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const title = `Clear your conversation with ${agentName}?`;
  const sentence = block.refusal ? withStop(block.refusal) : clearRefusalSentence(agentName, block.tasks.length);
  const blockRef = useRef(block);
  blockRef.current = block;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The primitive Button takes no `autofocus`, and React's `autoFocus` prop is a focus() call that does nothing in a closed dialog: the
  // attribute itself is what showModal() reads, so it is set on the safe action (Close) before the dialog is shown.
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Close")?.setAttribute("autofocus", "");
    if (!dlg.open) dlg.showModal();
    const onNativeClose = () => {
      const chosen = dlg.returnValue;
      dlg.returnValue = "";
      onCloseRef.current();
      if (chosen === "fleet") blockRef.current.onOpenFleet();
    };
    dlg.addEventListener("close", onNativeClose);
    return () => dlg.removeEventListener("close", onNativeClose);
  }, []);

  return (
    <dialog ref={ref} aria-labelledby={headingId} data-testid="clear-blocked-dialog" className="m-auto w-[min(420px,calc(100vw-32px))] rounded-lg border border-border bg-bg-soft p-5 text-text [overscroll-behavior:contain] backdrop:overflow-hidden backdrop:bg-black/45 backdrop:[overscroll-behavior:contain]">
      <h1 id={headingId} className="m-0 mb-3 text-title font-semibold text-text">
        {title}
      </h1>
      <div role="alert" className="mb-3 rounded-md border border-warn/40 bg-fill px-3 py-2 text-body text-text">
        {sentence}
      </div>
      {block.tasks.length > 0 && (
        <ul className="m-0 mb-3 flex list-none flex-col gap-1 p-0 text-label text-text-muted" aria-label="Tasks running from this conversation">
          {block.tasks.map((t) => (
            <li key={t.key} className="break-words">
              {[t.title, t.project, t.status].filter(Boolean).join(" · ")}
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 mb-4 text-body text-text-faint">Its result comes back to this conversation, so clearing now would lose it. Stop a task from Fleet.</p>
      <div className="flex justify-end gap-2">
        <Button tone="default" onClick={() => ref.current?.close("fleet")}>
          Open Fleet
        </Button>
        <Button tone="primary" onClick={() => ref.current?.close("close")}>
          Close
        </Button>
      </div>
    </dialog>
  );
}

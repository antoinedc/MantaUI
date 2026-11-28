// The Stop confirmation of a running task (Fleet redesign spec §3, guides `dialog`, `html`, `accessibility` §12): a native modal
// <dialog>, opened with showModal() — the browser gives it the inert page, focus containment, the top layer and Esc; nothing here
// re-implements any of that. "Keep running" is the focused choice (autofocus), so a stray Enter or Esc leaves the task alone.
// Which button closed it is read from `returnValue` in the `close` listener and reset ("" = dismissed without choosing = keep).

import { useEffect, useId, useRef } from "react";
import { Button } from "../Button";

export function StopTaskDialog({ open, title, onClose }: { open: boolean; title: string; /** `true`: the user chose to stop it. */ onClose: (stop: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const openRef = useRef(open);
  openRef.current = open;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  }, [open]);

  // The primitive Button takes no `autofocus`, and React turns the `autoFocus` prop into a focus() call that does nothing in a closed
  // dialog: the attribute itself is what showModal() reads, so it goes on the safe action (the first button) here.
  useEffect(() => {
    ref.current?.querySelector("button")?.setAttribute("autofocus", "");
  }, []);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const onNativeClose = () => {
      const chosen = dlg.returnValue;
      dlg.returnValue = "";
      // closed because the page said so (the prop is already false): nobody chose anything
      if (!openRef.current) return;
      onCloseRef.current(chosen === "stop");
    };
    dlg.addEventListener("close", onNativeClose);
    return () => dlg.removeEventListener("close", onNativeClose);
  }, []);

  return (
    <dialog ref={ref} aria-labelledby={headingId} data-testid="stop-dialog" className="m-auto w-[min(420px,calc(100vw-32px))] rounded-lg border border-border bg-bg-soft p-5 text-text [overscroll-behavior:contain] backdrop:overflow-hidden backdrop:bg-black/45 backdrop:[overscroll-behavior:contain]">
      <h1 id={headingId} className="m-0 mb-2 text-body font-semibold text-text">
        Stop this task?
      </h1>
      <p className="m-0 mb-2 break-words text-label font-semibold text-text">{title}</p>
      <p className="m-0 mb-2 text-label text-text-muted">The agent stops now. What it has done so far is kept, and the task moves to Ended today.</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button tone="default" onClick={() => ref.current?.close("keep")}>
          Keep running
        </Button>
        <Button tone="danger" onClick={() => ref.current?.close("stop")}>
          Stop task
        </Button>
      </div>
    </dialog>
  );
}

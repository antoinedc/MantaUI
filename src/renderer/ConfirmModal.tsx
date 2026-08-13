// ConfirmModal.tsx — the shared confirm dialog for destructive actions
// reached from a menu (BET-724 Task 3 / design decision D7).
//
// Built on the Modal primitive, which now owns Escape/backdrop/focus trap
// (BET-724 Task 1) — so Escape and backdrop click both mean Cancel here,
// never Confirm. Typography matches the two pre-existing in-app confirms
// (App.tsx's "Update the box?", Settings.tsx's "Remove box?" / "Reset all
// settings?") rather than inventing a new type scale.

import type { ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  confirmTone = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmTone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal size="sm" open={open} onDismiss={onCancel} label={title}>
      <div className="space-y-4">
        <h3 className="text-title font-semibold">{title}</h3>
        <div className="text-body text-text-faint">{body}</div>
        <div className="flex justify-end gap-2">
          <Button tone="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button tone={confirmTone} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

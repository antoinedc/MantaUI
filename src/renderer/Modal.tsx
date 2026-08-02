// Modal.tsx — the modal shell primitive (BET-588, M527 stage 2).
//
// Owns the ONE shared modal chrome with NO `className` escape hatch (epic
// standing decision 3): a caller cannot shear the overlay tint / panel
// surface / width / padding, so a dialog library can only drift if Modal
// itself is retuned. The four props express what every in-app dialog needs:
//
//   size      — fixed panel width: "sm" 420px | "md" 480px | "lg" 560px
//   padded    — true → p-4; false → the child owns its own insets
//   tall      — true → max-h-[80vh] + flex flex-col + clips (list dialogs)
//   onDismiss — overlay click; omit for a modal that must be answered
//
// Escape handling stays at the call sites (two of them already bind it;
// owning it here would double-handle). The five migrating dialogs are the
// adopter set that clears the two-adopter rule (Sidebar / NewSessionScreen /
// Settings ×2 / FolderPickerModal).

import type { MouseEvent, ReactNode } from "react";

const SIZES = {
  sm: "w-[420px]",
  md: "w-[480px]",
  lg: "w-[560px]",
} as const;

export function Modal({
  size = "md",
  padded = true,
  tall = false,
  onDismiss,
  label,
  children,
}: {
  size?: "sm" | "md" | "lg";
  padded?: boolean;
  tall?: boolean;
  onDismiss?: () => void;
  label: string;
  children?: ReactNode;
}) {
  const panel = [
    "bg-bg-elev border border-border rounded-lg shadow-lg max-w-[92vw]",
    SIZES[size],
    padded ? "p-4" : "",
    tall ? "max-h-[80vh] flex flex-col overflow-hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={panel}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

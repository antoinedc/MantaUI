// ===== ConfirmInline (BET-1320) =====
//
// Shared inline destructive-confirm: the danger-toned confirm button ("…"
// while busy) plus the ghost Cancel, used by every account-row action whose
// server-side effect is destructive (disconnect, remove). Extracted from the
// account row's inline copy so the two confirm flows render identically —
// the exact markup that used to live inline in AccountsCard's disconnect
// branch. No styling beyond the moved classes, no new tokens.

export function ConfirmInline({ label, busy, onConfirm, onCancel }: {
  label: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button
        onClick={onConfirm}
        disabled={busy}
        className="px-2 py-1 text-meta bg-danger-bg border border-danger rounded-xs text-danger hover:text-danger disabled:opacity-40"
      >
        {busy ? "…" : label}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className="px-2 py-1 text-meta text-text-faint hover:text-text disabled:opacity-40"
      >
        Cancel
      </button>
    </>
  );
}

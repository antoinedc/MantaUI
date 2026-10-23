// ReclaimRow.tsx — "Old conversation history" row in Settings → About (cleanup spec §6).
//
// After a copy-mode migration to OpenCode 2 the untouched V1 history exists only so the box can be
// rolled back. This row lets the user delete it (a one-way choice) to free disk space.
//
// Shown ONLY when the box says it is available (AGENTS.md outcome 3: no dead control). Every press
// ends visibly: success → a toast naming the freed size and the row disappears; failure → the
// server's message inline (role=alert) and the row stays so the user can retry.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReclaimStatus } from "../shared/api";
import { useStore } from "./store";
import { Button } from "./Button";
import { ConfirmModal } from "./ConfirmModal";
import { formatBytes } from "./chatUtils";

/** Confirm-dialog body, verbatim from the spec; "{size}" is dropped gracefully when unknown. */
export function reclaimConfirmBody(bytes: number | null): string {
  const size = bytes ? formatBytes(bytes) : "";
  return (
    `This frees ${size || "disk space"}. Your conversations are already in the new format and are not affected. ` +
    "You will no longer be able to roll the box back to the old version."
  );
}

export function reclaimDoneMessage(freedBytes: number): string {
  const size = formatBytes(freedBytes);
  return size ? `Freed ${size} of disk space` : "Freed disk space";
}

export function ReclaimRow() {
  const push = useStore((s) => s.pushAppToast);
  const [status, setStatus] = useState<ReclaimStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      // A box that predates the route answers null; a client without the method (the pre-pairing
      // preload subset) has nothing to ask — either way there is no row to show.
      const s = (await window.api.upgradeReclaimStatus?.()) ?? null;
      if (alive.current) setStatus(s);
    } catch (e) {
      // Not a user action: the row simply isn't offered when the box can't be asked.
      console.warn("[reclaim] could not read the reclaim status:", e);
      if (alive.current) setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setConfirming(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.upgradeReclaim();
      if (!alive.current) {
        // Settings closed mid-delete: the toast is still the confirmation.
        if (r.ok) push({ message: reclaimDoneMessage(r.freedBytes) });
        else push({ message: `Couldn't free the space: ${r.error}`, tone: "error" });
        return;
      }
      if (r.ok) {
        push({ message: reclaimDoneMessage(r.freedBytes) });
        setStatus(null); // the row disappears
      } else {
        setError(r.error);
        await load(); // the box may now report a partial run it can resume
      }
    } catch (e) {
      // upgradeReclaim never rejects on a refusal; a 401 does (AuthRequiredError).
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (!status || !status.available) return null;
  const size = status.bytes ? formatBytes(status.bytes) : "";

  return (
    <div className="space-y-2 pt-2 border-t border-border" data-testid="reclaim-row">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-body text-text">
            Old conversation history (from before the OpenCode 2 upgrade)
          </div>
          <div className="text-meta text-text-faint">
            {size ? `Using ${size} on the box. ` : ""}
            {status.state === "failed" ? "A previous attempt didn't finish — you can run it again. " : ""}
            Only needed to roll the box back.
          </div>
        </div>
        <Button tone="danger" onClick={() => setConfirming(true)} disabled={busy} loading={busy}>
          Delete to free space
        </Button>
      </div>
      {error && (
        <div role="alert" className="text-meta text-danger break-words">
          Couldn't free the space: {error}
        </div>
      )}
      <ConfirmModal
        open={confirming}
        title="Delete the old history?"
        body={reclaimConfirmBody(status.bytes)}
        confirmLabel="Delete"
        onConfirm={() => void run()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

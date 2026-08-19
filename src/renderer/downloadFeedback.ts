// ===== Download confirmation — the ONE place a save reports itself =====
//
// Every desktop download funnels through `window.api.agentPullFile` (BET-1156:
// preload bridge → main writes a real file to the downloads folder and returns
// its absolute path). What it did NOT have was feedback: the inline-media
// hover/preview Download and the artifacts row were fire-and-forget — success
// showed nothing, and a rejection surfaced only as an "Uncaught (in promise)"
// in devtools. A save the user cannot see reads as a save that did not happen,
// which is exactly how a WORKING inline-media download got reported as broken.
//
// So: one helper, used by every non-toast download call site, that always ends
// in a visible outcome —
//   desktop success → "Saved <name> to <full folder>" + Reveal
//   mobile/web      → nothing (agentPullFile returns "": the browser owns the
//                     download chrome there; a toast would duplicate it)
//   failure         → an error toast that says the file was NOT saved
//
// The agent-file toast (GlobalToasts) keeps its own Save/Reveal lifecycle — it
// mutates a toast that already exists rather than pushing a new one — but shares
// the same copy via `savedToastMessage` so the two can't drift.

import { describeSavedFile } from "./chatUtils";
import { useStore } from "./store";

/** Confirmation copy for a saved file. Exported so the agent-file toast and
 *  this helper render the SAME sentence. `dir` is the full folder path: with a
 *  custom downloads folder configured, "saved to Downloads" is ambiguous and
 *  the user has to go hunting. */
export function savedToastMessage(localPath: string): string | null {
  const saved = describeSavedFile(localPath);
  if (!saved) return null;
  return saved.dir ? `Saved ${saved.name} to ${saved.dir}` : `Saved ${saved.name}`;
}

/**
 * Pull a box file to the user's machine and report the outcome.
 *
 * Never throws — a download is an incidental action, so a failure is a toast,
 * not an exception the caller has to remember to catch (forgetting is what put
 * the "Uncaught (in promise)" in the console).
 */
export async function saveToDownloads(remotePath: string): Promise<void> {
  if (!remotePath) return;
  const { pushAppToast } = useStore.getState();
  try {
    const localPath = await window.api.agentPullFile(remotePath);
    const message = savedToastMessage(localPath);
    // No local path → mobile/web, where the browser already shows its own
    // download UI. Staying silent there is deliberate, not a missing case.
    if (!message) return;
    pushAppToast({
      message,
      actions: [
        {
          label: "Reveal",
          onClick: () => void window.api.revealInFolder(localPath),
        },
      ],
    });
  } catch {
    // The source file stays on the box (downloads are non-destructive), so a
    // retry is always safe — say so instead of failing silently.
    pushAppToast({
      tone: "error",
      message: "Couldn’t save the file — it’s still on the server, try again.",
    });
  }
}

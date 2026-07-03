// composer.ts — pure send-gate logic for the SessionDetailScreen composer.
//
// The composer is the mobile port of the desktop ChatPanel's submit() gate
// (src/renderer/ChatPanel.tsx). The box `opencode:prompt` RPC expects a
// non-empty text; sending mid-turn would race the running generation. This
// module owns the "can I submit, and what text do I send" decision so the
// component stays a thin TextInput + Send/Stop button with no branching logic.
//
// Kept PURE — no RN, no fetch, no state — so the gate is fully unit-tested
// without a live box, exactly like the other mobile-rn pure modules.

/**
 * Whether the composer's Send action is allowed right now.
 *
 * Rules (mirror of the desktop submit() gate):
 *  - the trimmed draft must be non-empty (an all-whitespace draft sends nothing);
 *  - the session must not already be running a turn (sending mid-turn would
 *    race the in-flight generation — the user aborts first, then sends).
 *
 * Pure.
 */
export function canSubmitPrompt(draft: string, running: boolean): boolean {
  if (running) return false;
  return draft.trim().length > 0;
}

/**
 * Normalize a draft into the exact text the box `opencode:prompt` RPC should
 * receive: outer whitespace trimmed (matching the desktop, which trims before
 * building the text part). Returns null when the draft is not submittable, so
 * a caller can `const text = preparePrompt(draft); if (!text) return;` without
 * re-checking the gate.
 *
 * Pure.
 */
export function preparePrompt(draft: string): string | null {
  const text = draft.trim();
  return text.length > 0 ? text : null;
}

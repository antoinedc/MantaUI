// ===== useInputHistory =====
//
// Extracted from ChatPanel.tsx (BET-63). Terminal-style prompt history for the
// composer textarea: Up cycles to older submitted prompts, Down cycles back
// toward the live draft. Self-contained behavior with an explicit dependency
// surface — it derives the history list from the transcript's user turns and
// drives the textarea via the injected setters/ref, so it never reaches into
// the container's SSE / pin-to-bottom / drain state.
//
// Injected deps (all owned by ChatPanel's composer state):
//   - `messages`      — transcript; `promptHistory` is derived from its user
//                       turns (chronological, freshest last).
//   - `inputRef`      — the textarea, for reading the current draft on entry
//                       and placing the caret at end after a value swap.
//   - `setInput`      — set the textarea value directly (bypassing typeahead
//                       detection) when cycling history.
//   - `setTypeahead`  — closed while cycling so a recalled `@`/`/` prompt
//                       doesn't immediately pop the completion list.
//   - `updateInput`   — the normal typing path (WITH typeahead detection);
//                       `updateInputWithHistoryReset` wraps it to also exit
//                       history mode when the user edits by typing.
//
// The active index lives entirely inside `navigateHistory`'s setState (never
// read elsewhere), so this hook exposes only the two callbacks + the derived
// list. Identical behavior to the original inline implementation.

import { useCallback, useMemo, useRef, useState } from "react";
import type { OpencodeMessage } from "../../shared/types";
import type { TypeaheadState } from "../chatShared";

export type InputHistory = {
  promptHistory: string[];
  navigateHistory: (dir: 1 | -1) => void;
  updateInputWithHistoryReset: (next: string) => void;
};

export function useInputHistory(params: {
  messages: OpencodeMessage[] | null;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  setInput: (v: string) => void;
  setTypeahead: React.Dispatch<React.SetStateAction<TypeaheadState | null>>;
  updateInput: (next: string) => void;
}): InputHistory {
  const { messages, inputRef, setInput, setTypeahead, updateInput } = params;

  // Active history index. Internal to navigateHistory's setter — never read
  // elsewhere, so the setter is all we keep. draftInput saves whatever the
  // user was typing before they entered history mode so it can be restored on
  // Down past the newest entry.
  const [, setHistoryIdx] = useState<number | null>(null);
  const draftInput = useRef<string>("");

  // Prompt history from user messages — chronological, freshest last.
  const promptHistory = useMemo<string[]>(() => {
    if (!messages) return [];
    const out: string[] = [];
    for (const m of messages) {
      if (m.info.role !== "user") continue;
      const text = m.parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      if (text) out.push(text);
    }
    return out;
  }, [messages]);

  // Prompt history navigation — Up cycles back, Down cycles forward. We bypass
  // updateInput's typeahead detection here (calling setInput directly) so
  // cycling through past prompts containing `@` or `/` doesn't immediately open
  // a typeahead popup.
  const navigateHistory = useCallback(
    (dir: 1 | -1) => {
      if (promptHistory.length === 0) return;
      setHistoryIdx((cur) => {
        // dir === -1 means UP (older), +1 means DOWN (newer).
        let next: number | null;
        if (cur == null) {
          // Entering history mode — save the current draft so we can restore
          // it when the user presses Down past the newest entry.
          if (dir === -1) {
            draftInput.current = inputRef.current?.value ?? "";
            next = promptHistory.length - 1;
          } else {
            // Already at newest — no-op.
            return cur;
          }
        } else {
          const candidate = cur + dir;
          if (candidate < 0) next = 0;
          else if (candidate >= promptHistory.length) next = null;
          else next = candidate;
        }
        // null means "back to draft" (past the newest entry).
        const value = next == null ? draftInput.current : promptHistory[next];
        setInput(value);
        setTypeahead(null);
        // Place caret at end after React commits the new value.
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          const pos = value.length;
          el.setSelectionRange(pos, pos);
        });
        return next;
      });
    },
    [promptHistory, inputRef, setInput, setTypeahead],
  );

  // Reset history-navigation mode whenever the user edits the input by typing
  // (not via Up/Down). Keeps history "session" per stretch of edits.
  const updateInputWithHistoryReset = useCallback(
    (next: string) => {
      setHistoryIdx(null);
      draftInput.current = next;
      updateInput(next);
    },
    [updateInput],
  );

  return { promptHistory, navigateHistory, updateInputWithHistoryReset };
}

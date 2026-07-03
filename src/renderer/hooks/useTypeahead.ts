// ===== useTypeahead =====
//
// Extracted from ChatPanel.tsx (BET-64). Owns the @-mention / command
// typeahead popup: detection, lazy fetching of commands/agents, debounced
// file search, result filtering, and selection application.
//
// Self-contained: owns its own state (typeahead, commands, agents, fileResults)
// and refs (fileSearchSeqRef, fileSearchTimer). Dependencies are injected via
// params — it never reaches into the container's SSE / pin-to-bottom / drain
// state. The hook is callback-driven (no effects) so it's trivially testable
// with the render harness.
//
// The textarea's onChange routes through `updateInput` which both updates
// `input` state and detects active typeahead. Three triggers:
//   /<word>      at byte 0 → command typeahead
//   @<token>     after whitespace (or BOF) → file+agent typeahead
// The popup tracks the [anchorStart, anchorEnd) slice and replaces it
// verbatim on selection.

import { useCallback, useMemo, useRef, useState } from "react";
import type { OpencodeAgent, OpencodeCommand } from "../../shared/types";
import {
  filterCommands,
  dedupeAgainstBuiltins,
} from "../chatUtils";
import type {
  TypeaheadState,
  TypeaheadRow,
  AgentMention,
} from "../chatShared";

// bui-local slash commands. These are handled in the renderer (not forwarded
// to opencode's /command endpoint) because opencode doesn't ship equivalents
// — they're terminal-TUI conventions users expect to "just work".
const BUI_BUILTIN_COMMANDS = [
  { name: "clear", description: "Start a fresh chat in this window" },
  { name: "fork", description: "Copy this session's history into a new window" },
  { name: "compact", description: "Summarize to free context" },
  { name: "help", description: "Show available commands" },
] as const;
const BUI_BUILTIN_NAMES = new Set(BUI_BUILTIN_COMMANDS.map((c) => c.name));

export type Typeahead = {
  // Popup state — null when closed.
  typeahead: TypeaheadState | null;
  setTypeahead: React.Dispatch<React.SetStateAction<TypeaheadState | null>>;
  // Popup rows — the filtered result list the popup renders.
  typeaheadRows: TypeaheadRow[];
  // Available opencode commands (loaded on demand).
  commands: OpencodeCommand[] | null;
  // Callbacks.
  onTypeaheadSelect: (row: TypeaheadRow) => void;
  onTypeaheadHover: (idx: number) => void;
  onTypeaheadConfirm: () => void;
  onTypeaheadMove: (dir: 1 | -1) => void;
  onTypeaheadCancel: () => void;
  // Derived booleans.
  typeaheadOpen: boolean;
  typeaheadExactMatch: boolean;
  // Input path (used by the textarea's onChange).
  updateInput: (next: string) => void;
  // History navigation (Up/Down cycles past prompts).
  onHistoryUp: () => void;
  onHistoryDown: () => void;
};

export function useTypeahead(params: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  cwd: string;
  currentModelSupportsAttachments: boolean;
  currentModelName: string;
  agentMentions: AgentMention[];
  setAgentMentions: React.Dispatch<React.SetStateAction<AgentMention[]>>;
}): Typeahead {
  const {
    input,
    setInput,
    inputRef,
    cwd,
    currentModelSupportsAttachments,
    currentModelName,
    setAgentMentions,
  } = params;
  // agentMentions consumed via setAgentMentions in applyTypeahead (agent mode)

  const [typeahead, setTypeahead] = useState<TypeaheadState | null>(null);
  const [commands, setCommands] = useState<OpencodeCommand[] | null>(null);
  const [agents, setAgents] = useState<OpencodeAgent[] | null>(null);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const fileSearchSeqRef = useRef(0);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ensureCommands = useCallback(async () => {
    if (commands) return;
    try {
      const c = await window.api.opencodeCommands();
      setCommands(c);
    } catch { /* non-fatal */ }
  }, [commands]);

  const ensureAgents = useCallback(async () => {
    if (agents) return;
    try {
      const a = await window.api.opencodeAgents();
      setAgents(a);
    } catch { /* non-fatal */ }
  }, [agents]);

  // File search: sequence-tracked so stale responses don't clobber the
  // latest. Empty query is passed through — opencode's /find/file returns a
  // browse-style listing of the directory's top-level entries.
  const searchFiles = useCallback(
    (query: string) => {
      if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);
      if (!cwd) {
        setFileResults([]);
        return;
      }
      fileSearchTimer.current = setTimeout(async () => {
        fileSearchTimer.current = null;
        const seq = ++fileSearchSeqRef.current;
        try {
          const list = await window.api.opencodeFindFiles({ query, directory: cwd });
          if (seq === fileSearchSeqRef.current) setFileResults(list.slice(0, 20));
        } catch {
          if (seq === fileSearchSeqRef.current) setFileResults([]);
        }
      }, 80);
    },
    [cwd],
  );

  const detectTypeahead = useCallback(
    (text: string, caret: number): TypeaheadState | null => {
      // Command typeahead — fires only when "/" is the very first character
      // of the input AND the caret is somewhere inside the first word.
      if (text.startsWith("/")) {
        const m = /^\/([\w-]*)/.exec(text);
        if (m && caret <= m[0].length) {
          return {
            mode: "command",
            query: m[1],
            anchorStart: 0,
            anchorEnd: m[0].length,
            selectedIdx: 0,
          };
        }
      }
      // @-mention typeahead — fires when an @ token starts at BOF or after
      // whitespace and the caret is inside that token.
      const left = text.slice(0, caret);
      const at = left.lastIndexOf("@");
      if (at >= 0) {
        const prev = at > 0 ? text[at - 1] : "";
        if (at === 0 || /\s/.test(prev)) {
          const after = text.slice(at + 1, caret);
          if (!/\s/.test(after)) {
            let end = caret;
            while (end < text.length && !/\s/.test(text[end])) end++;
            return {
              mode: after.startsWith("@") ? "agent" : "file",
              query: after.replace(/^@/, ""),
              anchorStart: at,
              anchorEnd: end,
              selectedIdx: 0,
            };
          }
        }
      }
      return null;
    },
    [],
  );

  const updateInput = useCallback(
    (next: string) => {
      setInput(next);
      const el = inputRef.current;
      const caret = el?.selectionStart ?? next.length;
      const t = detectTypeahead(next, caret);
      setTypeahead(t);
      if (t) {
        if (t.mode === "command") void ensureCommands();
        else if (t.mode === "agent") void ensureAgents();
        else if (t.mode === "file") void searchFiles(t.query);
      }
    },
    [detectTypeahead, ensureCommands, ensureAgents, searchFiles],
  );

  // Build the active typeahead's filtered result list.
  const typeaheadRows = useMemo<TypeaheadRow[]>(() => {
    if (!typeahead) return [];
    const q = typeahead.query.toLowerCase();
    if (typeahead.mode === "command") {
      const builtins = filterCommands([...BUI_BUILTIN_COMMANDS], q).map((c) => ({
        kind: "command" as const,
        key: c.name,
        primary: `/${c.name}`,
        secondary: c.description,
      }));
      const ocRows = dedupeAgainstBuiltins(
        filterCommands(commands ?? [], q),
        BUI_BUILTIN_NAMES,
      ).map((c) => ({
        kind: "command" as const,
        key: c.name,
        primary: `/${c.name}`,
        secondary: c.description,
      }));
      return [...builtins, ...ocRows].slice(0, 12);
    }
    if (typeahead.mode === "agent") {
      const all = agents ?? [];
      const filtered = q
        ? all.filter((a) => a.name.toLowerCase().includes(q))
        : all;
      return filtered.slice(0, 12).map((a) => ({
        kind: "agent",
        key: a.name,
        primary: `@@${a.name}`,
        secondary: a.description,
      }));
    }
    // File mode — if the active model can't take attachments, show a single
    // red "not supported" row.
    if (!currentModelSupportsAttachments) {
      return [
        {
          kind: "file",
          key: "",
          primary: `⚠ ${currentModelName} doesn't support file attachments`,
          secondary: "Pick a model with attachment support to enable @-mentions",
        },
      ];
    }
    return fileResults.map((p) => ({
      kind: "file",
      key: p,
      primary: `@${p}`,
      secondary: undefined,
    }));
  }, [
    typeahead,
    commands,
    agents,
    fileResults,
    currentModelSupportsAttachments,
    currentModelName,
  ]);

  // Apply a typeahead selection: rewrite the [anchorStart, anchorEnd) slice
  // and re-position the caret.
  const applyTypeahead = useCallback(
    (row: TypeaheadRow) => {
      if (!typeahead) return;
      const { anchorStart, anchorEnd, mode } = typeahead;
      const before = input.slice(0, anchorStart);
      const after = input.slice(anchorEnd);
      let insertion = row.primary;
      let trailingSpace = " ";
      if (mode === "command") {
        insertion = `/${row.key}`;
      } else if (mode === "file") {
        insertion = `@${row.key}`;
      } else if (mode === "agent") {
        insertion = `@${row.key}`;
      }
      const next = before + insertion + trailingSpace + after;
      setInput(next);
      setTypeahead(null);

      if (mode === "agent") {
        const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setAgentMentions((prev) => [...prev, { id, name: row.key }]);
      }

      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        const pos = before.length + insertion.length + trailingSpace.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [typeahead, input, cwd],
  );

  const moveTypeaheadSelection = useCallback(
    (dir: 1 | -1) => {
      setTypeahead((prev) => {
        if (!prev) return prev;
        const n = typeaheadRows.length;
        if (n === 0) return prev;
        const next = (prev.selectedIdx + dir + n) % n;
        return { ...prev, selectedIdx: next };
      });
    },
    [typeaheadRows.length],
  );

  const typeaheadOpen = typeahead !== null && typeaheadRows.length > 0;
  const typeaheadExactMatch =
    typeahead !== null &&
    typeaheadRows.length > 0 &&
    typeahead.selectedIdx >= 0 &&
    typeahead.selectedIdx < typeaheadRows.length &&
    typeaheadRows[typeahead.selectedIdx]?.key !== undefined;

  return {
    typeahead,
    setTypeahead,
    typeaheadRows,
    commands,
    onTypeaheadSelect: applyTypeahead,
    onTypeaheadHover: () => {}, // no-op; hover is handled by InputArea
    onTypeaheadConfirm: () => {}, // no-op; confirm is handled by InputArea
    onTypeaheadMove: moveTypeaheadSelection,
    onTypeaheadCancel: () => setTypeahead(null),
    typeaheadOpen,
    typeaheadExactMatch,
    updateInput,
    onHistoryUp: () => {}, // delegated to useInputHistory caller
    onHistoryDown: () => {},
  };
}

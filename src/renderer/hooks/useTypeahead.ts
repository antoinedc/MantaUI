// ===== useTypeahead =====
//
// Extracted from ChatPanel.tsx (BET-64). Owns the @-mention / command
// typeahead popup: detection, lazy fetching of commands/agents, debounced
// file search, result filtering, and selection application.
//
// Self-contained: owns its own state (typeahead, commands, agents, fileResults)
// and refs (fileSearchSeqRef, fileSearchTimer). Dependencies are injected via
// params — it never reaches into the container's SSE / pin-to-bottom / drain
// state. The hook is callback-driven (the only effect is an unmount cleanup
// for the debounced file-search timer) so it's trivially testable with the
// render harness.
//
// The textarea's onChange routes through `updateInput` which both updates
// `input` state and detects active typeahead. Triggers:
//   /<word>      at byte 0 → command typeahead
//   @<token>     after whitespace (or BOF) → file / reference typeahead
//   @@<token>    after whitespace (or BOF) → agent typeahead (inserts @<name>)
// The popup tracks the [anchorStart, anchorEnd) slice and replaces it
// verbatim on selection.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpencodeCommand, OpencodeReference } from "../../shared/types";
import { backgroundApi } from "../backgroundRun";
import {
  detectTypeaheadTrigger,
  filterCommands,
  dedupeAgainstBuiltins,
  MANTA_BUILTIN_COMMANDS,
  MANTA_BUILTIN_NAMES,
} from "../chatUtils";
import { useAgentCatalog, refreshAgentCatalog } from "../agentCatalog";
import { usePackageAgents, refreshPackageAgents } from "../packageAgents";
import { PACKAGE_AGENT_PREFIX, agentPickerRows, resolvePickerProject, type PickerProject } from "../agentDispatch";
import type {
  TypeaheadState,
  TypeaheadRow,
  AgentMention,
} from "../chatShared";

// manta-local slash commands are defined once in chatUtils.ts (ChatPanel
// executes them, useTypeahead autocompletes them).

/** How long the project list is trusted before the picker reads it again. */
const PROJECTS_STALE_MS = 60_000;

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
  // Agents come from the shared box-level catalog (BET-949) — the same single
  // fetch that powers the plan-mode chip. No per-typeahead copy.
  const { agents } = useAgentCatalog();
  // Package agents (Agents Phase 1): valid ones are offered ahead of files on
  // `@`, and ahead of the opencode agents on `@@`.
  const { agents: packageAgentList } = usePackageAgents();
  // The registry projects, read when the picker opens, to tell "seated here" from "adds to <Project>" (agent screens §2.3).
  const [projects, setProjects] = useState<PickerProject[]>([]);
  const projectsAtRef = useRef(0);
  const loadProjects = useCallback(() => {
    if (Date.now() - projectsAtRef.current < PROJECTS_STALE_MS) return;
    projectsAtRef.current = Date.now();
    Promise.resolve(window.api.agentsProjects?.())
      .then((list) => setProjects(Array.isArray(list) ? list : []))
      // an older box has no such channel: the rows simply carry no pill
      .catch(() => setProjects([]));
  }, []);
  const pickerProject = useMemo(() => resolvePickerProject(cwd, projects), [cwd, projects]);
  const [fileResults, setFileResults] = useState<string[]>([]);
  // BET-1023: configured opencode references (@alias). Fetched on the SAME
  // debounced file-search tick (no second debounce/seq guard) and rendered
  // ahead of file results. Hidden references are omitted (opencode semantics).
  const [references, setReferences] = useState<OpencodeReference[]>([]);
  const fileSearchSeqRef = useRef(0);
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The list is the session's own (P1): a project can define commands the
  // global list lacks, and `background` is only decided against its directory.
  // `commandsCwdRef` is the directory the loaded list belongs to, so a session
  // that moves directory reloads instead of keeping a stale list.
  const commandsCwdRef = useRef<string | null>(null);
  const commandsInFlightRef = useRef<string | null>(null);
  const ensureCommands = useCallback(async () => {
    if (commands && commandsCwdRef.current === cwd) return;
    if (commandsInFlightRef.current === cwd) return;
    const forCwd = cwd;
    commandsInFlightRef.current = forCwd;
    try {
      const c = await backgroundApi().opencodeCommands(forCwd ? { directory: forCwd } : undefined);
      commandsCwdRef.current = forCwd;
      setCommands(c as OpencodeCommand[]);
    } catch { /* non-fatal */ } finally {
      if (commandsInFlightRef.current === forCwd) commandsInFlightRef.current = null;
    }
  }, [commands, cwd]);

  // The highlight needs the list as soon as the text is a slash command, not
  // only while the typeahead popup is open (a pasted `/review x`, or text
  // recalled from history, never opens it).
  const startsWithSlash = input.startsWith("/");
  useEffect(() => {
    if (startsWithSlash) void ensureCommands();
  }, [startsWithSlash, ensureCommands]);

  // File search: sequence-tracked so stale responses don't clobber the
  // latest. Empty query is passed through — opencode's /find/file returns a
  // browse-style listing of the directory's top-level entries. Configured
  // references are read on the same debounced tick (shared 80ms timer and
  // seq guard — deliberately no second debounce), so the alias list rides
  // the file search the user is already triggering.
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
          const [list, refs] = await Promise.all([
            window.api.opencodeFindFiles({ query, directory: cwd }),
            window.api.opencodeReferences(),
          ]);
          if (seq === fileSearchSeqRef.current) {
            setFileResults(list.slice(0, 20));
            setReferences(refs);
          }
        } catch {
          if (seq === fileSearchSeqRef.current) setFileResults([]);
        }
      }, 80);
    },
    [cwd],
  );

  const detectTypeahead = useCallback(
    (text: string, caret: number): TypeaheadState | null => {
      const t = detectTypeaheadTrigger(text, caret);
      return t && { ...t, selectedIdx: 0 };
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
        if (t.mode !== "command") {
          refreshPackageAgents();
          loadProjects();
        }
        if (t.mode === "command") void ensureCommands();
        else if (t.mode === "agent" && agents == null) refreshAgentCatalog();
        else if (t.mode === "file") void searchFiles(t.query);
      }
    },
    [detectTypeahead, ensureCommands, agents, searchFiles, loadProjects],
  );

  // Build the active typeahead's filtered result list.
  const typeaheadRows = useMemo<TypeaheadRow[]>(() => {
    if (!typeahead) return [];
    const q = typeahead.query.toLowerCase();
    if (typeahead.mode === "command") {
      const builtins = filterCommands([...MANTA_BUILTIN_COMMANDS], q).map((c) => ({
        kind: "command" as const,
        key: c.name,
        primary: `/${c.name}`,
        secondary: c.description,
      }));
      const ocRows = dedupeAgainstBuiltins(
        filterCommands(commands ?? [], q),
        MANTA_BUILTIN_NAMES,
      ).map((c) => ({
        kind: "command" as const,
        key: c.name,
        primary: `/${c.name}`,
        secondary: c.description,
      }));
      return [...builtins, ...ocRows].slice(0, 12);
    }
    const pkgRows: TypeaheadRow[] = agentPickerRows(packageAgentList, q, pickerProject).map(({ agent: a, pill }) => ({
      kind: "agent" as const,
      key: a.slug,
      primary: `@${a.slug}`,
      secondary: a.description || a.name,
      agent: { name: a.name, slug: a.slug, color: a.color, pill },
    }));
    if (typeahead.mode === "agent") {
      // The compiled `agent-<slug>` opencode blocks are the package agents
      // again — they are listed once, above, under their slug.
      const pkgSlugs = new Set(pkgRows.map((r) => r.key));
      const all = (agents ?? []).filter(
        (a) => !a.name.startsWith(PACKAGE_AGENT_PREFIX) && !pkgSlugs.has(a.name),
      );
      const filtered = q
        ? all.filter((a) => a.name.toLowerCase().includes(q))
        : all;
      return [
        ...pkgRows,
        ...filtered.map((a) => ({
          kind: "agent" as const,
          key: a.name,
          primary: `@${a.name}`,
          secondary: a.description,
        })),
      ].slice(0, 12);
    }
    // File mode — if the active model can't take attachments, show a single
    // red "not supported" row.
    if (!currentModelSupportsAttachments) {
      return [
        ...pkgRows,
        {
          kind: "file",
          key: "",
          primary: `⚠ ${currentModelName} doesn't support file attachments`,
          secondary: "Pick a model with attachment support to enable @-mentions",
        },
      ];
    }
    // Configured references (@alias for external dirs/repos) sort ahead of
    // workspace files. Hidden ones are excluded, matching opencode's own
    // autocomplete behavior for `hidden: true`.
    const refRows = references
      .filter((r) => !r.hidden && (q ? r.name.toLowerCase().includes(q) : true))
      .map((r) => ({
        kind: "reference" as const,
        key: r.name,
        primary: `@${r.name}`,
        secondary: r.description,
      }));
    return [
      ...pkgRows,
      ...refRows,
      ...fileResults.map((p) => ({
        kind: "file" as const,
        key: p,
        primary: `@${p}`,
        secondary: undefined,
      })),
    ].slice(0, 20);
  }, [
    typeahead,
    commands,
    agents,
    packageAgentList,
    pickerProject,
    fileResults,
    references,
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

      // Decided by the ROW, not the popup mode: a package agent is offered on a
      // plain `@` too, and it must record the mention the send path looks for.
      if (row.kind === "agent") {
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

  // Unmount cleanup — clear the debounced file-search timer so a pending
  // 80ms timer can't fire `opencodeFindFiles` + setState after teardown
  // (the timer was previously only cleared on keystroke, not on unmount).
  useEffect(() => () => {
    if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);
  }, []);

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

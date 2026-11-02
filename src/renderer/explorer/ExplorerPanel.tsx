// The Explorer shell (spec §Layout / §Explorer panel, contract E0–E4, E9):
//   - ExplorerSplit: the resizable transcript | Explorer split around one chat
//     panel. It is always present for a visited chat (a single transcript Panel
//     when the Explorer is closed), so opening / closing the Explorer never
//     remounts the ChatPanel it wraps.
//   - ExplorerPanel: top bar, tree toggle / handle, quick open, history, the
//     Expanded rail; the tree and the viewer are the other tracks' components.
// State lives in explorerStore.ts; this file is chrome + keyboard wiring.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { Folder, ListTree, Maximize2, Minimize2, Search, X } from "lucide-react";
import { IconButton } from "../IconButton";
import { StatusDot } from "../StatusDot";
import { useStore, resolveSessionOwner } from "../store";
import { IS_MAC } from "../platform";
import { ExplorerViewer } from "./ExplorerViewer";
import { ExplorerTree } from "./ExplorerTree";
import { ExplorerQuickOpen } from "./ExplorerQuickOpen";
import { useFileGeneration } from "./fileChanges";
import type { ExplorerOwner, OpenFileRequest } from "./types";
import {
  EXPLORER_DEFAULT_RATIO,
  EXPLORER_MIN_PX,
  TRANSCRIPT_MIN_PX,
  TREE_KEY_STEP_PX,
  TREE_MIN_PX,
  VIEWER_MIN_PX,
  basename,
  clampTreeWidth,
  railTone,
  shouldAutoExpand,
  TREE_TOO_NARROW_REASON,
  treeToggleDisabled,
} from "./layout";
import {
  isEffectivelyExpanded,
  navigateHistory,
  openFile,
  restoreExplorer,
  setExpanded,
  setMdView,
  setNarrow,
  setRatio,
  setRightPanel,
  setRoot,
  reportExplorerWidth,
  setTreeOpen,
  setTreeWidth,
  toggleExpanded,
  useExplorerSession,
  useMdView,
  useSidebarHidden,
} from "./explorerStore";

// Shortcut labels for titles (⌘ off macOS is Ctrl).
const KEYS = IS_MAC
  ? { tree: "⌥⌘E", expand: "⇧⌘E", quick: "⌘P", toggle: "⌘E" }
  : { tree: "Ctrl+Alt+E", expand: "Ctrl+Shift+E", quick: "Ctrl+P", toggle: "Ctrl+E" };

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

export function ExplorerSplit({
  sessionId,
  cwd,
  active,
  children,
}: {
  sessionId: string;
  cwd: string;
  /** Only the visible chat mounts an Explorer; the others keep their panel only. */
  active: boolean;
  children: ReactNode;
}) {
  const st = useExplorerSession(sessionId);
  const showExplorer = active && st.layout.open;
  const expanded = isEffectivelyExpanded(st);
  const groupRef = useGroupRef();
  const groupEl = useRef<HTMLDivElement | null>(null);

  const ratioRef = useRef(st.layout.ratio);
  ratioRef.current = st.layout.ratio;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const showRef = useRef(showExplorer);
  showRef.current = showExplorer;

  // The ratio the Explorer Panel opens with. Frozen while it is mounted: the
  // library re-lays-out when a Panel's constraint props change, so a live value
  // would fight the user's drag. Re-read each time the Explorer is (re)opened.
  const openRatio = useRef(st.layout.ratio);
  const wasShown = useRef(false);
  if (showExplorer && !wasShown.current) openRatio.current = st.layout.ratio;
  wasShown.current = showExplorer;

  // Narrow window → the Explorer shows Expanded; wide again → back to the split.
  // A zero width (hidden / pre-layout) says nothing, so it is ignored.
  useLayoutEffect(() => {
    const el = groupEl.current;
    if (!el || !active) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setNarrow(sessionId, shouldAutoExpand(w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessionId, active]);

  // Expanded is declarative: the transcript Panel's size is pinned to 0 (a pixel
  // minimum the window can't satisfy would otherwise leave the layout invalid).
  // Leaving Expanded re-applies the stored ratio exactly.
  const prevExpanded = useRef(expanded);
  useEffect(() => {
    const was = prevExpanded.current;
    prevExpanded.current = expanded;
    if (!showExplorer || expanded || !was) return;
    const t = setTimeout(() => {
      try {
        const r = ratioRef.current;
        groupRef.current?.setLayout({ transcript: 100 - r, explorer: r });
      } catch (e) {
        console.warn("explorer: couldn't restore the split ratio", e);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [showExplorer, expanded, groupRef]);

  const resetRatio = () => {
    setRatio(sessionId, EXPLORER_DEFAULT_RATIO);
    try {
      groupRef.current?.setLayout({ transcript: 100 - EXPLORER_DEFAULT_RATIO, explorer: EXPLORER_DEFAULT_RATIO });
    } catch (e) {
      console.warn("explorer: couldn't reset the split", e);
    }
  };

  return (
    <Group
      orientation="horizontal"
      className="manta-explorer-split min-w-0 flex-1"
      groupRef={groupRef}
      elementRef={groupEl}
      onLayoutChanged={(layout, meta) => {
        // Only a drag / key press is the user's ratio; constraint-driven
        // layouts (narrow window, Expanded) must not overwrite it.
        if (!meta.isUserInteraction || !showRef.current || expandedRef.current) return;
        if (typeof layout.explorer === "number" && layout.explorer > 0) setRatio(sessionId, layout.explorer);
      }}
    >
      <Panel
        id="transcript"
        minSize={showExplorer && expanded ? 0 : TRANSCRIPT_MIN_PX}
        maxSize={showExplorer && expanded ? 0 : "100%"}
        style={{ overflow: "hidden" }}
      >
        {children}
      </Panel>
      {showExplorer && !expanded && (
        <Separator
          className="manta-explorer-handle group relative z-10 -mx-1 flex w-2 shrink-0 cursor-col-resize justify-center outline-none"
          aria-label="Resize file explorer"
          onDoubleClick={resetRatio}
        >
          <span className="h-full w-px bg-border transition-colors group-hover:w-[2px] group-hover:bg-accent group-active:w-[2px] group-active:bg-accent group-focus-visible:w-[2px] group-focus-visible:bg-accent" />
        </Separator>
      )}
      {showExplorer && (
        <Panel
          id="explorer"
          defaultSize={`${openRatio.current}%`}
          minSize={EXPLORER_MIN_PX}
          style={{ overflow: "hidden" }}
        >
          <ExplorerPanel sessionId={sessionId} cwd={cwd} />
        </Panel>
      )}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ExplorerPanel({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const st = useExplorerSession(sessionId);
  const mdView = useMdView();
  const sidebarHidden = useSidebarHidden();
  const expanded = isEffectivelyExpanded(st);
  // Hidden sidebar on macOS: the rail is the window's top-left, under the traffic lights.
  const railClearsTrafficLights = sidebarHidden && IS_MAC;
  const owner = useMemo<ExplorerOwner>(() => ({ sessionId, cwd }), [sessionId, cwd]);
  const root = st.root ?? cwd;

  const sectionRef = useRef<HTMLElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);
  const colWidth = useElementWidth(colRef);
  const treeDisabled = treeToggleDisabled(colWidth);
  const treeVisible = st.layout.treeOpen && !treeDisabled;
  const treeWidth = clampTreeWidth(st.layout.treeWidth, colWidth);
  useEffect(() => {
    reportExplorerWidth(sessionId, colWidth);
    return () => reportExplorerWidth(sessionId, null);
  }, [sessionId, colWidth]);

  const [quickOpen, setQuickOpen] = useState(false);
  const quickOpenRef = useRef(false);
  quickOpenRef.current = quickOpen;

  // refreshKey = file generation (tool completions, resync) + window focus.
  const generation = useFileGeneration(sessionId);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const refreshKey = generation + focusTick;

  const tone = useStore((s) => {
    const o = resolveSessionOwner(s.projects, sessionId);
    const w = o ? s.status[o.tmuxSession]?.[o.windowIndex] : undefined;
    return railTone({ attentionKind: w?.attentionKind, running: w?.running === true || s.liveRunning[sessionId] === true });
  });

  const stRef = useRef(st);
  stRef.current = st;

  // Window-scoped keys that only apply to this Explorer. ⌘P / ⌘[ / ⌘] need focus
  // inside it; Esc leaves Expanded unless something else already consumed it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented || quickOpenRef.current) return;
        if (!isEffectivelyExpanded(stRef.current)) return;
        restoreExplorer(sessionId);
        e.preventDefault();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const inside = !!sectionRef.current?.contains(document.activeElement);
      if (!inside) return;
      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) {
        setQuickOpen(true);
        e.preventDefault();
      } else if ((key === "[" || key === "]") && !e.shiftKey) {
        if (navigateHistory(sessionId, key === "[" ? -1 : 1)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sessionId]);

  const onOpen = useCallback((req: OpenFileRequest) => openFile(req), []);

  // "Show tree" from the empty state: a too-narrow Explorer widens (Expanded) first.
  const showTree = useCallback(() => {
    if (treeToggleDisabled(colWidth) && !isEffectivelyExpanded(stRef.current)) setExpanded(sessionId, true);
    setTreeOpen(sessionId, true);
  }, [colWidth, sessionId]);

  const rootName = basename(root);
  const narrow = st.narrow;
  const expandLabel = expanded ? (narrow ? "Back to transcript" : "Restore split") : "Expand";
  const expandTitle = expanded
    ? narrow
      ? "Back to transcript (Esc)"
      : "Restore split (Esc)"
    : `Expand (${KEYS.expand})`;

  return (
    <section ref={sectionRef} className="manta-explorer flex h-full min-w-0 bg-bg-elev">
      {expanded && (
        <button
          type="button"
          onClick={() => restoreExplorer(sessionId)}
          className={`manta-explorer-rail flex w-11 shrink-0 flex-col items-center gap-3 border-r border-border bg-bg ${railClearsTrafficLights ? "pt-10" : "pt-3"} hover:bg-fill-hover`}
          aria-label="Back to transcript"
          title="Back to transcript (Esc)"
        >
          <Minimize2 size={16} aria-hidden="true" className="text-text-faint" />
          <StatusDot tone={tone} />
          <span className="rotate-180 text-meta text-text-faint [writing-mode:vertical-rl]">Transcript</span>
        </button>
      )}
      <div ref={colRef} className="flex min-w-0 flex-1 flex-col">
        <div
          className="manta-explorer-top titlebar-drag flex h-11 shrink-0 items-center gap-1 border-b border-border px-2"
          style={expanded ? { paddingLeft: "max(var(--sp-2), calc(var(--sidebar-hidden-inset, 0px) - 44px))" } : undefined}
        >
          <span className="titlebar-no-drag inline-flex">
            <IconButton
              icon={<ListTree className={st.layout.treeOpen ? "text-[var(--accent-tx)]" : undefined} />}
              label={st.layout.treeOpen ? "Hide file tree" : "Show file tree"}
              title={
                treeDisabled
                  ? TREE_TOO_NARROW_REASON
                  : `${st.layout.treeOpen ? "Hide file tree" : "Show file tree"} (${KEYS.tree})`
              }
              disabled={treeDisabled}
              onClick={() => setTreeOpen(sessionId, !st.layout.treeOpen)}
            />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-label font-semibold text-text" title={root}>
            <Folder size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
            <span className="truncate">{rootName}</span>
          </span>
          <span className="titlebar-no-drag flex items-center gap-1">
            <IconButton
              icon={<Search />}
              label="Quick open"
              title={`Quick open (${KEYS.quick})`}
              onClick={() => setQuickOpen(true)}
            />
            <IconButton
              icon={expanded ? <Minimize2 /> : <Maximize2 />}
              label={expandLabel}
              title={expandTitle}
              onClick={() => toggleExpanded(sessionId)}
            />
            <IconButton
              icon={<X />}
              label="Close file explorer"
              title={`Close (${KEYS.toggle})`}
              onClick={() => setRightPanel(sessionId, "none")}
            />
          </span>
          <div className="titlebar-inset-right" />
        </div>
        <div className="flex min-h-0 flex-1">
          {treeVisible && (
            <>
              <ExplorerTree
                owner={owner}
                root={root}
                onRootChange={(r) => setRoot(sessionId, r)}
                selected={st.focusDir ?? st.file?.abs ?? null}
                onOpen={onOpen}
                width={treeWidth}
                refreshKey={refreshKey}
              />
              <TreeHandle
                width={treeWidth}
                colWidth={colWidth}
                onChange={(w) => setTreeWidth(sessionId, w)}
              />
            </>
          )}
          <ExplorerViewer
            owner={owner}
            root={root}
            file={st.file}
            mdView={mdView}
            onMdViewChange={setMdView}
            onOpen={onOpen}
            onShowTree={showTree}
            refreshKey={refreshKey}
          />
        </div>
      </div>
      <ExplorerQuickOpen owner={owner} open={quickOpen} onClose={() => setQuickOpen(false)} onOpen={onOpen} />
    </section>
  );
}

// 8 px drag / keyboard handle between the tree and the viewer (contract E4).
// The tree's own border-r is the idle line; hover / drag / focus draws 2 px.
function TreeHandle({
  width,
  colWidth,
  onChange,
}: {
  width: number;
  colWidth: number;
  onChange: (w: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const apply = (w: number) => onChange(clampTreeWidth(w, colWidth));
  const max = colWidth > 0 ? Math.max(TREE_MIN_PX, colWidth - VIEWER_MIN_PX) : undefined;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file tree"
      aria-valuenow={width}
      aria-valuemin={TREE_MIN_PX}
      aria-valuemax={max}
      tabIndex={0}
      className="manta-explorer-tree-handle group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize outline-none"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startWidth: width };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) apply(d.startWidth + (e.clientX - d.startX));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          apply(width - TREE_KEY_STEP_PX);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          apply(width + TREE_KEY_STEP_PX);
        }
      }}
    >
      <span className="mx-auto block h-full w-0 bg-accent transition-[width] group-hover:w-[2px] group-active:w-[2px] group-focus-visible:w-[2px]" />
    </div>
  );
}

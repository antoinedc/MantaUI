// Pinned interfaces between the explorer tracks (shell / links / viewer+tree).
// Spec: docs/superpowers/specs/2026-11-02-file-explorer.md
// Design: docs/screens/explorer/contract.md

/** Who an open belongs to — captured where the link was RENDERED, never
 *  inferred from "the active session" after an async step. */
export type ExplorerOwner = { sessionId: string; cwd: string };

/** A file (or directory) inside home, already confirmed by fs:resolve-paths
 *  or listed by fs:list. `line`/`endLine` are 1-based and inclusive. */
export type FileTarget = { abs: string; line?: number; endLine?: number };

export type OpenFileRequest = FileTarget & {
  owner: ExplorerOwner;
  kind?: "file" | "dir";
  /** ⌘-click / Expanded request. */
  expand?: boolean;
};

/** Window event every path link dispatches; App (shell track) handles it.
 *  Same convention as `manta-open-review` / `manta-open-settings`. */
export const EXPLORER_OPEN_EVENT = "manta-explorer-open";

export function dispatchOpenFile(req: OpenFileRequest): void {
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(EXPLORER_OPEN_EVENT, { detail: req }));
}

/** Window event: a terminal absolute-path click → existing ArtifactPreview overlay. */
export const PREVIEW_PATH_EVENT = "manta-preview-path";

export type MdView = "rendered" | "source";

/** Props the shell's ExplorerPanel passes to the viewer track's ExplorerViewer. */
export type ExplorerViewerProps = {
  owner: ExplorerOwner;
  /** Root the breadcrumb is relative to (tree root). */
  root: string;
  /** null → the empty state (E12b) with "Show tree". */
  file: FileTarget | null;
  mdView: MdView;
  onMdViewChange: (v: MdView) => void;
  /** Navigate inside the Explorer (relative Markdown links, etc.). */
  onOpen: (req: OpenFileRequest) => void;
  onShowTree: () => void;
  /** Bumped by the shell on focus / tool-completion invalidation → refetch. */
  refreshKey: number;
};

/** Props the shell passes to the viewer track's ExplorerTree. */
export type ExplorerTreeProps = {
  owner: ExplorerOwner;
  root: string;
  onRootChange: (root: string) => void;
  selected: string | null;
  onOpen: (req: OpenFileRequest) => void;
  width: number;
  refreshKey: number;
};

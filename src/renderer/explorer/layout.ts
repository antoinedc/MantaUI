// Layout numbers that belong to the file explorer alone — constants in code, not
// tokens (docs/screens/explorer/contract.md §Constants; same precedent as the
// Artifacts panel's 340 px default width). Pure helpers only.

import { IS_MAC } from "../platform";

/** Explorer `defaultSize` (react-resizable-panels v4: a string is a percent). */
export const EXPLORER_DEFAULT_SIZE = "48%";
/** The same default as a plain percent, for stored ratios. */
export const EXPLORER_DEFAULT_RATIO = 48;
/** `minSize` numbers — v4 numbers are pixels. */
export const TRANSCRIPT_MIN_PX = 360;
export const EXPLORER_MIN_PX = 320;
/** Content narrower than both minimums → the Explorer shows Expanded. */
export const AUTO_EXPAND_BELOW_PX = 680;
export const TREE_DEFAULT_PX = 176;
export const TREE_MIN_PX = 140;
/** The tree toggle is disabled while the Explorer column is narrower than this. */
export const TREE_TOGGLE_MIN_EXPLORER_PX = 340;
/** The viewer never gets narrower than this. */
export const VIEWER_MIN_PX = 200;
export const TREE_KEY_STEP_PX = 16;
/** `w-64`: how far the hidden sidebar slides. */
export const SIDEBAR_WIDTH_PX = 256;
/** Width of the Expanded rail (`w-11`). */
export const RAIL_WIDTH_PX = 44;

/** Copy confirmation glyph/label hold. */
export const COPY_CONFIRM_MS = 1500;
/** A load shows its skeleton only after this long. */
export const LOADING_DELAY_MS = 150;
/** The "Updated" pill in the file bar. */
export const UPDATED_PILL_MS = 3000;

/** Value of `--sidebar-hidden-inset` while the sidebar is hidden. */
export function sidebarHiddenInsetPx(isMac: boolean): number {
  return isMac ? 112 : 40;
}
export const SIDEBAR_HIDDEN_INSET_PX = sidebarHiddenInsetPx(IS_MAC);

/** Pinned sidebar toggle position (right of the macOS traffic lights). */
export const SIDEBAR_TOGGLE_TOP_PX = 10;
export function sidebarToggleLeftPx(isMac: boolean): number {
  return isMac ? 76 : 8;
}

/** localStorage keys. */
export const SIDEBAR_HIDDEN_KEY = "manta:sidebarHidden";
export const MD_VIEW_KEY = "manta:explorer:mdView";
export const ARTIFACTS_OPEN_KEY = "manta:artifacts:open";
export const explorerLayoutKey = (sessionId: string) => `manta:explorer:${sessionId}`;
export const LAYOUT_PERSIST_DEBOUNCE_MS = 250;

/** Content width unknown (0: hidden / pre-layout) never counts as narrow. */
export function shouldAutoExpand(contentWidth: number): boolean {
  return contentWidth > 0 && contentWidth < AUTO_EXPAND_BELOW_PX;
}

export function treeToggleDisabled(explorerWidth: number): boolean {
  return explorerWidth > 0 && explorerWidth < TREE_TOGGLE_MIN_EXPLORER_PX;
}

/** Why the tree can't open: the disabled button's title and ⌥⌘E's toast. */
export const TREE_TOO_NARROW_REASON = "Widen the explorer to show the tree";

/** `clamp(stored, 140, explorerWidth − 200)`; the lower bound wins on a tiny Explorer. */
export function clampTreeWidth(stored: number, explorerWidth: number): number {
  const upper = explorerWidth > 0 ? explorerWidth - VIEWER_MIN_PX : Number.POSITIVE_INFINITY;
  return Math.max(TREE_MIN_PX, Math.min(stored, upper));
}

export type RailTone = "warn" | "running" | "idle";

/** Rail status dot: needs you (pending question / permission) > running > idle. */
export function railTone(input: { attentionKind?: string | null; running: boolean }): RailTone {
  const k = input.attentionKind;
  if (k === "question" || k === "permission" || k === "blocked") return "warn";
  return input.running ? "running" : "idle";
}

export function isInsideRoot(root: string, abs: string): boolean {
  const r = root.length > 1 ? root.replace(/\/+$/, "") : root;
  if (!r) return false;
  return abs === r || abs.startsWith(r === "/" ? "/" : `${r}/`);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return i === 0 ? "/" : "";
  return p.slice(0, i);
}

export function basename(p: string): string {
  const t = p.length > 1 ? p.replace(/\/+$/, "") : p;
  if (t === "/") return "/";
  return t.slice(t.lastIndexOf("/") + 1);
}

/**
 * ⌘B must reach the window handler even with xterm focused. Off macOS plain
 * Ctrl+B is tmux's prefix and must reach the PTY (see `terminalShortcut`), so
 * only ⌘B passes through.
 */
export function terminalPassesSidebarKey(
  ev: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  isMac: boolean,
): boolean {
  return isMac && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "b";
}

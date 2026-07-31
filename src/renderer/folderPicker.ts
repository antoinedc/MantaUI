// folderPicker.ts — pure helpers for the folder picker modal (BET-417 §B).
//
// All functions here are pure (no I/O) so they can be unit-tested without a
// box. The modal component in FolderPickerModal.tsx wires `window.api`
// (fsListDirs / gitListWorktrees) to these helpers.

import type { WorktreeInfo } from "../shared/types";

// Dimmed-but-selectable directories. `node_modules` and dot-folders render at
// --tx4 so nothing becomes unreachable, but they recede visually. Hidden
// files inside a listing are a different concern (fsListDirs already filters
// to directories only); this is about *known noisy* directories that ARE
// valid choices but visually pollute a browse.
export function isDimmedDir(name: string): boolean {
  if (name === "node_modules") return true;
  // Dot-folders (.git, .venv, .cache, …). A leading dot is the convention;
  // we do not enumerate a blocklist — the visual dim is the signal, not a
  // permission gate.
  return name.startsWith(".");
}

// Build clickable breadcrumbs from a path string. `~/code/foo` →
// ["~", "~/code", "~/code/foo"]. Absolute `/home/dev/code` →
// ["/", "/home", "/home/dev", "/home/dev/code"]. Tilde-form is preserved
// so the chip the user picks matches what they would type.
//
// Returns [] for empty/invalid input (the caller renders nothing).
export function breadcrumbs(path: string): string[] {
  const raw = (path ?? "").trim();
  if (!raw) return [];

  // Tilde-form: "~/code/foo" → ["~", "~/code", "~/code/foo"]
  if (raw === "~") return ["~"];
  if (raw.startsWith("~/")) {
    const parts = raw.slice(2).split("/").filter(Boolean);
    const out: string[] = ["~"];
    let acc = "~";
    for (const p of parts) {
      acc += "/" + p;
      out.push(acc);
    }
    return out;
  }

  // Absolute: "/home/dev/code" → ["/", "/home", "/home/dev", "/home/dev/code"]
  if (raw.startsWith("/")) {
    const parts = raw.split("/").filter(Boolean);
    const out: string[] = ["/"];
    let acc = "";
    for (const p of parts) {
      acc += "/" + p;
      out.push(acc);
    }
    return out;
  }

  // Relative or anything else: treat the whole string as one crumb. The
  // picker's path field drives the list via fsListDirs, which expects a
  // real prefix; relative paths rarely list usefully, so we don't split
  // them into synthetic ancestors.
  return [raw];
}

// The parent path for a "go up one level" click. "~/code/foo" → "~/code",
// "~/code" → "~", "~" → "~" (already at top). "/a/b" → "/a", "/a" → "/",
// "/" → "/". Empty → "".
export function parentPath(path: string): string {
  const raw = (path ?? "").trim();
  if (!raw) return "";
  if (raw === "~") return "~";
  if (raw === "/") return "/";
  if (raw.startsWith("~/")) {
    const idx = raw.lastIndexOf("/");
    if (idx <= 1) return "~"; // "~/x" → "~"
    return raw.slice(0, idx);
  }
  if (raw.startsWith("/")) {
    const idx = raw.lastIndexOf("/");
    if (idx === 0) return "/"; // "/a" → "/"
    return raw.slice(0, idx);
  }
  return raw;
}

// Label for a breadcrumb crumb — the last segment, or "/" for root, or "~"
// for home. Used so the clickable row shows "code" not "~/code".
export function crumbLabel(path: string): string {
  if (path === "~") return "~";
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx < 0) return path;
  return path.slice(idx + 1);
}

// Worktree badge text for a directory row: "⎇ N worktrees" when N > 0,
// empty string otherwise. The count comes from gitListWorktrees(cwd) which
// the modal calls while browsing. We only show a count > 0; a repo with a
// single worktree (the main checkout) is the common case and "1 worktree"
// is noise.
export function worktreeBadge(worktrees: WorktreeInfo[] | null): string {
  if (!worktrees || worktrees.length <= 1) return "";
  return `⎇ ${worktrees.length} worktrees`;
}

// Does this directory row carry a worktree fan-out offer? True when the
// folder has >1 worktree (the same threshold the old interstitial used).
// The modal asks the fan-out question HERE, before the user commits, instead
// of springing it as a surprise after Create.
export function hasWorktreeFanOut(worktrees: WorktreeInfo[] | null): boolean {
  return !!worktrees && worktrees.length > 1;
}

// The short git-state label for the folder picker footer: "⎇ main" when the
// folder is inside a repo (we infer the branch from the first worktree's
// branch — gitListWorktrees returns the main checkout first), or "" when not
// a repo / probe failed.
export function gitStateLabel(worktrees: WorktreeInfo[] | null): string {
  if (!worktrees || worktrees.length === 0) return "";
  const main = worktrees[0];
  if (!main?.branch) return "";
  return `⎇ ${main.branch}`;
}

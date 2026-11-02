// Wire types for the file explorer's fs:* channels
// (docs/superpowers/specs/2026-11-02-file-explorer.md §Server channels).
// Expected outcomes are returned as `{ ok:false, reason }`, never thrown.

export type FsReason =
  | "missing"
  | "outside-home"
  | "not-file"
  | "permission"
  | "changed"
  | "too-large"
  | "unavailable"
  | "invalid_input";

export type FsResolveInput = { base: string; paths: string[] };

export type FsResolved =
  | { input: string; ok: true; abs: string; kind: "file" | "dir"; size: number; mtimeMs: number }
  | { input: string; ok: false; reason: FsReason };

export type FsResolveResult = { results: FsResolved[] };

export type FsEntryKind = "file" | "dir" | "link-outside";

export type FsEntry = {
  name: string;
  abs: string;
  kind: FsEntryKind;
  size: number;
  mtimeMs: number;
  hidden: boolean;
  ignored: boolean;
};

export type FsListInput = { dir: string; limit?: number };

export type FsListResult =
  | { ok: true; dir: string; entries: FsEntry[]; total: number; truncated: boolean }
  | { ok: false; reason: FsReason };

export type FsGitBadge = "M" | "A" | "?" | "!";

export type FsGitStatusResult =
  | { ok: true; changes: Record<string, FsGitBadge> }
  | { ok: false; reason: "not-git" | "timeout" | FsReason };

/** Max paths per fs:resolve-paths call. */
export const FS_RESOLVE_MAX = 200;
/** Default (and maximum) entries returned by fs:list. */
export const FS_LIST_MAX = 2000;

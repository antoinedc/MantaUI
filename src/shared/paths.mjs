// paths.mjs — single source of truth for on-disk state directory names AND
// the `~` → `$HOME` expansion used by every caller that takes a user-supplied
// path.
//
// Directory names: every on-box state directory used to be a raw dot-prefixed
// string literal scattered across 20+ files (box server, relay, install
// scripts). That made a rename brittle — a blind find/replace WILL miss one.
// Route every usage through these constants instead of hardcoding the literal.
//
// Layout: everything nests under one top-level dir (~/.manta/) except the
// three call sites that historically had their own top-level dir; those keep
// separate names for now to minimize churn, but still route through here.

import { homedir } from "node:os";

export const STATE_DIRNAME = ".manta";
export const UPLOAD_DIRNAME = ".manta-uploads";
export const OUTBOX_DIRNAME = ".manta-outbox";
export const SECRETS_DIRNAME = ".manta-secrets";

// Leading `~` → os.homedir(); `~/foo` → `<homedir>/foo`. Other strings pass
// through unchanged. Single source of truth — three copies of this used to
// live in tmux.mjs, opencode.mjs and pluginManifest.mjs.
export function expandTilde(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return homedir() + p.slice(1);
  }
  return p;
}

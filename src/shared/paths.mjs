// paths.mjs — single source of truth for on-disk state directory names.
//
// Every on-box state directory used to be a raw dot-prefixed string literal
// scattered across 20+ files (box server, relay, install scripts). That made a
// rename brittle — a blind find/replace WILL miss one. Route every usage
// through these constants instead of hardcoding the literal.
//
// Layout: everything nests under one top-level dir (~/.manta/) except the
// three call sites that historically had their own top-level dir; those keep
// separate names for now to minimize churn, but still route through here.

export const STATE_DIRNAME = ".manta";
export const UPLOAD_DIRNAME = ".manta-uploads";
export const OUTBOX_DIRNAME = ".manta-outbox";
export const SECRETS_DIRNAME = ".manta-secrets";

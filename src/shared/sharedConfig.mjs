// sharedConfig.mjs — cross-device "shared settings" sync helpers.
//
// bui keeps TWO independent config stores: the desktop Electron app on the Mac
// (`<userData>/config.json`, src/main/config.ts) and the mobile/web server on
// the Linux box (`~/.bui-mobile/config.json`, src/server/local.mjs). They were
// fully disjoint — set your Groq STT key on desktop and you had to set it again
// on mobile.
//
// This module defines the DEVICE-INDEPENDENT subset of AppConfig that should be
// the same everywhere, plus the pure last-write-wins (LWW) merge used to
// reconcile the two stores. Device-specific fields (projects, ports, downloadsDir,
// allowAgentPush, skillRegistryUrls) are deliberately NOT shared — they mean
// different things on each machine (the box IS localhost; the Mac SSHes to it).
// skillRegistryUrls is excluded because desktop already writes those into the
// box's opencode.jsonc on its own path; double-handling here would fight that.
//
// Pure + framework-free so both the `.ts` (desktop) and `.mjs` (server) sides
// import it. Tested in src/shared/sharedConfig.test.ts.

// The exact fields that sync across devices. Keep in sync with the AppConfig
// type in src/shared/types.ts and the Settings UIs. Adding a field here makes
// it sync; removing it makes it device-local again.
export const SHARED_CONFIG_KEYS = [
  "groqApiKey",
  "voiceTranscriptionModel",
  "voiceCommandModel",
  "defaultModel",
  "chatAutoAllow",
  "autoRenameSessions",
  "cacheTtl",
];

// True if `patch` (a Partial<AppConfig> handed to configUpdate) changes at
// least one shareable field. Only such patches bump `configUpdatedAt` — a
// device-local edit (e.g. host) must NOT claim to be a newer shared snapshot,
// otherwise it would win LWW and clobber the other device's real shared edits.
export function patchTouchesSharedConfig(patch) {
  if (!patch || typeof patch !== "object") return false;
  return SHARED_CONFIG_KEYS.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
}

// Extract ONLY the shareable fields (plus the timestamp) from a full config.
// Used to build the payload pushed/pulled between devices so we never leak
// device-local fields (host, identityFile, projects, …) across machines.
export function extractSharedConfig(cfg) {
  const out = {};
  if (!cfg || typeof cfg !== "object") return out;
  for (const k of SHARED_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = cfg[k];
  }
  if (typeof cfg.configUpdatedAt === "number") {
    out.configUpdatedAt = cfg.configUpdatedAt;
  }
  return out;
}

// Last-write-wins merge of an incoming shared-config snapshot into the local
// config. Returns { config, changed }:
//   - config: the (possibly) new full config object
//   - changed: true if any shareable field actually differed and was applied
//
// `incoming` is a shared-config snapshot (shape from extractSharedConfig): the
// shareable fields plus its own `configUpdatedAt`. We apply it ONLY when its
// timestamp is strictly newer than ours — ties and older snapshots are no-ops,
// so two devices converge and a stale poll can't undo a fresh local edit.
//
// When applied, we overwrite EVERY shared key from `incoming` (deleting keys
// absent from the snapshot) so clearing a value on one device propagates as a
// clear, not a stale leftover. Device-local fields on `local` are untouched.
export function mergeSharedConfig(local, incoming) {
  const base = local && typeof local === "object" ? local : {};
  if (!incoming || typeof incoming !== "object") {
    return { config: base, changed: false };
  }
  const localTs = typeof base.configUpdatedAt === "number" ? base.configUpdatedAt : 0;
  const incomingTs =
    typeof incoming.configUpdatedAt === "number" ? incoming.configUpdatedAt : 0;
  // Strictly-newer wins. Equal timestamps are treated as already-converged.
  if (incomingTs <= localTs) {
    return { config: base, changed: false };
  }

  const next = { ...base };
  let changed = false;
  for (const k of SHARED_CONFIG_KEYS) {
    const hasIncoming = Object.prototype.hasOwnProperty.call(incoming, k);
    const incomingVal = hasIncoming ? incoming[k] : undefined;
    const hadLocal = Object.prototype.hasOwnProperty.call(next, k);
    const localVal = hadLocal ? next[k] : undefined;
    if (hasIncoming) {
      if (!hadLocal || !deepEqual(localVal, incomingVal)) {
        next[k] = incomingVal;
        changed = true;
      }
    } else if (hadLocal) {
      // Field cleared on the other device → clear here too.
      delete next[k];
      changed = true;
    }
  }
  // Always adopt the newer timestamp so subsequent compares are stable, even if
  // the field values happened to already match (changed stays false then, but
  // the clock still advances so we don't re-pull the same snapshot forever).
  next.configUpdatedAt = incomingTs;
  return { config: next, changed };
}

// Minimal structural equality for the small set of shareable values
// (strings, booleans, and the { providerID, modelID } object). Avoids pulling
// in a dep; not a general-purpose deepEqual.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// sessionNaming.mjs — session / project naming, decided on the box (WS11 D5 /
// audit S1, S2, S3). Clients preview with `sessions:propose-name` and send a
// `nameHint`; the box makes the name tmux-safe, unique, and the allocator below
// serializes creation so two clients can never take the same name.
//
// Pure except `createNameAllocator` (one process-wide mutex).

import { readdir } from "node:fs/promises";
import { Mutex } from "async-mutex";
import { expandTilde } from "../shared/paths.mjs";
import { deriveProjectName, slugifyProjectName, uniqueSessionName } from "../shared/projectName.mjs";

/** tmux silently rewrites `.` and `:` to `_` in a session name; do it first so uniqueness is judged on the name tmux keeps. */
export function tmuxSafeName(name) {
  return String(name ?? "").replace(/[.:]/g, "_");
}

/** The project (tmux session) name for a hint/folder: its basename, tmux-safe FIRST, then unique. */
export function proposeProjectName({ hint, cwd }, taken) {
  const base = typeof hint === "string" && hint.trim() ? deriveProjectName(hint.trim()) : deriveProjectName(cwd ?? "");
  return uniqueSessionName(tmuxSafeName(base), taken);
}

export const SCRATCH_EMPTY_HINT = "Add at least one letter or number — that becomes the folder name.";

/** A scratch name's folder slug and the one hint slot under the field: unusable, collides, or nothing. */
export function proposeScratchName(hint, takenFolders) {
  const slug = slugifyProjectName(hint);
  if (!slug) return { name: "", hint: SCRATCH_EMPTY_HINT };
  if (takenFolders.has(slug)) {
    const name = uniqueSessionName(slug, takenFolders);
    return { name, hint: `${slug} already exists — will create ${name}` };
  }
  return { name: slug, hint: null };
}

const NAME_MAX = 40;

/**
 * Rename validation: trimmed, 1–40 characters, no `:` or control characters. The sentence is class-1
 * (shown to a person as-is). Used by `tmux:rename-*` and the app-control tool.
 * @returns {{ok:true, name:string} | {ok:false, error:string}}
 */
export function validateSessionName(name) {
  if (typeof name !== "string") return { ok: false, error: "Session names can't be empty." };
  const trimmed = name.trim();
  if (trimmed.length < 1) return { ok: false, error: "Session names can't be empty." };
  if (trimmed.length > NAME_MAX) return { ok: false, error: `Session names can be at most ${NAME_MAX} characters.` };
  if (/[:]/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, error: "Session names can't contain “:” or control characters." };
  }
  return { ok: true, name: trimmed };
}

/**
 * Where new workspaces go: the common parent of the scanned repositories when they share one
 * (boundary-aware: `/home/u/code` is not the parent of `/home/u/codex`), else `<home>/projects`;
 * "" when nothing is known.
 */
export function proposedRoot(repoPaths, homeDir) {
  const fallback = homeDir ? `${homeDir}/projects` : "";
  const parents = (repoPaths ?? [])
    .map((p) => (typeof p === "string" && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""))
    .filter(Boolean);
  if (parents.length === 0) return fallback;
  let common = parents[0];
  for (const parent of parents.slice(1)) {
    while (common && parent !== common && !parent.startsWith(`${common}/`)) {
      const slash = common.lastIndexOf("/");
      common = slash >= 0 ? common.slice(0, slash) : "";
    }
  }
  return common && common !== "/" ? common : fallback;
}

/** One mutex per process: every session create runs inside `run`, so name choice + creation never interleave. */
export function createNameAllocator() {
  const mutex = new Mutex();
  return { run: (fn) => mutex.runExclusive(fn) };
}

/** The one allocator every create shares (a second instance would let two creates interleave). */
export const sharedNameAllocator = createNameAllocator();

/** The directory names directly under `root` (a missing/unreadable root is the empty set — the create makes it). */
export async function listChildDirNames(root, { readdirImpl = readdir } = {}) {
  try {
    const entries = await readdirImpl(expandTilde(String(root ?? "").trim()), { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

export const NO_FREE_NAME = "Couldn't pick a free name for this project — try again.";
export const nameTaken = (name) => `A project named “${name}” already exists.`;

/**
 * Create a session under the allocator. Hinted (no explicit name): choose tmux-safe-then-unique against the
 * live names and retry on an outside collision (up to 3 attempts, reusing the opencode session so no second one
 * is made). Explicit name: tmux-safe, never renamed — a collision is an error. When it ends in failure the
 * opencode session is deleted ONLY if this call created it; a caller-supplied one is never deleted.
 * @returns {Promise<{result: object, name: string}>}
 */
export async function createSessionUnderAllocator(
  { explicitName, hint, existingSessionId, create, listNames, deleteSession, allocator = sharedNameAllocator, log = console.warn },
) {
  const explicit = typeof explicitName === "string" && explicitName.trim() !== "";
  const attempts = explicit ? 1 : 3;
  return allocator.run(async () => {
    let sessionId = existingSessionId;
    let owned = null;
    const cleanup = async () => {
      if (!owned) return;
      try {
        await deleteSession(owned);
      } catch (e) {
        log(`[sessions] could not delete the unused session ${owned}: ${e?.message ?? e}`);
      }
    };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const name = explicit ? tmuxSafeName(explicitName.trim()) : proposeProjectName({ hint }, new Set(await listNames()));
      try {
        return { result: await create({ name, existingSessionId: sessionId }), name };
      } catch (err) {
        if (err?.name !== "DuplicateSessionNameError") {
          await cleanup();
          throw err;
        }
        if (err.createdHere) owned = err.sessionId;
        sessionId = err.sessionId ?? sessionId;
        if (attempt === attempts) {
          await cleanup();
          throw new Error(explicit ? nameTaken(name) : NO_FREE_NAME);
        }
      }
    }
    throw new Error(NO_FREE_NAME);
  });
}

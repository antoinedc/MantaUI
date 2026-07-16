// secrets.mjs — secure secret store for bui-server (the always-on Linux box).
//
// PROBLEM: the user wants to hand a secret (e.g. a GitHub PAT) to a working
// agent WITHOUT the value ever appearing in the AI transcript. A secret leaks
// the instant its VALUE enters the agent's context — i.e. if it appears in a
// tool's return text, a command string the agent types, or command stdout the
// agent reads back. So the rule baked into this module is:
//
//   The store NEVER returns a secret value to the agent. The `secret_provide`
//   tool MATERIALIZES the value into a 0600 file on the box and returns ONLY
//   the file PATH. The agent then uses it by reference, e.g.
//       git push https://x-access-token:$(cat <path>)@github.com/owner/repo
//   The value lives on disk; the transcript only ever holds the path + the
//   key name + a human-written usage hint (all non-secret).
//
// The HUMAN sets secrets via the bui UI (a key-value card) → the value travels
// renderer → IPC → SSH -L forward → here, never through opencode. There is NO
// `secret_set` tool, on purpose: if an agent could store a secret, the value
// would pass through the transcript.
//
// Two namespaces:
//   - "shared"  → visible to every chat-mode session on the box.
//   - "session" → scoped to one opencode sessionID; only that session's tools
//                 can list/provide it. A session-scoped key SHADOWS a shared
//                 key of the same name for that session.
//
// Server-owned + durable (survives Mac-app-close / reboot), same pattern as
// schedule.mjs / servePage.mjs. Store: ~/.manta/secrets.json (0600).
// Materialized files: ~/.manta-secrets/ (dir 0700, files 0600).

import { readFile, writeFile, rename, mkdir, chmod, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { STATE_DIRNAME, SECRETS_DIRNAME } from "../shared/paths.mjs";

const STORE_PATH = join(homedir(), STATE_DIRNAME, "secrets.json");
// Where `secret_provide` writes the materialized value files. Shared secrets go
// directly under here; session-scoped under sessions/<sessionID>/ so two
// sessions can hold same-named secrets without colliding on disk.
const SECRETS_DIR = join(homedir(), SECRETS_DIRNAME);

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

// A secret key must be a safe env-var-ish identifier so it's also a safe
// filename and a usable shell variable name: letter/underscore start, then
// letters/digits/underscore, 1-64 chars. Rejects path separators, dots, dashes.
export function isValidKey(key) {
  return typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key);
}

export function isValidScope(scope) {
  return scope === "shared" || scope === "session" || scope === "project";
}

// A project name = a bui workspace (tmux session) name, e.g. "Ronda". Used as a
// path segment for materialized project secrets, so keep it filesystem-safe.
export function isValidProject(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

// Strip the value from a stored entry for safe listing. NEVER let `value`
// escape to the agent — only metadata (key, scope, hint, hasValue, timestamps).
export function toMeta(entry) {
  return {
    id: entry.id,
    key: entry.key,
    scope: entry.scope,
    sessionID: entry.sessionID ?? null,
    project: entry.project ?? null,
    hint: entry.hint ?? "",
    hasValue: typeof entry.value === "string" && entry.value.length > 0,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  };
}

// The secrets VISIBLE to a given caller: session-scoped (this sessionID) +
// project-scoped (this project) + shared, with shadowing by key in that
// precedence (session > project > shared). Returns metadata only (no values).
// sessionID/project may each be falsy (the corresponding tier is just empty).
// With neither set → only shared (a bare "shared" view).
export function visibleSecrets(secrets, sessionID, project) {
  const list = Array.isArray(secrets) ? secrets : [];
  const sessionScoped = sessionID
    ? list.filter((s) => s.scope === "session" && s.sessionID === sessionID)
    : [];
  const sessionKeys = new Set(sessionScoped.map((s) => s.key));
  const projectScoped = project
    ? list.filter((s) => s.scope === "project" && s.project === project && !sessionKeys.has(s.key))
    : [];
  const shadowed = new Set([...sessionKeys, ...projectScoped.map((s) => s.key)]);
  const shared = list.filter((s) => s.scope === "shared" && !shadowed.has(s.key));
  return [...sessionScoped, ...projectScoped, ...shared].map(toMeta);
}

// Resolve which stored entry a `secret_provide(key)` call should materialize
// for a caller. Precedence: session-scoped (this sessionID) > project-scoped
// (this project) > shared. Returns the full entry (with value) or null.
export function resolveSecret(secrets, key, sessionID, project) {
  const list = Array.isArray(secrets) ? secrets : [];
  if (sessionID) {
    const own = list.find(
      (s) => s.scope === "session" && s.sessionID === sessionID && s.key === key,
    );
    if (own) return own;
  }
  if (project) {
    const proj = list.find(
      (s) => s.scope === "project" && s.project === project && s.key === key,
    );
    if (proj) return proj;
  }
  return list.find((s) => s.scope === "shared" && s.key === key) ?? null;
}

// Identity of an entry within the store: a secret is unique per
// (scope, owner, key) where owner is sessionID for session scope, project for
// project scope, and null for shared.
function sameSlot(a, scope, owner, key) {
  const aOwner = scope === "session" ? (a.sessionID ?? null) : scope === "project" ? (a.project ?? null) : null;
  return a.scope === scope && aOwner === (scope === "shared" ? null : owner) && a.key === key;
}

// Path the value file is materialized to for a resolved entry. Shared →
// ~/.manta-secrets/<key>; session → ~/.manta-secrets/sessions/<sessionID>/<key>;
// project → ~/.manta-secrets/projects/<project>/<key>.
export function materializedPath(entry, dir = SECRETS_DIR) {
  if (entry.scope === "session" && entry.sessionID) {
    return join(dir, "sessions", entry.sessionID, entry.key);
  }
  if (entry.scope === "project" && entry.project) {
    return join(dir, "projects", entry.project, entry.key);
  }
  return join(dir, entry.key);
}

// ---------------------------------------------------------------------------
// Store (atomic write + 0600, same shape as schedule.mjs / servePage.mjs)
// ---------------------------------------------------------------------------

async function atomicWrite(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { mode });
  // writeFile's mode is only applied on create; chmod is belt-and-suspenders
  // in case the tmp file pre-existed with looser perms.
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
}

export function loadSecrets(path = STORE_PATH) {
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      return Array.isArray(parsed?.secrets) ? parsed.secrets : [];
    }
  } catch {
    // corrupt/unreadable → start empty rather than crash the server. The file
    // is never auto-overwritten unless a mutation happens, so a transient read
    // error doesn't destroy data.
  }
  return [];
}

export async function saveSecrets(secrets, path = STORE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify({ secrets }, null, 2), 0o600);
}

function genId() {
  return randomBytes(4).toString("hex");
}

// ---------------------------------------------------------------------------
// CRUD — I/O injectable via {load, save, publish} for tests
// ---------------------------------------------------------------------------

// Upsert a secret. Identity = (scope, sessionID, key). Re-setting an existing
// key replaces its value/hint and bumps updatedAt. Returns { ok, meta } or
// { ok:false, error }. The returned meta NEVER includes the value.
export async function setSecret(
  { key, value, scope = "shared", sessionID = null, project = null, hint = "", now = () => Date.now() },
  { load = loadSecrets, save = saveSecrets, publish } = {},
) {
  if (!isValidKey(key)) {
    return {
      ok: false,
      error: `Invalid key "${key}". Use 1-64 chars: a letter or underscore, then letters/digits/underscores (env-var style).`,
    };
  }
  if (!isValidScope(scope)) {
    return { ok: false, error: `Invalid scope "${scope}". Use "shared", "session", or "project".` };
  }
  if (scope === "session" && !sessionID) {
    return { ok: false, error: "session-scoped secret requires a sessionID" };
  }
  if (scope === "project" && !isValidProject(project)) {
    return { ok: false, error: "project-scoped secret requires a valid project name" };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "value is required" };
  }

  const sid = scope === "session" ? sessionID : null;
  const proj = scope === "project" ? project : null;
  const owner = scope === "session" ? sid : scope === "project" ? proj : null;
  const secrets = load();
  const idx = secrets.findIndex((s) => sameSlot(s, scope, owner, key));
  const t = now();
  let entry;
  if (idx >= 0) {
    entry = {
      ...secrets[idx],
      value,
      hint: typeof hint === "string" ? hint : "",
      updatedAt: t,
    };
    secrets[idx] = entry;
  } else {
    entry = {
      id: genId(),
      key,
      value,
      scope,
      sessionID: sid,
      project: proj,
      hint: typeof hint === "string" ? hint : "",
      createdAt: t,
      updatedAt: t,
    };
    secrets.push(entry);
  }
  await save(secrets);
  publish?.({ kind: "secrets.updated", payload: { sessionID: sid, project: proj } });
  return { ok: true, meta: toMeta(entry) };
}

// Delete by store id (the UI passes the id from a listed meta). Also removes
// any materialized value file. Returns { ok, deleted }.
export async function deleteSecret(id, { load = loadSecrets, save = saveSecrets, publish } = {}) {
  const secrets = load();
  const idx = secrets.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: true, deleted: false };
  const [removed] = secrets.splice(idx, 1);
  await save(secrets);
  // Best-effort: remove the materialized file so a deleted secret can't be
  // re-read off disk by a later `cat`.
  try {
    await rm(materializedPath(removed), { force: true });
  } catch {
    /* best-effort */
  }
  publish?.({ kind: "secrets.updated", payload: { sessionID: removed?.sessionID ?? null } });
  return { ok: true, deleted: true };
}

// List metadata visible to a caller (values stripped). includeAll → every
// secret's metadata (a full-management view); otherwise shared + this session's
// + this project's secrets (what an agent in that session/project can use).
export function listSecrets({ sessionID, project, includeAll = false } = {}, { load = loadSecrets } = {}) {
  const secrets = load();
  if (includeAll) return secrets.map(toMeta);
  return visibleSecrets(secrets, sessionID, project);
}

// ---------------------------------------------------------------------------
// Materialize — write the resolved value to a 0600 file, return ONLY the path
// ---------------------------------------------------------------------------

// Resolve `key` for `sessionID`, write its value to a 0600 file under
// ~/.manta-secrets/, and return { ok, path, key, hint }. The VALUE IS NEVER
// RETURNED — only the path, so nothing secret reaches the transcript. The
// caller (secret_provide tool) instructs the agent to use $(cat <path>).
export async function provideSecret(
  { key, sessionID, project, dir = SECRETS_DIR },
  { load = loadSecrets } = {},
) {
  if (!isValidKey(key)) {
    return { ok: false, error: `Invalid key "${key}".` };
  }
  const secrets = load();
  const entry = resolveSecret(secrets, key, sessionID, project);
  if (!entry) {
    return { ok: false, error: `No secret named "${key}" is available to this session.` };
  }
  const path = materializedPath(entry, dir);
  await mkdir(dirname(path), { recursive: true });
  // Tighten the containing dir(s) to 0700 (best-effort).
  await chmod(dir, 0o700).catch(() => {});
  await writeFile(path, entry.value, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return { ok: true, path, key: entry.key, hint: entry.hint ?? "" };
}

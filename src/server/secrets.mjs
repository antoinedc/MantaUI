// secrets.mjs — secure secret store for manta-server (the always-on Linux box).
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
// The HUMAN sets secrets via the manta UI (a key-value card) → the value travels
// renderer → HTTPS → here, never through opencode. There is NO
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

import { writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { statePath, secretsRoot } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { toolUsageStore } from "./ctoStores.mjs";

const STORE_PATH = statePath("secrets.json");
// Where `secret_provide` writes the materialized value files. Shared secrets go
// directly under here; session-scoped under sessions/<sessionID>/ so two
// sessions can hold same-named secrets without colliding on disk.
const SECRETS_DIR = secretsRoot();

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

// A project name = a manta workspace (tmux session) name, e.g. "Ronda". Used as a
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
//
// The returned array order is the TIERING order (session, then project, then
// shared) — that is an implementation artifact of the shadowing filter chain,
// not a display contract. Display order is imposed by `listSecrets` (BET-1531:
// alphabetical by key) before the list reaches any consumer.
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

// Display order for every secrets listing: alphabetical by key, case-
// insensitive (keys are conventionally SHOUTY_SNAKE but not enforced to be).
// Ties are broken deterministically so the order never depends on store
// insertion order: exact key (so `Foo` and `foo` are stable), then scope in
// resolution precedence (session > project > shared — only reachable in the
// includeAll view, since the visible view shadows duplicate keys), then owner,
// then id. Pure; sorts a COPY.
const SCOPE_RANK = { session: 0, project: 1, shared: 2 };

export function sortSecretMetas(metas) {
  const owner = (m) => m.sessionID ?? m.project ?? "";
  return [...(Array.isArray(metas) ? metas : [])].sort(
    (a, b) =>
      a.key.localeCompare(b.key, "en", { sensitivity: "base", numeric: true }) ||
      a.key.localeCompare(b.key, "en") ||
      (SCOPE_RANK[a.scope] ?? 3) - (SCOPE_RANK[b.scope] ?? 3) ||
      owner(a).localeCompare(owner(b), "en") ||
      String(a.id ?? "").localeCompare(String(b.id ?? ""), "en"),
  );
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

export function loadSecrets(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed?.secrets) ? parsed.secrets : [];
}

export async function saveSecrets(secrets, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify({ secrets }, null, 2), { mode: 0o600 });
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
// BET-1531: the list is returned sorted alphabetically by key (see
// sortSecretMetas) — this is the single chokepoint feeding every consumer
// (GET /api/secrets for the agent tool, secrets:list RPC for the desktop
// SecretsCard + the iOS secrets sheet), so every listing shows A→Z and no
// client needs its own sort.
export function listSecrets({ sessionID, project, includeAll = false } = {}, { load = loadSecrets } = {}) {
  const secrets = load();
  if (includeAll) return sortSecretMetas(secrets.map(toMeta));
  return sortSecretMetas(visibleSecrets(secrets, sessionID, project));
}

// The KEY NAMES in the store, sorted — nothing else. This is the narrowest
// possible reader and exists for ONE caller: the Adaptive CTO's access grant
// (§7.4), where a key's presence is the authorization. The approved rule is
// deliberate and scope-blind: EVERY key currently in the store grants the CTO
// full use — shared, project-scoped and session-scoped alike, with no split
// and no imported/session/project distinction. Scope still governs the
// ORDINARY tools (secret_list / secret_provide are unchanged); only the CTO's
// own materialization path may resolve a scoped entry, through
// `provideSecretForCto` below — the one deliberately-authorized widening.
// Because this returns an array of strings, no value, hint, scope or any
// other field can travel down that path even by accident — the grant decision
// is structurally incapable of touching a secret. A key name is not a secret;
// a value never leaves this module except through a materialize call, which
// writes it to a 0600 file and returns only the path.
export function listSecretKeys({ load = loadSecrets } = {}) {
  const keys = [];
  for (const entry of load()) {
    const key = typeof entry?.key === "string" ? entry.key : "";
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Materialize — write the resolved value to a 0600 file, return ONLY the path
// ---------------------------------------------------------------------------

// Write a resolved entry's value to its 0600 materialized file and return the
// path. The one place a secret value ever touches the filesystem on a provide.
async function materializeEntry(entry, dir) {
  const path = materializedPath(entry, dir);
  await mkdir(dirname(path), { recursive: true });
  // Tighten the containing dir(s) to 0700 (best-effort).
  await chmod(dir, 0o700).catch(() => {});
  await writeFile(path, entry.value, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

// Resolve `key` for `sessionID`, write its value to a 0600 file under
// ~/.manta-secrets/, and return { ok, path, key, hint }. The VALUE IS NEVER
// RETURNED — only the path, so nothing secret reaches the transcript. The
// caller (secret_provide tool) instructs the agent to use $(cat <path>).
//
// BET-1395 (Adaptive CTO §7.1 channel 1): every successful provide appends
// `{channel:"secret", key, sessionID, project, ts}` to the CTO tool-usage
// store (`~/.manta/cto/tool-usage.json`) — exact credential usage, zero
// parsing, zero value exposure (the key NAME is not secret). Best-effort: a
// ledger failure never blocks or breaks a provide.
export async function provideSecret(
  { key, sessionID, project, dir = SECRETS_DIR },
  { load = loadSecrets, recordUsage = recordSecretUsage } = {},
) {
  if (!isValidKey(key)) {
    return { ok: false, error: `Invalid key "${key}".` };
  }
  const secrets = load();
  const entry = resolveSecret(secrets, key, sessionID, project);
  if (!entry) {
    return { ok: false, error: `No secret named "${key}" is available to this session.` };
  }
  const path = await materializeEntry(entry, dir);
  if (typeof recordUsage === "function") {
    await recordUsage({ key: entry.key, sessionID: sessionID ?? null, project: project ?? null }).catch(() => {});
  }
  return { ok: true, path, key: entry.key, hint: entry.hint ?? "" };
}

// Which stored entry THE CTO's own materialization resolves for a key name —
// the deterministic duplicate-name pick behind the approved all-store grant.
// The ordinary resolver (`resolveSecret`) is context-shaped: without a
// session/project it can only ever see the shared tier, so a scoped key would
// grant a tool whose probes could never materialize it. This is the narrow,
// deliberately-authorized widening for the CTO's own credential-use path (and
// nothing else — ordinary secret_list/secret_provide keep their scope
// behavior): among entries sharing the name it picks the DURABLE credential —
// shared > project > session, then the same owner/id tiebreak
// `sortSecretMetas` uses — the mirror image of per-session shadowing, where a
// session's own copy wins FOR THAT SESSION. For the session-LESS box reader
// a scratch copy some chat stored must never shadow the user's durable
// credential: a deterministic pick that ignores who typed last. Pure.
export function ctoSecretEntry(secrets, key) {
  const list = Array.isArray(secrets) ? secrets : [];
  if (!isValidKey(key)) return null;
  const rank = (s) => (s?.scope === "shared" ? 0 : s?.scope === "project" ? 1 : 2);
  const owner = (s) => s?.sessionID ?? s?.project ?? "";
  return (
    list
      .filter((s) => s && s.key === key && typeof s.value === "string" && s.value.length > 0)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          owner(a).localeCompare(owner(b), "en") ||
          String(a.id ?? "").localeCompare(String(b.id ?? ""), "en"),
      )[0] ?? null
  );
}

// The Adaptive CTO's privileged materialization: resolve through
// `ctoSecretEntry` (every scope, deterministic duplicate pick), write the
// value to a 0600 file, return ONLY the path — the value never crosses any
// grant/list API and never reaches a transcript. Ordinary per-session
// provides keep using `provideSecret`, whose scope visibility is unchanged.
export async function provideSecretForCto(
  { key, dir = SECRETS_DIR },
  { load = loadSecrets, recordUsage = null } = {},
) {
  if (!isValidKey(key)) {
    return { ok: false, error: `Invalid key "${key}".` };
  }
  const entry = ctoSecretEntry(load(), key);
  if (!entry) {
    return { ok: false, error: `No secret named "${key}" exists in the store.` };
  }
  const path = await materializeEntry(entry, dir);
  if (typeof recordUsage === "function") {
    await recordUsage({ key: entry.key, sessionID: null, project: null }).catch(() => {});
  }
  return { ok: true, path, key: entry.key, hint: entry.hint ?? "" };
}

// The §7.1 channel-1 writer: append one usage row to the A1 tool-usage store
// (ctoStores' toolUsageStore — the same store the daily tool scan fuses from).
// Injected as the default `recordUsage` dep so tests can swap it.
export async function recordSecretUsage({ key, sessionID, project, ts = Date.now() } = {}) {
  try {
    const payload = (await toolUsageStore.load()) ?? {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    rows.push({
      channel: "secret",
      // The FACT only: which key was provided. Naming the tool is the
      // registry's job — it resolves `secret:<KEY>` through the same matcher
      // the §7.4 grant uses, so a provide of GITHUB_PAT is engagement with
      // `github` rather than a parallel `github_pat` row the grant can never
      // reach. Deciding it here as well would be a second, drift-prone copy
      // of that rule.
      identity: null,
      source: "raw",
      detail: `secret:${key}`,
      ts,
      sessionID: sessionID ?? null,
      project: project ?? null,
    });
    await toolUsageStore.save({ ...payload, rows: rows.slice(-4000) });
  } catch {
    /* best-effort — usage bookkeeping never breaks a provide */
  }
}

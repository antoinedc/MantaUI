// Pure helpers for the secrets surfaces (chat popover + Settings → Secrets):
// grouping, search/filter, session-label resolution, override cross-reference,
// relative age, and the inline editor's dirty/valid state. No React, no I/O.
// Values never appear here — everything operates on SecretMeta.

import type { Project, SecretInput, SecretMeta, SecretPatch, SecretScope } from "../shared/types";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const KEY_ERROR = "Letters, digits and underscores only; must not start with a digit (max 64).";

export function isValidSecretKey(key: string): boolean {
  return KEY_RE.test(key);
}

// ---------- ages ----------

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "just now" / "5m ago" / "3h ago" / "41d ago" / "2mo ago" / "1y ago"; `long`
 *  spells units out ("41 days ago"). Empty string for a missing timestamp. */
export function relativeAge(ts: number | null | undefined, now: number, long = false): string {
  if (ts == null || !Number.isFinite(ts)) return "";
  const d = Math.max(0, now - ts);
  if (d < MIN) return "just now";
  const unit = (n: number, short: string, word: string) =>
    long ? `${n} ${word}${n === 1 ? "" : "s"} ago` : `${n}${short} ago`;
  if (d < HOUR) return unit(Math.floor(d / MIN), "m", "minute");
  if (d < DAY) return unit(Math.floor(d / HOUR), "h", "hour");
  if (d < 60 * DAY) return unit(Math.floor(d / DAY), "d", "day");
  if (d < 365 * DAY) return unit(Math.floor(d / (30 * DAY)), "mo", "month");
  return unit(Math.floor(d / (365 * DAY)), "y", "year");
}

/** Older than ~3 months: the Settings list tints these as stale. */
export function isStale(ts: number | null | undefined, now: number): boolean {
  return ts != null && now - ts >= 90 * DAY;
}

// ---------- search / filter ----------

export type ScopeFilter = "all" | SecretScope;

export function matchesQuery(s: SecretMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return s.key.toLowerCase().includes(q) || (s.hint ?? "").toLowerCase().includes(q);
}

/** Search first, then scope filter. */
export function filterSecrets(all: SecretMeta[], query: string, filter: ScopeFilter): SecretMeta[] {
  return all.filter((s) => matchesQuery(s, query) && (filter === "all" || s.scope === filter));
}

/** Counts for the filter chips, over the search-matched list. */
export function countByScope(all: SecretMeta[], query: string): Record<ScopeFilter, number> {
  const matched = all.filter((s) => matchesQuery(s, query));
  return {
    all: matched.length,
    shared: matched.filter((s) => s.scope === "shared").length,
    project: matched.filter((s) => s.scope === "project").length,
    session: matched.filter((s) => s.scope === "session").length,
  };
}

// ---------- session labels ----------

export type SessionLabel = {
  /** "workspace / window name" */
  label: string;
  tmuxSession: string;
  windowIndex: number;
};

/** Resolve an opencode session id to the chat window that owns it, or null
 *  when no open window carries it (the chat was closed). */
export function resolveSessionLabel(projects: Project[], sessionID: string): SessionLabel | null {
  for (const p of projects) {
    const w = p.windows.find((x) => x.opencodeSessionId === sessionID);
    if (w) return { label: `${p.tmuxSession} / ${w.name}`, tmuxSession: p.tmuxSession, windowIndex: w.index };
  }
  return null;
}

/** The workspace (tmux session) a chat session belongs to, or null if closed. */
export function sessionProject(projects: Project[], sessionID: string): string | null {
  return resolveSessionLabel(projects, sessionID)?.tmuxSession ?? null;
}

/** `ses_7f3a1b2c9d4e5f` → `ses_7f3a…5f`. Short ids pass through. */
export function shortSessionId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export type ChatWindowOption = { sessionID: string; label: string };

/** Every chat window (those with an opencode session), for the Add dialog's
 *  "One chat" picker. */
export function listChatWindows(projects: Project[]): ChatWindowOption[] {
  const out: ChatWindowOption[] = [];
  for (const p of projects) {
    for (const w of p.windows) {
      if (w.opencodeSessionId) out.push({ sessionID: w.opencodeSessionId, label: `${p.tmuxSession} / ${w.name}` });
    }
  }
  return out;
}

// ---------- grouping ----------

export type ProjectGroup = { project: string; items: SecretMeta[] };
export type SessionGroup = {
  sessionID: string;
  items: SecretMeta[];
  /** Resolved chat window, or null when the chat is closed. */
  window: SessionLabel | null;
  label: string;
};

export type SecretGroups = {
  shared: SecretMeta[];
  projects: ProjectGroup[];
  sessions: SessionGroup[];
};

/** Shared / Projects / Sessions for the Settings list. Projects alphabetical;
 *  sessions with an open chat first (by label), closed chats after (by id).
 *  Rows keep the order they arrive in (the server sorts by key). */
export function groupSecrets(all: SecretMeta[], projects: Project[]): SecretGroups {
  const shared = all.filter((s) => s.scope === "shared");

  const projMap = new Map<string, SecretMeta[]>();
  for (const s of all) {
    if (s.scope !== "project") continue;
    const name = s.project ?? "";
    projMap.set(name, [...(projMap.get(name) ?? []), s]);
  }
  const projectGroups = [...projMap.entries()]
    .map(([project, items]) => ({ project, items }))
    .sort((a, b) => a.project.localeCompare(b.project, "en", { sensitivity: "base" }));

  const sesMap = new Map<string, SecretMeta[]>();
  for (const s of all) {
    if (s.scope !== "session") continue;
    const id = s.sessionID ?? "";
    sesMap.set(id, [...(sesMap.get(id) ?? []), s]);
  }
  const sessions = [...sesMap.entries()]
    .map(([sessionID, items]): SessionGroup => {
      const window = resolveSessionLabel(projects, sessionID);
      return { sessionID, items, window, label: window?.label ?? shortSessionId(sessionID) };
    })
    .sort((a, b) => {
      if (!!a.window !== !!b.window) return a.window ? -1 : 1;
      return a.window
        ? a.label.localeCompare(b.label, "en", { sensitivity: "base" })
        : a.sessionID.localeCompare(b.sessionID, "en");
    });

  return { shared, projects: projectGroups, sessions };
}

// ---------- override cross-reference (Settings, from the full list) ----------

/** For every session/project row, the highest tier it shadows. A session row's
 *  project tier is only consulted when its chat's workspace is known (an
 *  orphaned session can only shadow shared). */
export function computeOverrides(
  all: SecretMeta[],
  projects: Project[],
): Map<string, "project" | "shared"> {
  const sharedKeys = new Set(all.filter((s) => s.scope === "shared").map((s) => s.key));
  const projectKeys = new Set(
    all.filter((s) => s.scope === "project").map((s) => `${s.project ?? ""}\u0000${s.key}`),
  );
  const out = new Map<string, "project" | "shared">();
  for (const s of all) {
    if (s.scope === "session") {
      const proj = s.sessionID ? sessionProject(projects, s.sessionID) : null;
      if (proj && projectKeys.has(`${proj}\u0000${s.key}`)) out.set(s.id, "project");
      else if (sharedKeys.has(s.key)) out.set(s.id, "shared");
    } else if (s.scope === "project" && sharedKeys.has(s.key)) {
      out.set(s.id, "shared");
    }
  }
  return out;
}

/** How many sessions carry a same-named secret that shadows this one. Shared:
 *  any session with that key. Project: sessions of that workspace. Session
 *  rows are never overridden. */
export function overriddenInCount(all: SecretMeta[], secret: SecretMeta, projects: Project[]): number {
  if (secret.scope === "session") return 0;
  let n = 0;
  for (const s of all) {
    if (s.scope !== "session" || s.key !== secret.key) continue;
    if (secret.scope === "shared") n++;
    else if (s.sessionID && sessionProject(projects, s.sessionID) === secret.project) n++;
  }
  return n;
}

// ---------- inline editor state ----------

export type EditorDraft = {
  key: string;
  hint: string;
  /** The "Replace value…" input is open. */
  replacing: boolean;
  value: string;
};

export type EditorState = {
  keyError: string | null;
  renamed: boolean;
  hintChanged: boolean;
  valueReplaced: boolean;
  dirty: boolean;
  valid: boolean;
  /** Save is allowed (dirty and valid). Callers also gate on `saving`. */
  canSave: boolean;
  /** Only the fields that changed; `value` only when replacing + non-empty. */
  patch: SecretPatch;
};

export function editorState(original: Pick<SecretMeta, "key" | "hint">, draft: EditorDraft): EditorState {
  const renamed = draft.key !== original.key;
  const keyError = renamed && !isValidSecretKey(draft.key) ? KEY_ERROR : null;
  const hintChanged = draft.hint.trim() !== (original.hint ?? "").trim();
  const valueReplaced = draft.replacing && draft.value.length > 0;
  const dirty = renamed || hintChanged || valueReplaced;
  const valid = keyError === null;
  const patch: SecretPatch = {};
  if (renamed) patch.key = draft.key;
  if (hintChanged) patch.hint = draft.hint.trim();
  if (valueReplaced) patch.value = draft.value;
  return { keyError, renamed, hintChanged, valueReplaced, dirty, valid, canSave: dirty && valid, patch };
}

// ---------- add dialog ----------

export type AddDraft = {
  scope: SecretScope;
  project: string;
  sessionID: string;
  key: string;
  value: string;
  hint: string;
};

export function canAddSecret(d: AddDraft): boolean {
  if (!isValidSecretKey(d.key) || d.value.length === 0) return false;
  if (d.scope === "project") return d.project.length > 0;
  if (d.scope === "session") return d.sessionID.length > 0;
  return true;
}

/** The `secretsSet` payload for the Add dialog (project scope passes the
 *  workspace explicitly; session scope passes the chosen chat). */
export function buildAddInput(d: AddDraft): SecretInput {
  return {
    key: d.key,
    value: d.value,
    scope: d.scope,
    sessionID: d.scope === "session" ? d.sessionID : null,
    project: d.scope === "project" ? d.project : null,
    hint: d.hint.trim() || undefined,
  };
}

/** The existing secret the Add dialog would silently overwrite (saving is an
 *  upsert on scope + owner + name), or null. */
export function findSlotConflict(all: SecretMeta[], d: AddDraft): SecretMeta | null {
  return (
    all.find(
      (s) =>
        s.scope === d.scope &&
        s.key === d.key &&
        (d.scope === "shared" || (d.scope === "project" ? s.project === d.project : s.sessionID === d.sessionID)),
    ) ?? null
  );
}

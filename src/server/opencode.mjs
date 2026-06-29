// opencode HTTP proxy — mobile server edition.
//
// Opencode runs on the SAME machine as this Node server, listening at
// http://127.0.0.1:4096. No SSH tunnel or port-forward is needed. Every
// function here is a direct port of src/main/opencode.ts's HTTP logic with
// the AppConfig / ensureForward / SSH layers stripped out.
//
// Export names are kept exactly as the rpc-wiring task expects them (see
// task comments on each function).

import { spawn as cpSpawn } from "node:child_process";
import { homedir } from "node:os";

const REMOTE_PORT = 4096;

/** Build the full URL for an opencode API path. */
export function apiUrl(path) {
  return `http://127.0.0.1:${REMOTE_PORT}${path}`;
}

/**
 * Parse a single SSE text line into a JS object.
 * Returns null for comment lines (": …") and non-data lines.
 * Mirrors the per-line parsing inside opencode.ts's subscribeEvents gen().
 */
export function parseSseFrame(line) {
  if (!line.startsWith("data:")) return null;
  try {
    return JSON.parse(line.slice(5).trimStart());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-session project-directory scope
// ---------------------------------------------------------------------------
//
// opencode's tool execution runs from the server's startup cwd, NOT from
// session.directory metadata. To make tools execute in the project worktree,
// every session-mutating POST must carry `?directory=<absolute-worktree-path>`.
// opencode's `/event` SSE stream is ALSO scoped by `?directory=`: events from
// a scoped POST land only on the matching scoped stream. The bus below
// (subscribeEvents) opens one subscription per directory we know about so
// every project's events flow back into the renderer.
//
// We cache session→directory locally so each prompt/command POST doesn't
// require an extra GET /session lookup.

const sessionDirectoryCache = new Map();
const directoryListeners = new Set(); // notified on new directory

function rememberSessionDirectory(sessionId, directory) {
  if (!sessionId || typeof directory !== "string" || directory.length === 0) return;
  const prev = sessionDirectoryCache.get(sessionId);
  sessionDirectoryCache.set(sessionId, directory);
  if (prev !== directory) {
    for (const fn of directoryListeners) {
      try { fn(directory); } catch { /* ignore listener error */ }
    }
  }
}

// Cache a session→directory WITHOUT opening a scoped stream. Used by the
// subscribe bootstrap: we want existing sessions' dirs resolvable (so the
// first prompt is fast) but we must NOT open a `/event?directory=` stream for
// every session in the catalog. On a box with many opencode workspaces (e.g.
// Multica), listSessions() returns ~100 dirs, and eagerly streaming each one
// piled up hundreds of connections that buried opencode serve and made every
// request crawl. Streams now open on demand via ensureStreamForDirectory when
// a session is actually used (prompt / message fetch).
function cacheSessionDirectoryQuiet(sessionId, directory) {
  if (!sessionId || typeof directory !== "string" || directory.length === 0) return;
  sessionDirectoryCache.set(sessionId, directory);
}

// Opens the scoped stream for a directory if a subscription is active. Set by
// subscribeEvents (to its openFor); called by getSessionDirectoryQuery so an
// in-use session's events arrive even though the bootstrap didn't pre-open it.
let ensureStreamForDirectory = null;

async function fetchSessionDirectory(sessionId) {
  try {
    const res = await fetch(apiUrl(`/session/${encodeURIComponent(sessionId)}`));
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.directory === "string" ? body.directory : null;
  } catch {
    return null;
  }
}

async function getSessionDirectoryQuery(sessionId) {
  let dir = sessionDirectoryCache.get(sessionId);
  if (!dir) {
    const fetched = await fetchSessionDirectory(sessionId);
    if (fetched) {
      rememberSessionDirectory(sessionId, fetched);
      dir = fetched;
    }
  }
  // This session is genuinely being used (prompt / message fetch routes here),
  // so ensure its scoped stream is open — covers BOTH the freshly-fetched dir
  // and a dir that the bootstrap cached quietly (cacheSessionDirectoryQuiet
  // doesn't open a stream). opencode emits this prompt's events only on the
  // scoped channel; without the stream they're lost and the session looks
  // frozen. Idempotent (openFor no-ops if already open).
  if (dir && ensureStreamForDirectory) {
    try { ensureStreamForDirectory(dir); } catch { /* non-fatal */ }
  }
  return dir ? `?directory=${encodeURIComponent(dir)}` : "";
}

/** Test-only: reset cache between scenarios. */
export function _resetSessionDirectoryCache() {
  sessionDirectoryCache.clear();
}

/**
 * Test-only: register a directory listener (same set the SSE manager uses).
 * Lets tests assert the lazy-fetch path actually notifies — the listener
 * firing is what opens the scoped stream, and the bug was a bare cache.set
 * that skipped it. Returns an unsubscribe fn.
 */
export function _onSessionDirectoryAdded(fn) {
  directoryListeners.add(fn);
  return () => directoryListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/** Create a new session in the given directory with an optional title.
 *  @param {{ directory: string, title?: string }} opts
 *  @returns {Promise<{ id: string, title: string, directory: string, projectID: string }>}
 */
// opencode requires an ABSOLUTE directory: given `~/projects/x` it resolves
// the tilde against its own server cwd ($HOME), persisting the corrupt
// `/home/dev/~/projects/x`. resolveProjectCwd-fed callers (/clear) pass tilde
// paths. The mobile server runs ON the opencode host, so a literal `~` /
// `~/...` expands against this process's own $HOME. Mirrors the desktop fix
// in src/main/opencode.ts:createSession.
function expandTilde(p) {
  if (typeof p !== "string" || !p.startsWith("~")) return p;
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + "/" + p.slice(2);
  return p; // ~user form — leave for the shell/opencode, not ours to guess
}

export async function createSession({ directory, title = "" }) {
  const absDir = expandTilde(directory);
  const url = `/session?directory=${encodeURIComponent(absDir)}`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`opencode createSession ${res.status}: ${await res.text()}`);
  }
  const sess = await res.json();
  // Fall back to the EXPANDED dir, never the raw tilde (the bug we fixed).
  rememberSessionDirectory(sess.id, sess.directory ?? absDir);
  return sess;
}

/** Fetch the full message transcript for a session.
 *  @param {string} sessionId
 */
export async function listMessages(sessionId) {
  // A web client fetching a session's transcript means that session is being
  // viewed — ensure its scoped stream so live updates arrive. Resolving the
  // dir (and opening the stream) is fire-and-forget so it doesn't delay the
  // transcript fetch. Mirrors the desktop ChatPanel opening its stream on
  // mount; without it, only sending a prompt would open the stream.
  void getSessionDirectoryQuery(sessionId).catch(() => {});
  const url = `/session/${encodeURIComponent(sessionId)}/message`;
  const res = await fetch(apiUrl(url));
  if (!res.ok) {
    throw new Error(`opencode listMessages ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Fetch a single message by id (GET /session/{id}/message/{messageID}).
 *  Returns null on miss/error so the caller can fall back to a full refetch.
 *  @param {string} sessionId
 *  @param {string} messageId
 */
export async function getMessage(sessionId, messageId) {
  try {
    const url = `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;
    const res = await fetch(apiUrl(url));
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** Reconcile a session's transcript.
 *
 *  The desktop main process keeps a per-session transcript cache and does a
 *  fast tail-merge here. The mobile/web server is a stateless relay with no
 *  such cache to merge against, so reconcile == a full pull. Mobile thus keeps
 *  its current behavior (no regression); the incremental win is desktop-only,
 *  where the cache exists. Kept as a distinct entry point so the renderer can
 *  call one API on both platforms.
 *  @param {string} sessionId
 */
export async function reconcileMessages(sessionId) {
  return listMessages(sessionId);
}

/**
 * Send a user message (prompt_async — returns 204 immediately; response
 * streams via SSE). Model is per-prompt; omit to use opencode's default.
 *
 * @param {{ sessionId: string, text: string, model?: { providerID: string, modelID: string, variant?: string }, attachments?: Array<{ remotePath: string, mime: string, filename?: string }>, mentions?: Array<{ name: string, source: { value: string, start: number, end: number } }> }} opts
 */
export async function sendPrompt({ sessionId, text, model, attachments, mentions }) {
  // Scope tools + events to the session's worktree. The matching per-directory
  // subscription in subscribeEvents below ensures the events still reach
  // listeners (the global /event subscription wouldn't see them otherwise).
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/prompt_async${dirQ}`;
  const parts = [];
  if (attachments) {
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime,
        url: `file://${a.remotePath}`,
        ...(a.filename ? { filename: a.filename } : {}),
      });
    }
  }
  if (mentions) {
    for (const m of mentions) {
      parts.push({ type: "agent", name: m.name, source: m.source });
    }
  }
  parts.push({ type: "text", text });

  const body = { parts };
  if (model) {
    body.model = { providerID: model.providerID, modelID: model.modelID };
    if (model.variant) body.variant = model.variant;
  }

  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode sendPrompt ${res.status}: ${await res.text()}`);
  }
}

/** Abort the running generation for a session (idempotent).
 *
 *  MUST carry `?directory=<session.directory>` like every other session-
 *  mutating POST (prompt_async, command, fork, compact). opencode v2 routes
 *  session mutations to the per-directory worker; an unscoped abort lands
 *  on the wrong worker so the per-directory worker keeps generating. The
 *  renderer's running indicator clears because opencode emits *some* idle
 *  signal in response, but the model loop never actually stops.
 *  @param {string} sessionId
 */
export async function abortSession(sessionId) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/abort${dirQ}`;
  const res = await fetch(apiUrl(url), { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode abortSession ${res.status}: ${await res.text()}`);
  }
}

/** List sessions scoped to a project directory.
 *  @param {string} [directory]
 */
export async function listSessions(directory) {
  const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const res = await fetch(apiUrl(`/session${qs}`));
  if (!res.ok) {
    throw new Error(`opencode listSessions ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Fork a session (copies history up to messageID into a new session).
 * @param {{ sessionId: string, messageID?: string }} opts
 */
export async function forkSession({ sessionId, messageID }) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/fork${dirQ}`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageID ? { messageID } : {}),
  });
  if (!res.ok) {
    throw new Error(`opencode forkSession ${res.status}: ${await res.text()}`);
  }
  const sess = await res.json();
  rememberSessionDirectory(sess.id, sess.directory);
  return sess;
}

/** Summarize a session in-place to free context (v2 compact endpoint).
 *  @param {string} sessionId
 */
export async function compactSession(sessionId) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/api/session/${encodeURIComponent(sessionId)}/compact${dirQ}`;
  const res = await fetch(apiUrl(url), { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode compactSession ${res.status}: ${await res.text()}`);
  }
}

/** Delete a session and its messages on the opencode server.
 *  Named deleteSessionRaw to distinguish from any local session cleanup.
 *  @param {string} sessionId
 */
export async function deleteSessionRaw(sessionId) {
  sessionDirectoryCache.delete(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}`;
  const res = await fetch(apiUrl(url), { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`opencode deleteSession ${res.status}: ${await res.text()}`);
  }
}

// Auto-rename: generate a 1-2 word title via a THROWAWAY session. Mirror of
// desktop generateSessionTitle in src/main/opencode.ts — see that comment for
// the full rationale (opencode has no one-shot completion endpoint, so we
// create→prompt→poll→delete a hidden session). Returns the RAW model reply;
// the renderer sanitizes it. Returns "" on timeout/failure so the caller
// skips the rename rather than erroring.
export async function generateSessionTitle({ directory, instruction }) {
  const absDir = expandTilde(directory);
  let model = null;
  try {
    model = await getDefaultModel();
  } catch {
    /* non-fatal */
  }

  let sid = null;
  try {
    const createRes = await fetch(
      apiUrl(`/session?directory=${encodeURIComponent(absDir)}`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "bui-auto-title" }),
      },
    );
    if (!createRes.ok) return "";
    sid = (await createRes.json()).id;

    const promptBody = { parts: [{ type: "text", text: instruction }] };
    if (model) {
      promptBody.model = { providerID: model.providerID, modelID: model.modelID };
    }
    const promptRes = await fetch(
      apiUrl(
        `/session/${encodeURIComponent(sid)}/prompt_async?directory=${encodeURIComponent(absDir)}`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(promptBody),
      },
    );
    if (!promptRes.ok) return "";

    const msgUrl = apiUrl(`/session/${encodeURIComponent(sid)}/message`);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await fetch(msgUrl);
      if (!r.ok) continue;
      const msgs = await r.json();
      const text = extractAssistantText(msgs);
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  } finally {
    if (sid) {
      try {
        await deleteSessionRaw(sid);
      } catch {
        /* ignore */
      }
    }
  }
}

function extractAssistantText(msgs) {
  const out = [];
  for (const m of msgs ?? []) {
    if (m?.info?.role !== "assistant") continue;
    for (const p of m.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    }
  }
  return out.join("").trim();
}

// ---------------------------------------------------------------------------
// Permission flow (Write/Edit/Bash approval)
// ---------------------------------------------------------------------------

/** List all pending tool-use permissions.
 *  Scoped to the session's directory when sessionId is provided. opencode's
 *  WorkspaceRoutingMiddleware makes the UNSCOPED endpoint return [] for
 *  sessions bound to a non-default directory — so without `?directory=` the
 *  PermissionCard never appears on mobile and the turn hangs forever (the
 *  live `per_…` is sitting in the server's pending map, we just can't see
 *  it). Mirrors listQuestions above + desktop listPermissions.
 *  @param {string} [sessionId]
 *  @returns {Promise<Array<{ id: string, sessionID: string, permission: string, ... }>>}
 */
export async function listPermissions(sessionId) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const res = await fetch(apiUrl(`/permission${dirQ}`));
  if (!res.ok) {
    throw new Error(`opencode listPermissions ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Approve or deny a permission request.
 *  Same workspace-routing rule as listPermissions: an UNSCOPED reply 404s
 *  (PermissionNotFoundError) or silently no-ops if routed to the wrong
 *  workspace, so the tool stays pending forever. Pass sessionId so the reply
 *  lands on the pending entry's scope. This was the root cause of mobile
 *  trust-mode auto-allow failing with `PermissionNotFoundError`.
 *  @param {{ requestId: string, reply: "once"|"always"|"reject", sessionId?: string }} opts
 */
export async function replyPermission({ requestId, reply, sessionId }) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const url = `/permission/${encodeURIComponent(requestId)}/reply${dirQ}`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyPermission ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Question flow (Question tool)
// ---------------------------------------------------------------------------

/** List pending questions from the Question tool.
 *  Scoped to the session's directory when sessionId is provided, so questions
 *  from the correct workspace are returned. Without scoping, opencode returns
 *  questions for the default workspace only — causing the QuestionCard to
 *  never appear for non-default sessions and the agent to hang forever.
 *  @param {string} [sessionId]
 *  @returns {Promise<Array<{ id: string, sessionID: string, questions: Array<...>, ... }>>}
 */
export async function listQuestions(sessionId) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const res = await fetch(apiUrl(`/question${dirQ}`));
  if (!res.ok) {
    throw new Error(`opencode listQuestions ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Reply to a question (one answers array per QuestionInfo entry).
 *
 * opencode's /question endpoints are `?directory=`-scoped like prompt_async;
 * an UNSCOPED reply 200s but never resumes the blocked tool (agent hangs in
 * "processing"). Scope to the question's session directory. Mirrors the
 * desktop fix in src/main/opencode.ts:replyQuestion.
 * @param {{ requestId: string, answers: string[][], sessionId?: string }} opts
 */
export async function replyQuestion({ requestId, answers, sessionId }) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const url = `/question/${encodeURIComponent(requestId)}/reply${dirQ}`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyQuestion ${res.status}: ${await res.text()}`);
  }
}

/** Reject (dismiss) a question without answering.
 *  @param {{ requestId: string, sessionId?: string }} opts
 */
export async function rejectQuestion({ requestId, sessionId }) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const url = `/question/${encodeURIComponent(requestId)}/reject${dirQ}`;
  const res = await fetch(apiUrl(url), { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode rejectQuestion ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Models / providers
// ---------------------------------------------------------------------------

/**
 * Get the default model from the first connected provider.
 * @returns {Promise<{ providerID: string, modelID: string }|null>}
 */
export async function getDefaultModel() {
  const res = await fetch(apiUrl("/provider"));
  if (!res.ok) return null;
  const data = await res.json();
  const connected = data.connected ?? [];
  const defaults = data.default ?? {};
  for (const id of connected) {
    const modelID = defaults[id];
    if (modelID) return { providerID: id, modelID };
  }
  return null;
}

/**
 * List all models from CONNECTED providers only.
 * Strips raw API keys by reconstructing the model shape (normalizeProviderModel).
 * @returns {Promise<Array<{ id: string, providerID: string, name: string, ... }>>}
 */
export async function listModels() {
  const out = [];
  try {
    const res = await fetch(apiUrl("/provider"));
    if (res.ok) {
      const data = await res.json();
      const connected = new Set(data.connected ?? []);
      for (const p of data.all ?? []) {
        if (!p.id || !connected.has(p.id)) continue;
        for (const modelId of Object.keys(p.models ?? {})) {
          out.push(_normalizeProviderModel(p.id, modelId, (p.models ?? {})[modelId]));
        }
      }
    }
  } catch {
    /* non-fatal */
  }
  return out;
}

function _normalizeProviderModel(providerID, modelId, m) {
  let variants;
  const vRaw = m.variants;
  if (Array.isArray(vRaw)) {
    variants = vRaw
      .map((v) => (v && typeof v === "object" ? String(v.id ?? "") : ""))
      .filter(Boolean)
      .map((id) => ({ id }));
  } else if (vRaw && typeof vRaw === "object") {
    variants = Object.keys(vRaw).map((id) => ({ id }));
  }
  return {
    id: String(m.id ?? modelId),
    providerID,
    family: typeof m.family === "string" ? m.family : undefined,
    name: typeof m.name === "string" ? m.name : String(m.id ?? modelId),
    status: typeof m.status === "string" ? m.status : undefined,
    enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
    limit: m.limit,
    capabilities: m.capabilities,
    variants: variants && variants.length > 0 ? variants : undefined,
  };
}

// ---------------------------------------------------------------------------
// VCS
// ---------------------------------------------------------------------------

/**
 * Get the current VCS branch for a working directory.
 *
 * Mirrors src/main/opencode.ts: we DO NOT call opencode's `GET /vcs`
 * because that endpoint caches branch state per-worker and never reflects
 * a `git checkout` performed in the user's terminal. Instead we shell out
 * to `git -C <dir> branch --show-current` directly. Returns null for empty
 * dir, non-git, detached HEAD, or any failure.
 *
 * @param {string} [directory]
 * @returns {Promise<string|null>}
 */
export async function getVcsBranch(directory) {
  if (!directory) return null;
  return new Promise((resolve) => {
    const proc = cpSpawn(
      "git",
      ["-C", directory, "branch", "--show-current"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.on("error", () => resolve(null));
    proc.on("exit", () => {
      const name = stdout.trim();
      resolve(name ? name : null);
    });
  });
}

// ---------------------------------------------------------------------------
// Commands, agents, file search
// ---------------------------------------------------------------------------

/** List built-in and user-defined slash commands.
 *  @returns {Promise<Array<{ name: string, description?: string, source?: string, ... }>>}
 */
export async function listCommands() {
  const res = await fetch(apiUrl("/command"));
  if (!res.ok) {
    throw new Error(`opencode listCommands ${res.status}: ${await res.text()}`);
  }
  const raw = await res.json();
  return raw.map((c) => ({
    name: String(c.name ?? ""),
    description: typeof c.description === "string" ? c.description : undefined,
    source: typeof c.source === "string" ? c.source : undefined,
    argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : undefined,
    agent: typeof c.agent === "string" ? c.agent : undefined,
    model: typeof c.model === "string" ? c.model : undefined,
    template: typeof c.template === "string" ? c.template : undefined,
  }));
}

/** List primary and sub-agents.
 *  @returns {Promise<Array<{ name: string, description?: string, mode?: string, ... }>>}
 */
export async function listAgents() {
  const res = await fetch(apiUrl("/agent"));
  if (!res.ok) {
    throw new Error(`opencode listAgents ${res.status}: ${await res.text()}`);
  }
  const raw = await res.json();
  return raw.map((a) => ({
    name: String(a.name ?? ""),
    description: typeof a.description === "string" ? a.description : undefined,
    mode: typeof a.mode === "string" ? a.mode : undefined,
    native: typeof a.native === "boolean" ? a.native : undefined,
    builtIn: typeof a.builtIn === "boolean" ? a.builtIn : undefined,
  }));
}

/** ripgrep-backed file search under a directory.
 *  @param {{ query: string, directory: string }} opts
 *  @returns {Promise<string[]>}
 */
export async function findFiles({ query, directory }) {
  const qs =
    `?query=${encodeURIComponent(query)}&directory=${encodeURIComponent(directory)}`;
  const res = await fetch(apiUrl(`/find/file${qs}`));
  if (!res.ok) {
    throw new Error(`opencode findFiles ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Invoke a slash command inside a session.
 * model is serialised as "providerID/modelID" string (unlike prompt_async's object).
 *
 * @param {{ sessionId: string, command: string, arguments: string, attachments?: Array<{ remotePath: string, mime: string, filename?: string }>, model?: { providerID: string, modelID: string, variant?: string } }} opts
 */
export async function runCommand({ sessionId, command, arguments: argumentsStr, attachments, model }) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/command${dirQ}`;
  const parts = [];
  if (attachments) {
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime,
        url: `file://${a.remotePath}`,
        ...(a.filename ? { filename: a.filename } : {}),
      });
    }
  }
  const body = { command, arguments: argumentsStr, parts };
  if (model) {
    body.model = `${model.providerID}/${model.modelID}`;
    if (model.variant) body.variant = model.variant;
  }
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode runCommand ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// SSE event subscription
// ---------------------------------------------------------------------------

// One long-lived SSE connection to opencode's /event endpoint, optionally
// scoped to a project `?directory=`. Auto-reconnects on drop with 1.5 s
// delay; returns stop() that flips stopped=true AND aborts the in-flight
// fetch so reader.read() unblocks immediately.
function openEventStream(onEvent, directory) {
  let stopped = false;
  let currentController = null;
  const path = directory
    ? `/event?directory=${encodeURIComponent(directory)}`
    : "/event";

  (async function loop() {
    while (!stopped) {
      const controller = new AbortController();
      currentController = controller;
      try {
        const res = await fetch(apiUrl(path), {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          throw new Error(`opencode SSE ${res.status}: ${res.statusText}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            // Events are separated by double-newline (SSE spec)
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let data = "";
              for (const line of chunk.split("\n")) {
                if (line.startsWith("data:")) {
                  data += (data ? "\n" : "") + line.slice(5).trimStart();
                }
                // ignore event: / id: / retry: lines — type is inside the JSON
              }
              if (!data) continue;
              try {
                onEvent(JSON.parse(data));
              } catch {
                // skip malformed event
              }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* already released */ }
          controller.abort(); // always abort to release the connection
        }
      } catch {
        /* reconnect on error or AbortError from stop() */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  })();

  return () => { stopped = true; currentController?.abort(); };
}

/**
 * Subscribe to opencode events across ALL project directories.
 *
 * opencode's `/event` is project-scoped: a POST with `?directory=X` emits
 * its events on the stream subscribed to `?directory=X` only. To catch
 * everything we open the global stream PLUS one stream per directory we've
 * seen (via createSession / forkSession / listSessions). Newly-discovered
 * directories auto-spawn a stream via the directoryListeners hook.
 *
 * Bootstrap: we call listSessions() once on subscribe so existing sessions
 * (from a previous server restart) have their directories cached and a
 * stream opened.
 *
 * @param {(event: object) => void} onEvent
 * @returns {() => void} stop
 */
export function subscribeEvents(onEvent) {
  const streams = new Map(); // key: "" (global) or directory string
  let stopped = false;

  const openFor = (key, dir) => {
    if (streams.has(key)) return;
    streams.set(key, openEventStream(onEvent, dir));
  };

  // Global stream catches non-scoped events (server.heartbeat, vcs.branch.updated,
  // and any future event that opencode emits without a directory).
  openFor("", undefined);

  // Auto-open scoped streams for newly-discovered directories (createSession /
  // forkSession route through rememberSessionDirectory, which fires this).
  const listener = (dir) => {
    if (stopped || !dir) return;
    openFor(dir, dir);
  };
  directoryListeners.add(listener);

  // Expose the on-demand opener so getSessionDirectoryQuery can open a stream
  // the moment a session is actually used, rather than us pre-opening one for
  // every session in the catalog.
  ensureStreamForDirectory = (dir) => {
    if (stopped || !dir) return;
    openFor(dir, dir);
  };

  // Prime the dir cache from existing sessions so a prompt to a pre-existing
  // session resolves its directory fast — but do NOT open a stream per
  // session here. Streams open lazily when a session is used (see
  // getSessionDirectoryQuery → ensureStreamForDirectory). This is the fix for
  // the connection flood: on a many-workspace box, eagerly streaming every
  // session in listSessions() opened hundreds of connections to opencode.
  (async () => {
    try {
      const sessions = await listSessions();
      for (const s of sessions || []) {
        if (s?.id && typeof s?.directory === "string") {
          cacheSessionDirectoryQuiet(s.id, s.directory);
        }
      }
    } catch { /* non-fatal: bootstrap is best-effort */ }
  })();

  return () => {
    stopped = true;
    directoryListeners.delete(listener);
    ensureStreamForDirectory = null;
    for (const stop of streams.values()) {
      try { stop(); } catch { /* ignore */ }
    }
    streams.clear();
  };
}

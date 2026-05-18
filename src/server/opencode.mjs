// opencode HTTP proxy — mobile server edition.
//
// Opencode runs on the SAME machine as this Node server, listening at
// http://127.0.0.1:4096. No SSH tunnel or port-forward is needed. Every
// function here is a direct port of src/main/opencode.ts's HTTP logic with
// the AppConfig / ensureForward / SSH layers stripped out.
//
// Export names are kept exactly as the rpc-wiring task expects them (see
// task comments on each function).

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
// Session CRUD
// ---------------------------------------------------------------------------

/** Create a new session in the given directory with an optional title.
 *  @param {{ directory: string, title?: string }} opts
 *  @returns {Promise<{ id: string, title: string, directory: string, projectID: string }>}
 */
export async function createSession({ directory, title = "" }) {
  const url = `/session?directory=${encodeURIComponent(directory)}`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`opencode createSession ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Fetch the full message transcript for a session.
 *  @param {string} sessionId
 */
export async function listMessages(sessionId) {
  const url = `/session/${encodeURIComponent(sessionId)}/message`;
  const res = await fetch(apiUrl(url));
  if (!res.ok) {
    throw new Error(`opencode listMessages ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Send a user message (prompt_async — returns 204 immediately; response
 * streams via SSE). Model is per-prompt; omit to use opencode's default.
 *
 * @param {{ sessionId: string, text: string, model?: { providerID: string, modelID: string, variant?: string }, attachments?: Array<{ remotePath: string, mime: string, filename?: string }>, mentions?: Array<{ name: string, source: { value: string, start: number, end: number } }> }} opts
 */
export async function sendPrompt({ sessionId, text, model, attachments, mentions }) {
  const url = `/session/${encodeURIComponent(sessionId)}/prompt_async`;
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
 *  @param {string} sessionId
 */
export async function abortSession(sessionId) {
  const url = `/session/${encodeURIComponent(sessionId)}/abort`;
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
  const url = `/session/${encodeURIComponent(sessionId)}/fork`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageID ? { messageID } : {}),
  });
  if (!res.ok) {
    throw new Error(`opencode forkSession ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Summarize a session in-place to free context (v2 compact endpoint).
 *  @param {string} sessionId
 */
export async function compactSession(sessionId) {
  const url = `/api/session/${encodeURIComponent(sessionId)}/compact`;
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
  const url = `/session/${encodeURIComponent(sessionId)}`;
  const res = await fetch(apiUrl(url), { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`opencode deleteSession ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Permission flow (Write/Edit/Bash approval)
// ---------------------------------------------------------------------------

/** List all pending tool-use permissions.
 *  @returns {Promise<Array<{ id: string, sessionID: string, permission: string, ... }>>}
 */
export async function listPermissions() {
  const res = await fetch(apiUrl("/permission"));
  if (!res.ok) {
    throw new Error(`opencode listPermissions ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Approve or deny a permission request.
 *  @param {{ requestId: string, reply: "once"|"always"|"reject" }} opts
 */
export async function replyPermission({ requestId, reply }) {
  const url = `/permission/${encodeURIComponent(requestId)}/reply`;
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
 *  @returns {Promise<Array<{ id: string, sessionID: string, questions: Array<...>, ... }>>}
 */
export async function listQuestions() {
  const res = await fetch(apiUrl("/question"));
  if (!res.ok) {
    throw new Error(`opencode listQuestions ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Reply to a question (one answers array per QuestionInfo entry).
 * @param {{ requestId: string, answers: string[][] }} opts
 */
export async function replyQuestion({ requestId, answers }) {
  const url = `/question/${encodeURIComponent(requestId)}/reply`;
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
 *  @param {string} requestId
 */
export async function rejectQuestion(requestId) {
  const url = `/question/${encodeURIComponent(requestId)}/reject`;
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
 * Returns null for non-git dirs or on error.
 * @param {string} [directory]
 * @returns {Promise<string|null>}
 */
export async function getVcsBranch(directory) {
  const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const res = await fetch(apiUrl(`/vcs${qs}`));
  if (!res.ok) return null;
  try {
    const data = await res.json();
    return data.branch ?? null;
  } catch {
    return null;
  }
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
  const url = `/session/${encodeURIComponent(sessionId)}/command`;
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

/**
 * Opens a long-lived SSE connection to opencode's /event endpoint.
 * Calls onEvent(parsedObject) for each parsed event frame.
 * Auto-reconnects on drop with a 1.5 s delay.
 *
 * Returns stop() which:
 *   - sets stopped = true so the loop exits after the current iteration, AND
 *   - immediately aborts the in-flight fetch via AbortController so
 *     reader.read() unblocks right away (no connection leak on teardown).
 *
 * @param {(event: object) => void} onEvent
 * @returns {() => void} stop
 */
export function subscribeEvents(onEvent) {
  let stopped = false;
  let currentController = null;

  (async function loop() {
    while (!stopped) {
      const controller = new AbortController();
      currentController = controller;
      try {
        const res = await fetch(apiUrl("/event"), {
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

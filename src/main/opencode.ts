// opencode integration — Phase 1 (read-only transcript).
//
// Architecture:
//
//   remote host:
//     ┌──────────────────────────────────────────────┐
//     │ tmux session `bui-opencode` (detached)       │
//     │   └─ opencode serve --port 4096 --hostname   │
//     │      127.0.0.1   ← single server per remote  │
//     └──────────────────────────────────────────────┘
//                          ▲
//                    SSH local -L forward
//                  (4096 on remote → 14096 local)
//                          │
//   bui main (Electron):
//     - ensureRunning() boots the server if absent
//     - ensureForward() attaches a -L forward to the existing
//       SSH ControlMaster (same socket pty.ts uses)
//     - subscribeEvents() opens one long-lived SSE stream and
//       forwards every event to the renderer via IPC
//     - createSession() / listMessages() are thin HTTP clients
//
// Chat-mode tmux windows hold `sleep infinity` panes; the bui React UI is
// what the user actually interacts with. The tmux window exists only to keep
// the same project/window model that claude-TUI windows use.
//
// Auth: server binds 127.0.0.1 on the remote; the SSH tunnel keeps it off
// the wire. No OPENCODE_SERVER_PASSWORD configured.

import { spawn as cpSpawn } from "node:child_process";
import { join as pathJoin } from "node:path";
import { runSshOnce } from "./pty.js";
import type {
  AppConfig,
  OpencodeMessage,
  OpencodeModel,
  OpencodeSessionListItem,
} from "../shared/types.js";

const REMOTE_PORT = 4096;
export const BUI_OPENCODE_TMUX_SESSION = "bui-opencode";
export const OPENCODE_SID_OPT = "@bui-session-id";

function localPort(config: AppConfig): number {
  return config.opencodePort ?? 14096;
}

function sshTarget(config: AppConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host;
}

// ===== server lifecycle =====

export async function ensureRunning(config: AppConfig): Promise<void> {
  const { stdout } = await runSshOnce(
    config,
    `tmux has-session -t ${BUI_OPENCODE_TMUX_SESSION} 2>/dev/null && echo up || echo down`,
  );
  if (stdout.trim() === "up") return;

  // Ubuntu's stock .bashrc returns early when non-interactive, so the PATH
  // export the opencode installer writes never runs under `bash -lc`. Prepend
  // ~/.opencode/bin explicitly. If the user has a non-standard install we'll
  // surface a config knob for it later.
  const startCmd =
    `tmux new-session -d -s ${BUI_OPENCODE_TMUX_SESSION} ` +
    `'bash -c "export PATH=\\$HOME/.opencode/bin:\\$PATH; ` +
    `opencode serve --port ${REMOTE_PORT} --hostname 127.0.0.1"'`;
  await runSshOnce(config, startCmd);

  // First start runs sqlite migrations (a few seconds); subsequent restarts
  // are sub-second. Probe /global/health until it responds.
  await runSshOnce(
    config,
    `for i in $(seq 1 30); do ` +
    `  curl -fsS -o /dev/null http://127.0.0.1:${REMOTE_PORT}/global/health && exit 0; ` +
    `  sleep 1; ` +
    `done; exit 1`,
  );
}

// ===== local SSH -L forward =====
//
// We attach `-L localPort:127.0.0.1:REMOTE_PORT` to the SAME ControlMaster
// connection pty.ts uses, via `ssh -O forward`. Cancel is symmetric.

// Must match pty.ts's CONTROL_PATH exactly so we share its ControlMaster.
// `/tmp` (not tmpdir()) because macOS tmpdir() overflows the sun_path limit.
const CONTROL_PATH = pathJoin("/tmp", "bui-cm-%C");

function controlArgs(config: AppConfig): string[] {
  const args = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=10m",
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  return args;
}

function sshControl(config: AppConfig, op: string, extra: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [...controlArgs(config), "-O", op, ...extra, sshTarget(config)];
    const p = cpSpawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) return resolve();
      // "Forward already exists" is a normal idempotent case for `-O forward`.
      if (/already forwarded/i.test(stderr)) return resolve();
      reject(new Error(`ssh -O ${op} exited ${code}: ${stderr.trim()}`));
    });
  });
}

let forwarded = false;

// Probe + rebuild on every call. A cached "we already forwarded once" boolean
// lies after wifi drops, laptop sleep, or remote sshd restart — the master
// socket is gone but the flag still says up, and every fetch lands on a dead
// port. `ssh -O check` is ~1ms when the master is alive; we eat that cost to
// keep the path self-healing. `-O forward` is idempotent (sshControl treats
// "already forwarded" as success).
export async function ensureForward(config: AppConfig): Promise<void> {
  try {
    await sshControl(config, "check");
  } catch {
    // ControlMaster is gone (or never existed). Boot it via the same path
    // runSshOnce uses elsewhere.
    forwarded = false;
    await runSshOnce(config, "true");
  }
  const spec = `${localPort(config)}:127.0.0.1:${REMOTE_PORT}`;
  await sshControl(config, "forward", ["-L", spec]);
  forwarded = true;
}

export async function teardownForward(config: AppConfig): Promise<void> {
  if (!forwarded) return;
  const spec = `${localPort(config)}:127.0.0.1:${REMOTE_PORT}`;
  await sshControl(config, "cancel", ["-L", spec]).catch(() => {});
  forwarded = false;
}

export function invalidateForward(): void {
  forwarded = false;
}

// ===== HTTP client =====

function apiUrl(config: AppConfig, path: string): string {
  return `http://127.0.0.1:${localPort(config)}${path}`;
}

export type CreatedSession = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
};

export async function createSession(
  config: AppConfig,
  directory: string,
  title: string,
): Promise<CreatedSession> {
  await ensureForward(config);
  const url = apiUrl(config, `/session?directory=${encodeURIComponent(directory)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`opencode createSession ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as CreatedSession;
}

// Fetch the full transcript for a session. Phase 1 renders the result as-is;
// the renderer ignores parts it can't render (everything except text/reasoning).
export async function listMessages(
  config: AppConfig,
  sessionId: string,
): Promise<OpencodeMessage[]> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/message`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`opencode listMessages ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as OpencodeMessage[];
}

// Send a user message into the session.
//
// We use the v1 `prompt_async` endpoint (returns 204 immediately, the
// assistant response streams via SSE events). The v2 `/api/session/{id}/prompt`
// endpoint also exists but returns 400 with a "Expected Session.Message, got {}"
// error even when the body matches its documented Prompt schema — looks like
// an upstream bug. Revisit if/when opencode fixes it.
//
// Body shape: `{parts: [{type:"text", text}], model?, ...}` — verified empirically.
// When `model` is omitted opencode falls back to the user's configured default.
// `model` is per-prompt: opencode has no session-level model setting — PATCH
// /session/{id} accepts only title/permission/archived.
export type PromptModel = { providerID: string; modelID: string; variant?: string };

// Attached file: scp'd to the remote, referenced by absolute remote path. The
// server reads from file:// URLs on its own filesystem (opencode runs there).
export type PromptAttachment = {
  remotePath: string;        // absolute path on the remote
  mime: string;
  filename?: string;
};

// Agent mention: structured part for @<agent-name> tokens. `source` carries
// the {start, end} offsets in the rendered text so opencode can correlate
// where the mention appears in the typed message.
export type PromptAgentMention = {
  name: string;
  source: { value: string; start: number; end: number };
};

export async function sendPrompt(
  config: AppConfig,
  sessionId: string,
  text: string,
  model?: PromptModel,
  attachments?: PromptAttachment[],
  mentions?: PromptAgentMention[],
): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/prompt_async`);
  const parts: Array<Record<string, unknown>> = [];
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
      parts.push({
        type: "agent",
        name: m.name,
        source: m.source,
      });
    }
  }
  parts.push({ type: "text", text });

  const body: Record<string, unknown> = { parts };
  if (model) {
    body.model = { providerID: model.providerID, modelID: model.modelID };
    if (model.variant) body.variant = model.variant;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode sendPrompt ${res.status}: ${await res.text()}`);
  }
}

// Interrupt the running generation for a session. Idempotent — fine to call
// when nothing is running (the server just returns success).
export async function abortSession(config: AppConfig, sessionId: string): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/abort`);
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode abortSession ${res.status}: ${await res.text()}`);
  }
}

// ===== Permission flow =====
//
// Tools like Write/Edit/Bash can request user approval before executing.
// While a permission is pending the tool's state.status stays at "pending"
// — that's the source of the "stuck on write pending" symptom you saw.
//
// API:
//   GET  /permission                          — list ALL pending permissions
//   POST /permission/{id}/reply  {reply: ...} — approve/deny one
//                                  reply: "once" | "always" | "reject"
// Events: permission.asked, permission.replied (already forwarded by bus).

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
};

export async function listPermissions(
  config: AppConfig,
): Promise<PermissionRequest[]> {
  await ensureForward(config);
  const res = await fetch(apiUrl(config, "/permission"));
  if (!res.ok) {
    throw new Error(`opencode listPermissions ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PermissionRequest[];
}

export async function replyPermission(
  config: AppConfig,
  requestId: string,
  reply: "once" | "always" | "reject",
): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/permission/${encodeURIComponent(requestId)}/reply`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyPermission ${res.status}: ${await res.text()}`);
  }
}

// ===== Question flow =====
//
// When Claude invokes the Question tool, opencode emits question.asked and
// blocks. The user picks options; we POST to /question/{id}/reply to unblock.
// API is v2-only. Events: question.asked, question.replied, question.rejected.

export type QuestionOption = { label: string; description: string };
export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

export async function listQuestions(
  config: AppConfig,
): Promise<QuestionRequest[]> {
  await ensureForward(config);
  const res = await fetch(apiUrl(config, "/question"));
  if (!res.ok) {
    throw new Error(`opencode listQuestions ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as QuestionRequest[];
}

// answers is one string[] per QuestionInfo — the selected option labels (or
// the user's free-text input when custom is true).
export async function replyQuestion(
  config: AppConfig,
  requestId: string,
  answers: string[][],
): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/question/${encodeURIComponent(requestId)}/reply`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyQuestion ${res.status}: ${await res.text()}`);
  }
}

export async function rejectQuestion(
  config: AppConfig,
  requestId: string,
): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/question/${encodeURIComponent(requestId)}/reject`);
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode rejectQuestion ${res.status}: ${await res.text()}`);
  }
}

// ===== Model list =====
//
// Two sources we care about:
//   GET /provider     — full provider registry. `all[]` has every known
//                       provider opencode ships with (~128 of them, thousands
//                       of models). `connected[]` is the small subset the
//                       server has actually authed against. `default` maps
//                       provider id → its default model id.
//   GET /api/model    — v2-style flat list, BUT it returns providers that
//                       have credentials configured even if they aren't in
//                       `connected` — and the response embeds raw API keys
//                       under `options.aisdk.provider.apiKey`. Unusable.
//
// We want: only models from CONNECTED providers, surfaced in a flat list.
// `connected` is just an array of provider ids; we filter `all` by it and
// flatten each provider's `models` map.
// What opencode uses when prompt_async is called without an explicit model.
// Pulled from `/provider`'s `default` map for the first connected provider.
// Used by the renderer to show a meaningful label BEFORE the first assistant
// response (otherwise we'd render an empty/fallback string).
export async function getDefaultModel(
  config: AppConfig,
): Promise<{ providerID: string; modelID: string } | null> {
  await ensureForward(config);
  const res = await fetch(apiUrl(config, "/provider"));
  if (!res.ok) return null;
  type R = { connected?: string[]; default?: Record<string, string> };
  const data = (await res.json()) as R;
  const connected = data.connected ?? [];
  const defaults = data.default ?? {};
  for (const id of connected) {
    const modelID = defaults[id];
    if (modelID) return { providerID: id, modelID };
  }
  return null;
}

// Only include models from CONNECTED providers (`/provider.connected`).
// `/api/model` lists Anthropic-via-OAuth + others, but those routes don't
// actually serve prompts — opencode rejects them with "Model not found"
// when invoked. Until `/provider.connected` includes a given provider, its
// models stay out of the picker.
export async function listModels(config: AppConfig): Promise<OpencodeModel[]> {
  await ensureForward(config);
  const out: OpencodeModel[] = [];
  try {
    const res = await fetch(apiUrl(config, "/provider"));
    if (res.ok) {
      type ProviderRow = {
        id?: string;
        models?: Record<string, Record<string, unknown>>;
      };
      type ProviderResponse = { all?: ProviderRow[]; connected?: string[] };
      const data = (await res.json()) as ProviderResponse;
      const connected = new Set(data.connected ?? []);
      for (const p of data.all ?? []) {
        if (!p.id || !connected.has(p.id)) continue;
        for (const modelId of Object.keys(p.models ?? {})) {
          out.push(normalizeProviderModel(p.id, modelId, (p.models ?? {})[modelId]));
        }
      }
    }
  } catch {
    /* non-fatal */
  }
  return out;
}

function normalizeProviderModel(
  providerID: string,
  modelId: string,
  m: Record<string, unknown>,
): OpencodeModel {
  let variants: Array<{ id: string }> | undefined;
  const vRaw = m.variants;
  if (Array.isArray(vRaw)) {
    variants = vRaw
      .map((v) =>
        v && typeof v === "object" ? String((v as Record<string, unknown>).id ?? "") : "",
      )
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
    limit: m.limit as OpencodeModel["limit"],
    capabilities: m.capabilities as OpencodeModel["capabilities"],
    variants: variants && variants.length > 0 ? variants : undefined,
  };
}

// ===== Slash commands, agents, file search =====
//
// Commands: built-in (/init etc.) and user-defined (markdown templates).
// Agents: built-in primary agents + user-defined sub-agents. Both are used
// as typeahead sources for the @-mention popup in ChatPanel.
// File search: relative paths under a directory, fast enough for live
// keystroke-driven typeahead.

export type OpencodeCommand = {
  name: string;
  description?: string;
  source?: string;     // "command" (built-in) | "project" | "global"
  argumentHint?: string;
  agent?: string;
  model?: string;
};

export type OpencodeAgent = {
  name: string;
  description?: string;
  mode?: string;       // "primary" | "subagent"
  native?: boolean;
  builtIn?: boolean;
};

export async function listCommands(config: AppConfig): Promise<OpencodeCommand[]> {
  await ensureForward(config);
  const res = await fetch(apiUrl(config, "/command"));
  if (!res.ok) {
    throw new Error(`opencode listCommands ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((c) => ({
    name: String(c.name ?? ""),
    description: typeof c.description === "string" ? c.description : undefined,
    source: typeof c.source === "string" ? c.source : undefined,
    argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : undefined,
    agent: typeof c.agent === "string" ? c.agent : undefined,
    model: typeof c.model === "string" ? c.model : undefined,
  }));
}

export async function listAgents(config: AppConfig): Promise<OpencodeAgent[]> {
  await ensureForward(config);
  const res = await fetch(apiUrl(config, "/agent"));
  if (!res.ok) {
    throw new Error(`opencode listAgents ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((a) => ({
    name: String(a.name ?? ""),
    description: typeof a.description === "string" ? a.description : undefined,
    mode: typeof a.mode === "string" ? a.mode : undefined,
    native: typeof a.native === "boolean" ? a.native : undefined,
    builtIn: typeof a.builtIn === "boolean" ? a.builtIn : undefined,
  }));
}

// File search via opencode's ripgrep-backed endpoint. Returns relative paths
// from `directory`. Empty query returns top-level entries of `directory` —
// exactly what the @-mention typeahead wants when the user has just typed
// `@` with no filter, so we pass empty queries through.
export async function findFiles(
  config: AppConfig,
  query: string,
  directory: string,
): Promise<string[]> {
  await ensureForward(config);
  const qs =
    `?query=${encodeURIComponent(query)}&directory=${encodeURIComponent(directory)}`;
  const res = await fetch(apiUrl(config, `/find/file${qs}`));
  if (!res.ok) {
    throw new Error(`opencode findFiles ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as string[];
}

// Invoke a slash command. Returns when the server accepts the message; the
// assistant response streams via SSE just like prompt_async.
//
// `command` is the command name (no leading slash). `arguments` is the rest
// of the line (everything after `/cmd `). Parts mirror prompt_async — caller
// can attach files alongside the command.
export async function runCommand(
  config: AppConfig,
  sessionId: string,
  command: string,
  argumentsStr: string,
  attachments?: PromptAttachment[],
  model?: PromptModel,
): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/command`);
  const parts: Array<Record<string, unknown>> = [];
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
  const body: Record<string, unknown> = {
    command,
    arguments: argumentsStr,
    parts,
  };
  // /session/{id}/command takes model as a string (e.g. "provider/model"),
  // not the structured object prompt_async uses.
  if (model) {
    body.model = `${model.providerID}/${model.modelID}`;
    if (model.variant) body.variant = model.variant;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode runCommand ${res.status}: ${await res.text()}`);
  }
}

// ===== Session management =====

// GET /session?directory=... lists sessions scoped to a project directory.
// We don't paginate (limit defaults large on the server). Returns trimmed
// metadata only — the renderer fetches full transcripts on demand.
export async function listSessions(
  config: AppConfig,
  directory?: string,
): Promise<OpencodeSessionListItem[]> {
  await ensureForward(config);
  const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const res = await fetch(apiUrl(config, `/session${qs}`));
  if (!res.ok) {
    throw new Error(`opencode listSessions ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as OpencodeSessionListItem[];
}

// Fork: copies session history up to `messageID` (or end if omitted) into a
// fresh session. Returns the new session's metadata (same shape as create).
export async function forkSession(
  config: AppConfig,
  sessionId: string,
  messageID?: string,
): Promise<CreatedSession> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/fork`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageID ? { messageID } : {}),
  });
  if (!res.ok) {
    throw new Error(`opencode forkSession ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as CreatedSession;
}

// Compact: v2 endpoint summarizes the session in-place, freeing context. The
// server emits session.compacted via SSE so the renderer's normal refetch
// path picks up the new transcript automatically.
export async function compactSession(config: AppConfig, sessionId: string): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/api/session/${encodeURIComponent(sessionId)}/compact`);
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode compactSession ${res.status}: ${await res.text()}`);
  }
}

// Delete: removes the session and its messages on the server. Caller is
// responsible for tearing down the matching tmux window separately.
export async function deleteSession(config: AppConfig, sessionId: string): Promise<void> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}`);
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`opencode deleteSession ${res.status}: ${await res.text()}`);
  }
}

// ===== SSE event subscription =====
//
// Returns an async iterator of parsed events. Caller calls dispose() to abort.
// SSE framing: events are separated by blank lines; data: lines carry JSON.

export type EventStream = {
  iter: AsyncIterableIterator<{ id?: string; type: string; properties: Record<string, unknown> }>;
  dispose: () => void;
};

export async function subscribeEvents(config: AppConfig): Promise<EventStream> {
  await ensureForward(config);
  const controller = new AbortController();
  const res = await fetch(apiUrl(config, "/event"), {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`opencode SSE ${res.status}: ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  async function* gen(): AsyncIterableIterator<{ id?: string; type: string; properties: Record<string, unknown> }> {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data:")) {
              data += (data ? "\n" : "") + line.slice(5).trimStart();
            }
            // ignore event: / id: / retry: — type discriminator is inside the JSON
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            yield parsed;
          } catch {
            // skip malformed event rather than tear down the stream
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  return { iter: gen(), dispose: () => controller.abort() };
}

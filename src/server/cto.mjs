// cto.mjs — the "On-call CTO" read gateway (BET-1164, issue 1/3).
//
// The durable server foundation for the on-call CTO feature: a registry of
// deterministic READ-ONLY tools (what's running, transcripts, git, usage,
// plan mode, config, the Multica board) exposed through a single
// `dispatch(tool, args, ctx)` seam that the later issues (2 = inbound feed,
// 3 = call window + voice) and the opencode text agent all consume.
//
// Design rules (from the issue):
//   - THIN proxies over existing engines. Every tool reuses an existing
//     engine's injected I/O — nothing is reimplemented. If an engine does not
//     exist, the tool is out of scope (noted, never invented).
//   - Pure decision logic + injected I/O, no top-level side effects —
//     mirrors src/server/delegate.mjs / src/server/usage.mjs. The engine is
//     built by `createCtoEngine(deps)`; deps carry every engine the tools
//     need (listProjects, listSessions, listMessages, listModels,
//     getSessionAgent, listSnapshots, listStopped, searchMessages, configGet,
//     the git helpers, queryMultica, now). Tests inject fakes; index.mjs
//     wires the real engines.
//   - Every tool is `mode: "auto"`. The `gate` seam (a `(tool, args) =>
//     "allow"|"confirm"|"deny"` callback) is implemented but Issue 1 ships no
//     confirm/deny — the default gate returns "allow".
//   - `onNarrate(text)`: a no-op-safe hook called at tool boundaries (voice
//     narration lands in Issue 3). Must do nothing when unset.
//   - NO read may throw on a quiet box (empty board, no sessions, no usage
//     provider). dispatch returns `{ok:false, error}` instead of throwing for
//     engine-level failures, and the tools guard empty inputs.

import { execFile } from "node:child_process";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { describeModel } from "../shared/modelGuide.mjs";

export const CTO_STORE_PATH = statePath("cto.json");

// The store the later issues build on. Issue 1 only LAYS IT DOWN: `watches`
// and `inbound` stay empty until issue 2 fills them, `audit` is the box's
// append-only tool-usage trail. Atomic load/save via injected I/O.
export function defaultCtoStore() {
  return { version: 1, watches: [], inbound: [], audit: [] };
}

export function loadCtoStore(path = CTO_STORE_PATH) {
  const parsed = readJsonSync(path, {});
  const base = defaultCtoStore();
  return {
    version: typeof parsed?.version === "number" ? parsed.version : base.version,
    watches: Array.isArray(parsed?.watches) ? parsed.watches : [],
    inbound: Array.isArray(parsed?.inbound) ? parsed.inbound : [],
    audit: Array.isArray(parsed?.audit) ? parsed.audit : [],
  };
}

export async function saveCtoStore(state, path = CTO_STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify(state ?? defaultCtoStore(), null, 2));
}

/**
 * Append one audit entry to the cto store (best-effort, atomic). The audit is
 * the box's tool-usage trail; it is only written when a caller opts in by
 * providing load/save — the read tools themselves never write.
 * @param {object} entry
 * @param {object} [deps]
 * @param {() => object} [deps.load]
 * @param {(s: object) => Promise<void>} [deps.save]
 */
export async function appendCtoAudit(entry, { load = loadCtoStore, save = saveCtoStore, now = () => Date.now() } = {}) {
  const store = load();
  store.audit = [...(Array.isArray(store.audit) ? store.audit : []), { at: now(), ...entry }];
  await save(store);
  return store;
}

// ---------------------------------------------------------------------------
// Dispatch seam
// ---------------------------------------------------------------------------

const DEFAULT_GATE = () => "allow";
const NOOP_NARRATE = () => {};

/**
 * createCtoEngine(deps) → the CTO tool registry + dispatch.
 *
 * @param {object} [deps] injected engine I/O — every tool reads through these:
 * @param {() => Promise<Array<object>>} [deps.listProjects]  tmux.listProjects
 * @param {(directory?: string) => Promise<Array<object>>} [deps.listSessions]  oc.listSessions
 * @param {(sessionId: string, opts?: object) => Promise<Array<object>>} [deps.listMessages]  oc.listMessages
 * @param {() => Promise<Array<object>>} [deps.listModels]  oc.listModels
 * @param {(sessionId: string) => Promise<string|null>} [deps.getSessionAgent]  oc.getSessionAgent
 * @param {() => Array<object>} [deps.listSnapshots]  usage.listSnapshots (synchronous polled cache)
 * @param {(opts?: object) => Promise<{records: Array<object>, lastLooked: number|null}>} [deps.listStopped]  stoppedStore.listStopped
 * @param {(opts: object) => Promise<{supported: boolean, hits: Array<object>}>} [deps.searchMessages]  messageSearch.searchMessages
 * @param {() => Promise<object>} [deps.configGet]  local.configGet
 * @param {(cwd: string) => Promise<string>} [deps.gitStatus]   porcelain or throw
 * @param {(cwd: string) => Promise<string|null>} [deps.gitBranch]  current branch or null
 * @param {(cwd: string, opts: object) => Promise<string>} [deps.gitLog]
 * @param {(input: object) => Promise<object>} [deps.queryMultica]  multica.queryMultica
 * @param {(name: string|null) => boolean} [deps.isPlanAgent]  shared planMode isPlanAgent
 * @param {() => number} [deps.now]
 * @returns {{tools: Array<object>, dispatch: Function, listTools: Function}}
 */
export function createCtoEngine(deps = {}) {
  const {
    listProjects = async () => [],
    listSessions = async () => [],
    listMessages = async () => [],
    listModels = async () => [],
    getSessionAgent = async () => null,
    listSnapshots = () => [],
    listStopped = async () => ({ records: [], lastLooked: null }),
    searchMessages = async () => ({ supported: false, hits: [] }),
    configGet = async () => ({}),
    gitStatus = remoteGitStatus,
    gitBranch = remoteGitBranch,
    gitLog = remoteGitLog,
    queryMultica = async () => ({ ok: true, data: {} }),
    isPlanAgent = (name) => name === "plan" || name === "manta-plan",
    now = () => Date.now(),
  } = deps;

  const tools = [];
  const register = (def) => {
    tools.push({
      name: def.name,
      description: def.description,
      params: def.params ?? {},
      mode: def.mode ?? "auto",
      run: def.run,
    });
  };

  // -------------------------------------------------------------------------
  // What's running — list_sessions / list_projects
  // -------------------------------------------------------------------------
  // Build a per-chat-session info map (model + directory) in one pass over
  // listSessions per distinct owning directory, so a session is never
  // queried per-window. Plan mode is resolved per chat window via
  // getSessionAgent (the same seed the plan-mode toggle uses).
  async function sessionInfoMap(projects) {
    const dirs = [];
    for (const p of projects) {
      for (const w of p?.windows ?? []) {
        const d = w?.paneCurrentPath || p?.defaultCwd;
        if (typeof d === "string" && d && !dirs.includes(d)) dirs.push(d);
      }
    }
    const info = new Map();
    const sessionsById = new Map();
    await Promise.all(
      dirs.map(async (dir) => {
        let sessions;
        try {
          sessions = await listSessions(dir);
        } catch {
          sessions = [];
        }
        for (const s of Array.isArray(sessions) ? sessions : []) {
          if (!s?.id) continue;
          sessionsById.set(s.id, s);
          if (!info.has(s.id)) {
            info.set(s.id, {
              model: s?.info?.providerID && s?.info?.modelID ? `${s.info.providerID}/${s.info.modelID}` : null,
              directory: dir,
            });
          }
        }
      }),
    );
    return { info, sessionsById };
  }

  async function summarizeProjects(raw) {
    const projects = Array.isArray(raw) ? raw : [];
    const { info } = await sessionInfoMap(projects);
    return projects.map((p) => ({
      tmuxSession: p?.tmuxSession,
      defaultCwd: p?.defaultCwd,
      windows: (p?.windows ?? []).map((w) => ({
        index: w?.index,
        name: w?.name,
        active: !!w?.active,
        chat: typeof w?.opencodeSessionId === "string" && !!w?.opencodeSessionId,
        sessionID: w?.opencodeSessionId ?? null,
        model: w?.opencodeSessionId ? (info.get(w.opencodeSessionId)?.model ?? null) : null,
      })),
    }));
  }

  register({
    name: "list_sessions",
    description:
      "List what is running on the box: every project (tmux session) and its windows, " +
      "with whether each window is a chat session, its session model, and plan-mode " +
      "state. Read-only. Empty box returns []. Use this first to see the layout.",
    params: {},
    run: async (ctx, args) => {
      const projects = await listProjects();
      const { info, sessionsById } = await sessionInfoMap(projects);
      const sessions = [];
      for (const p of Array.isArray(projects) ? projects : []) {
        for (const w of p?.windows ?? []) {
          if (typeof w?.opencodeSessionId !== "string" || !w.opencodeSessionId) continue;
          const sid = w.opencodeSessionId;
          const info_ = info.get(sid) ?? {};
          const s = sessionsById.get(sid);
          sessions.push({
            sessionID: sid,
            workspace: p?.tmuxSession,
            window: `${w?.index}${w?.name ? `:${w.name}` : ""}`,
            model: info_.model ?? null,
            planMode: !!isPlanAgent(await safeAgent(sid)),
            branch: null,
            directory: info_.directory ?? w?.paneCurrentPath ?? p?.defaultCwd ?? null,
            cost: s?.cost ?? null,
            tokens: s?.tokens ?? null,
            updated: s?.time?.updated ?? null,
          });
        }
      }
      return {
        ok: true,
        data: {
          projects: await summarizeProjects(projects),
          sessions,
          isEmpty: sessions.length === 0 && projects.length === 0,
        },
      };
    },
  });

  // getSessionAgent is best-effort (never throws); wrap defensively so a
  // transient opencode blip never fails the whole listing.
  async function safeAgent(sid) {
    try {
      return await getSessionAgent(sid);
    } catch {
      return null;
    }
  }

  register({
    name: "list_projects",
    description:
      "List the projects (tmux sessions) and their windows on the box, with chat vs " +
      "terminal per window. A lighter alias of list_sessions; same data, project-shaped. " +
      "Read-only. Empty box returns [].",
    params: {},
    run: async () => ({ ok: true, data: { projects: await summarizeProjects(await listProjects()) } }),
  });

  // -------------------------------------------------------------------------
  // Transcripts — read_transcript / search_messages
  // -------------------------------------------------------------------------
  register({
    name: "read_transcript",
    description:
      "Read the conversation of a chat session (sessionID from list_sessions). Returns " +
      "a BOUNDED window: the most recent messages with role, token counts, time and a " +
      "truncated text preview (content is real, capped — never fabricated). Use to " +
      "understand what a session is working on.",
    params: {
      sessionID: { type: "string", description: "The opencode session id." },
      maxMessages: { type: "number", description: "Most recent N messages to return (default 30, max 100)." },
    },
    run: async (ctx, args) => {
      const sid = String(args?.sessionID ?? "");
      if (!sid) return { ok: false, error: "sessionID is required" };
      const limit = clampInt(args?.maxMessages, 30, 1, 100);
      let messages;
      try {
        messages = await listMessages(sid, { limit });
      } catch (e) {
        return { ok: false, error: `could not read transcript: ${e?.message ?? e}` };
      }
      const arr = Array.isArray(messages) ? messages : [];
      const recent = arr.slice(-limit).map((m) => ({
        role: m?.info?.role ?? null,
        tokens: m?.tokens ?? null,
        time: m?.time ?? null,
        preview: previewText(m),
      }));
      return {
        ok: true,
        data: {
          sessionID: sid,
          count: arr.length,
          truncated: arr.length > limit,
          messages: recent,
        },
      };
    },
  });

  register({
    name: "search_messages",
    description:
      "Search chat transcripts across every chat-mode window on the box using the same " +
      "engine as the ⌘F palette. Returns matches with snippet context grouped by session. " +
      "Read-only. An unsupported box (no node:sqlite) returns hits: [].",
    params: { query: { type: "string", description: "The search text." } },
    run: async (ctx, args) => {
      const q = String(args?.query ?? "");
      if (!q.trim()) return { ok: true, data: { query: q, hits: [] } };
      const projects = await listProjects();
      const sessionIds = [];
      for (const p of Array.isArray(projects) ? projects : []) {
        for (const w of p?.windows ?? []) {
          if (typeof w?.opencodeSessionId === "string" && w.opencodeSessionId) sessionIds.push(w.opencodeSessionId);
        }
      }
      let res;
      try {
        res = await searchMessages({ query: q, sessionIds });
      } catch (e) {
        return { ok: false, error: `search failed: ${e?.message ?? e}` };
      }
      return { ok: true, data: { query: q, supported: !!res?.supported, hits: res?.hits ?? [] } };
    },
  });

  // -------------------------------------------------------------------------
  // Git — git_status / git_branch / git_log
  // -------------------------------------------------------------------------
  async function resolveCwd(ctx, args) {
    if (typeof args?.cwd === "string" && args.cwd) return args.cwd;
    if (typeof ctx?.cwd === "string" && ctx.cwd) return ctx.cwd;
    const projects = await listProjects();
    const first = (Array.isArray(projects) ? projects : []).find((p) => p?.defaultCwd);
    return first?.defaultCwd ?? null;
  }

  register({
    name: "git_status",
    description:
      "Pending (uncommitted) changes in a project: git status --porcelain output and a " +
      "change count. cwd defaults to the caller's or the first box project. Read-only.",
    params: { cwd: { type: "string", description: "Optional repo directory." } },
    run: async (ctx, args) => {
      const cwd = await resolveCwd(ctx, args);
      if (!cwd) return { ok: true, data: { cwd: null, status: null, count: 0 } };
      let porcelain;
      try {
        porcelain = await gitStatus(cwd);
      } catch (e) {
        return { ok: false, error: `git status failed: ${e?.message ?? e}` };
      }
      const count = (porcelain ?? "").split("\n").filter((l) => l.length > 0).length;
      return { ok: true, data: { cwd, status: porcelain ?? "", count } };
    },
  });

  register({
    name: "git_branch",
    description:
      "The current git branch of a project. cwd defaults like git_status. Read-only.",
    params: { cwd: { type: "string", description: "Optional repo directory." } },
    run: async (ctx, args) => {
      const cwd = await resolveCwd(ctx, args);
      if (!cwd) return { ok: true, data: { cwd: null, branch: null } };
      let branch = null;
      try {
        branch = (await gitBranch(cwd)) ?? null;
      } catch {
        branch = null;
      }
      return { ok: true, data: { cwd, branch } };
    },
  });

  register({
    name: "git_log",
    description:
      "Recent git history of a project (default 10 commits, one line each with hash, " +
      "author and subject). cwd defaults like git_status. Read-only.",
    params: {
      cwd: { type: "string", description: "Optional repo directory." },
      n: { type: "number", description: "Number of commits (default 10, max 50)." },
    },
    run: async (ctx, args) => {
      const cwd = await resolveCwd(ctx, args);
      if (!cwd) return { ok: true, data: { cwd: null, log: null } };
      const n = clampInt(args?.n, 10, 1, 50);
      let log;
      try {
        log = await gitLog(cwd, { n, oneline: true });
      } catch (e) {
        return { ok: false, error: `git log failed: ${e?.message ?? e}` };
      }
      return { ok: true, data: { cwd, log: log ?? "" } };
    },
  });

  // -------------------------------------------------------------------------
  // Models / usage / stopped / per-session cost / context / plan mode / config
  // -------------------------------------------------------------------------
  register({
    name: "list_models",
    description:
      "The models available on this box (from opencode /provider filtered to connected), " +
      "each with its context-window limit and a rough capability tier (fast/balanced/deep). " +
      "Read-only.",
    params: {},
    run: async () => {
      let models;
      try {
        models = await listModels();
      } catch {
        models = [];
      }
      const data = (Array.isArray(models) ? models : []).map((m) => {
        const cat = describeModel(m?.providerID, m?.id);
        return {
          providerID: m?.providerID,
          modelID: m?.id,
          name: m?.name ?? m?.id ?? null,
          contextLimit: m?.limit?.context ?? null,
          tier: cat?.tier ?? null,
          blurb: cat?.blurb ?? null,
        };
      });
      return { ok: true, data: { models: data } };
    },
  });

  register({
    name: "get_usage",
    description:
      "The box's subscription plan usage (quota/credits/limits per provider) from the " +
      "already-polled usage cache — never triggers a new poll. Read-only. An untouched " +
      "or unsupported provider simply returns no snapshot.",
    params: {},
    run: async () => {
      let snaps;
      try {
        snaps = listSnapshots();
      } catch (e) {
        return { ok: false, error: `usage read failed: ${e?.message ?? e}` };
      }
      return { ok: true, data: { snapshots: (Array.isArray(snaps) ? snaps : []).map((s) => ({ ...s })) } };
    },
  });

  register({
    name: "usage_stopped",
    description:
      "Conversations the box stopped because a plan-usage limit was hit (the durable " +
      "stopped-store). Returns the records + the last-looked timestamp. Read-only.",
    params: {},
    run: async () => {
      let res;
      try {
        res = await listStopped();
      } catch (e) {
        return { ok: false, error: `stopped-store read failed: ${e?.message ?? e}` };
      }
      return { ok: true, data: { records: res?.records ?? [], lastLooked: res?.lastLooked ?? null } };
    },
  });

  register({
    name: "session_usage",
    description:
      "Per-session cost and token totals (input/output) for a chat session, read off the " +
      "opencode session list item. Read-only.",
    params: { sessionID: { type: "string", description: "The opencode session id." } },
    run: async (ctx, args) => {
      const sid = String(args?.sessionID ?? "");
      if (!sid) return { ok: false, error: "sessionID is required" };
      const { sessionsById } = await sessionInfoMap(await listProjects());
      const s = sessionsById.get(sid);
      if (!s) return { ok: false, error: `no such session: ${sid}` };
      return {
        ok: true,
        data: {
          sessionID: sid,
          cost: s?.cost ?? null,
          tokens: s?.tokens ?? null,
          updated: s?.time?.updated ?? null,
        },
      };
    },
  });

  register({
    name: "context_state",
    description:
      "The context state of a chat session: its model's context-window limit, the last " +
      "message's token usage, how long the session has been idle, and the configured " +
      "cache TTL (the same inputs the UI context pill uses). Read-only.",
    params: { sessionID: { type: "string", description: "The opencode session id." } },
    run: async (ctx, args) => {
      const sid = String(args?.sessionID ?? "");
      if (!sid) return { ok: false, error: "sessionID is required" };
      const { info, sessionsById } = await sessionInfoMap(await listProjects());
      const s = sessionsById.get(sid);
      const info_ = info.get(sid) ?? {};
      let models = [];
      try {
        models = await listModels();
      } catch {
        models = [];
      }
      const model = models.find((m) => m?.providerID === info_?.model?.split("/")[0] && m?.id === info_?.model?.split("/")[1]);
      let messages = [];
      try {
        messages = await listMessages(sid, { limit: 1 });
      } catch {
        messages = [];
      }
      const last = (Array.isArray(messages) ? messages : []).slice(-1)[0];
      const lastTime = last?.time ?? s?.time?.updated ?? null;
      const idleMs = typeof lastTime === "number" && lastTime > 0 ? Math.max(0, now() - lastTime) : null;
      let cfg = {};
      try {
        cfg = (await configGet()) ?? {};
      } catch {
        cfg = {};
      }
      return {
        ok: true,
        data: {
          sessionID: sid,
          model: info_?.model ?? null,
          contextLimit: model?.limit?.context ?? null,
          lastTokens: last?.tokens ?? null,
          idleMs,
          cacheTtlMs: cacheTtlMs(cfg?.cacheTtl),
        },
      };
    },
  });

  register({
    name: "session_plan_mode",
    description:
      "Whether a chat session is in plan mode (its active agent is the plan agent). " +
      "Read-only.",
    params: { sessionID: { type: "string", description: "The opencode session id." } },
    run: async (ctx, args) => {
      const sid = String(args?.sessionID ?? "");
      if (!sid) return { ok: false, error: "sessionID is required" };
      const agent = await safeAgent(sid);
      return { ok: true, data: { sessionID: sid, planMode: !!isPlanAgent(agent), agent } };
    },
  });

  const SECRET_KEYS = new Set(["groqApiKey", "boxToken", "apiKey", "token", "secret", "secretKey"]);

  function stripSecrets(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(stripSecrets);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = v && typeof v === "object" ? stripSecrets(v) : v;
    }
    return out;
  }

  function pickPath(obj, path) {
    if (!path) return obj;
    return String(path).split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
  }

  register({
    name: "get_config",
    description:
      "Read this box's config.json. With no path returns the whole config with secret " +
      "fields scrubbed; with a dot path (e.g. \"defaultModel\") returns just that value. " +
      "Never returns secrets. Read-only.",
    params: { path: { type: "string", description: "Optional dot-path into the config." } },
    run: async (ctx, args) => {
      let cfg;
      try {
        cfg = (await configGet()) ?? {};
      } catch (e) {
        return { ok: false, error: `config read failed: ${e?.message ?? e}` };
      }
      let value = pickPath(cfg, args?.path);
      if (args?.path) {
        value = value && typeof value === "object" ? stripSecrets(value) : value;
        return { ok: true, data: { path: args.path, value: value ?? null } };
      }
      return { ok: true, data: { config: stripSecrets(cfg) } };
    },
  });

  // -------------------------------------------------------------------------
  // Multica board — query_multica
  // -------------------------------------------------------------------------
  register({
    name: "query_multica",
    description:
      "Query the Multica task board (an external integration, not native Manta): pass " +
      "`issue` with a bump key (e.g. \"BET-123\") for that issue's detail + task-runs + " +
      "pull requests, or omit it for a board overview grouped by status. Read-only.",
    params: {
      query: { type: "string", description: "Natural-language intent (informational)." },
      issue: { type: "string", description: "Optional issue key, e.g. BET-123." },
    },
    run: async (ctx, args) => {
      try {
        const data = await queryMultica({ query: args?.query ?? "", issue: args?.issue ?? null });
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: `multica query failed: ${e?.message ?? e}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function dispatch(name, args, ctx = {}) {
    const def = byName.get(String(name ?? ""));
    if (!def) {
      return { ok: false, error: `unknown cto tool: ${name} (known: ${tools.map((t) => t.name).join(", ")})` };
    }
    const gate = typeof ctx?.gate === "function" ? ctx.gate : DEFAULT_GATE;
    let decision;
    try {
      decision = gate(def.name, args ?? {});
    } catch {
      decision = "deny";
    }
    if (decision === "deny") {
      return { ok: false, error: `tool ${def.name} denied` };
    }
    if (decision === "confirm") {
      // Issue 1 ships only "auto" tools and wires no confirm/deny surface.
      // The seam exists so Issue 3 can gate before run; until then a confirm
      // request fails closed with a clear message rather than running.
      return { ok: false, error: `tool ${def.name} requires confirmation (not wired yet)` };
    }
    const narrate = typeof ctx?.onNarrate === "function" ? ctx.onNarrate : NOOP_NARRATE;
    try {
      narrate(`[cto] ${def.name}`);
      const result = await def.run(ctx, args ?? {});
      narrate(`[cto] ${def.name} ok`);
      return result;
    } catch (e) {
      narrate(`[cto] ${def.name} error`);
      return { ok: false, error: `${def.name} failed: ${e?.message ?? e}` };
    }
  }

  return {
    tools,
    listTools: () => tools.map((t) => ({ ...t })),
    dispatch,
  };
}

// ---------------------------------------------------------------------------
// Small local helpers (pure)
// ---------------------------------------------------------------------------

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function cacheTtlMs(ttl) {
  if (ttl === "5m") return 5 * 60_000;
  if (ttl === "1h") return 60 * 60_000;
  return null;
}

// First meaningful text from an opencode message part, capped. Real content,
// never invented — just bounded for the transcript tool.
function previewText(m) {
  if (!m || !Array.isArray(m.parts)) return null;
  let text = "";
  for (const p of m.parts) {
    if (p?.type === "text" && typeof p.text === "string") text += p.text;
    if (text.length >= 500) break;
  }
  text = text.trim();
  return text ? (text.length > 500 ? `${text.slice(0, 500)}…` : text) : null;
}

// ---------------------------------------------------------------------------
// Default git I/O (injectable). Uses a plain spawn with a short timeout;
// index.mjs may inject the same engines as the rest of the box instead.
// ---------------------------------------------------------------------------

function runGit(args, cwd, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        const e = new Error(err.stderr?.trim() || err.message);
        e.status = err.code;
        reject(e);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

async function remoteGitStatus(cwd) {
  return runGit(["-C", cwd, "status", "--porcelain"], cwd);
}
async function remoteGitBranch(cwd) {
  const out = await runGit(["-C", cwd, "branch", "--show-current"], cwd);
  return out.trim() || null;
}
async function remoteGitLog(cwd, { n = 10, oneline = true } = {}) {
  const args = ["-C", cwd, "log", `--max-count=${n}`];
  if (oneline) args.push("--oneline");
  return runGit(args, cwd);
}

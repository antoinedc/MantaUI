// cto.mjs — the "On-call CTO" read gateway (BET-1164, issue 1/3).
//
// The durable server foundation for the on-call CTO feature: a registry of
// deterministic READ-ONLY tools (what's running, transcripts, git, usage,
// plan mode, config) exposed through a single
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
//     the git helpers, now). Tests inject fakes; index.mjs
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
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { describeModel } from "../shared/modelGuide.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";
import {
  rollupsStore,
  ledgerStore,
  ROLLUP_LEVELS,
  inboxStore,
  INBOX_KINDS,
  inboxExpiresAt,
  purgeExpiredInbox,
  patchStore,
} from "./ctoStores.mjs";
import { makeWatcher as buildWatcher, validatePredicate } from "./ctoWatchers.mjs";

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
    isPlanAgent = (name) => name === "plan" || name === "manta-plan",
    // BET-1398 standing-query watchers (supersedes the cto.json poller). Empty
    // default keeps the read gateway resolving standalone; index.mjs wires this
    // to the adaptive engine's event-driven `watchers`.
    watchers = null,
    // BET-1399 (§4.5): the remaining read verbs — the adaptive engine's
    // drill-down renderers. Null defaults keep standalone tests honest (the
    // tools report "not wired" rather than pretending to read nothing).
    readFacts = null,
    readProfile = null,
    readToolRegistry = null,
    loadInbox = async () => inboxStore.load(),
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

  // BET-1398: resolve the standing-query watcher registry. The adaptive
  // engine's persistent, event-driven engine is preferred; standalone, fall
  // back to a self-contained in-memory registry so the read gateway keeps
  // resolving (e.g. in isolation tests).
  let memWatcherStore = null;
  function resolveWatchers() {
    if (watchers) return watchers;
    if (!memWatcherStore) memWatcherStore = [];
    return {
      register: async (input) => {
        const built = buildWatcher({ ...input, now });
        if (!built.ok) return { ok: false, error: built.error };
        memWatcherStore.push(built.watch);
        return { ok: true, data: { watch: built.watch } };
      },
      unregister: async (id) => {
        const i = memWatcherStore.findIndex((w) => w && w.id === id);
        if (i === -1) return { ok: true, data: { removed: false } };
        memWatcherStore.splice(i, 1);
        return { ok: true, data: { removed: true } };
      },
      list: async () => memWatcherStore,
    };
  }

  // Best-effort branch resolver: one git call per distinct directory, cached.
  // Shared by list_sessions / list_projects so the per-project git state is
  // computed once, never per window.
  function makeBranchResolver() {
    const cache = new Map();
    return async function branchFor(dir) {
      if (!dir) return null;
      if (!cache.has(dir)) {
        let branch = null;
        try {
          branch = (await gitBranch(dir)) ?? null;
        } catch {
          branch = null;
        }
        cache.set(dir, branch);
      }
      return cache.get(dir);
    };
  }

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
    const branchFor = makeBranchResolver();
    return Promise.all(
      projects.map(async (p) => ({
        tmuxSession: p?.tmuxSession,
        defaultCwd: p?.defaultCwd,
        branch: await branchFor(p?.defaultCwd),
        windows: await Promise.all(
          (p?.windows ?? []).map(async (w) => ({
            index: w?.index,
            name: w?.name,
            active: !!w?.active,
            chat: typeof w?.opencodeSessionId === "string" && !!w?.opencodeSessionId,
            sessionID: w?.opencodeSessionId ?? null,
            model: w?.opencodeSessionId ? (info.get(w.opencodeSessionId)?.model ?? null) : null,
            branch: w?.opencodeSessionId ? await branchFor(w?.paneCurrentPath || p?.defaultCwd) : await branchFor(p?.defaultCwd),
          })),
        ),
      })),
    );
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
      const branchFor = makeBranchResolver();

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
            branch: await branchFor(info_.directory ?? w?.paneCurrentPath ?? p?.defaultCwd),
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
    name: "read_rollups",
    description:
      "Read the Adaptive CTO's stored work rollups (spec §5.2/§13.1, the P1 evidence " +
      "slice the digest engine summarizes). Read-only. Returns up to a handful of " +
      "rollups at a given level (hour/day/week) whose window overlaps [start, end], " +
      "each with id, window and its bullets (truncated). Defaults to recent day " +
      "rollups.",
    params: {
      level: "day",
      start: null,
      end: null,
    },
    run: async (ctx, args) => {
      const level = ROLLUP_LEVELS.includes(args?.level) ? args.level : "day";
      const from = typeof args?.start === "number" ? args.start : 0;
      const to = typeof args?.end === "number" ? args.end : Date.now();
      const dir = rollupsStore.dirFor(level);
      let names = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        names = [];
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        let r;
        try {
          r = await rollupsStore.load(level, id);
        } catch {
          continue;
        }
        if (!r || !Array.isArray(r?.window) || r.window[1] < from || r.window[0] > to) continue;
        out.push({
          id,
          level,
          window: r.window,
          project: r.project ?? null,
          bullets: (Array.isArray(r.bullets) ? r.bullets : []).slice(0, 5).map((b) => ({
            text: String(b?.text ?? "").slice(0, 160),
            refs: Array.isArray(b?.refs) ? b.refs.slice(0, 8) : [],
          })),
        });
        if (out.length >= 8) break;
      }
      out.sort((a, b) => a.window[0] - b.window[0]);
      return { ok: true, data: { level, rollups: out } };
    },
  });

  register({
    name: "read_ledger",
    description:
      "Read the Adaptive CTO's append-only ledger (spec §13.1) — the raw evidence + " +
      "instrumentation rows the engine writes. Read-only. Returns the most recent " +
      "`limit` (default 50) rows, optionally filtered to `kind` (e.g. " +
      "cto.digest_generated, cto.digest_opened, cto.segment_*).",
    params: {
      limit: 50,
      kind: null,
    },
    run: async (ctx, args) => {
      const rows = await ledgerStore.read();
      const limit = Math.max(1, Math.min(500, Number(args?.limit) || 50));
      const kind = typeof args?.kind === "string" && args.kind ? args.kind : null;
      const filtered = kind ? rows.filter((r) => r?.kind === kind) : rows;
      const tail = filtered.slice(-limit);
      const shown = tail.map((r) => ({
        ts: r?.ts ?? null,
        kind: r?.kind ?? null,
        ...(r?.id !== undefined ? { id: r.id } : {}),
        ...(r?.granularity !== undefined ? { granularity: r.granularity } : {}),
        ...(r?.message !== undefined ? { message: String(r.message).slice(0, 160) } : {}),
        ...(r?.project !== undefined ? { project: r.project } : {}),
        ...(r?.item !== undefined ? { item: r.item } : {}),
      }));
      return { ok: true, data: { count: filtered.length, rows: shown } };
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
    name: "read_facts",
    description:
      "Read the Adaptive CTO's Blackboard facts for one project (spec §4.5/§6, BET-1399). " +
      "Read-only. Returns the project's active facts (id, kind, statement, refs, " +
      "confidence, sender, age) plus the superseded chain shown struck-through. " +
      "`asOf` (unix ms) reconstructs the live set at that time by walking the " +
      "supersession chain (bi-temporal read). Omitting `project` lists the " +
      "known projects (discovery read).",
    params: { project: null, asOf: null },
    run: async (ctx, args) => {
      if (typeof readFacts !== "function") return { ok: false, error: "read_facts is not wired" };
      const asOf = typeof args?.asOf === "number" && Number.isFinite(args.asOf) && args.asOf > 0 ? args.asOf : null;
      const project = typeof args?.project === "string" && args.project ? args.project : null;
      try {
        const view = await readFacts({ project, asOfMs: asOf });
        return {
          ok: true,
          data: {
            projects: view?.projects ?? [],
            project: view?.project ?? null,
            asOf: view?.asOf ?? null,
            active: view?.active ?? [],
            superseded: view?.superseded ?? [],
          },
        };
      } catch (e) {
        return { ok: false, error: `facts read failed: ${e?.message ?? e}` };
      }
    },
  });

  register({
    name: "read_profile",
    description:
      "Read the Adaptive CTO's editable user profile (spec §4.5/§8, BET-1394). " +
      "Read-only. Returns the per-dimension profile — stated values and inferences " +
      "with statements, refs and confidence — as the drill-down render model.",
    params: {},
    run: async () => {
      if (typeof readProfile !== "function") return { ok: false, error: "read_profile is not wired" };
      try {
        return { ok: true, data: await readProfile() };
      } catch (e) {
        return { ok: false, error: `profile read failed: ${e?.message ?? e}` };
      }
    },
  });

  register({
    name: "read_toolregistry",
    description:
      "Read the Adaptive CTO's external-tool registry (spec §4.5/§7, BET-1399). " +
      "Read-only. Per tool: lifecycle status, the §7.2 engagement + vitality axes, " +
      "the derived §7.3 quadrant role (both / workflow / data-source / dead), the " +
      "§7.4 consent rings, and the §7.5 probe cadence + last result; plus the " +
      "never list (and what un-nevering would do).",
    params: {},
    run: async () => {
      if (typeof readToolRegistry !== "function") return { ok: false, error: "read_toolregistry is not wired" };
      try {
        return { ok: true, data: await readToolRegistry() };
      } catch (e) {
        return { ok: false, error: `tool registry read failed: ${e?.message ?? e}` };
      }
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
  // Watchers (BET-1398) — watch / unwatch / list_watches
  // -------------------------------------------------------------------------
  // A watch registers a STANDING QUERY evaluated over the CTO's evidence
  // stream (spec §4.3/§13.4): an event-driven predicate, not a surface poll.
  // `watch` takes a predicate `{kind, params}` — kind ∈ {event-pattern,
  // rate-threshold, usage-burn} — via flat args below. `watch` is a
  // CONFIRM-mode tool: registering a recurring probe is a side effect, so it
  // needs the user's go-ahead (see the gate dispatch below).
  register({
    name: "watch",
    description:
      "Register a standing-query watcher evaluated over the CTO's evidence stream. " +
      "The wire runs the three predicate kinds (closed set): event-pattern (a regex " +
      "matched against evidence text/kind), rate-threshold (count of matching events " +
      "in a window >= threshold), or usage-burn (ambient spend pace vs the daily cap " +
      "fraction). A matching evidence event becomes a high-salience watcher hit that " +
      "feeds the suggestion engine. NOTE: this is a confirm-mode action — it registers " +
      "a recurring probe, so it needs your go-ahead before it takes effect.",
    params: {
      kind: {
        type: "string",
        description: "Predicate kind: event-pattern | rate-threshold | usage-burn.",
      },
      pattern: { type: "string", description: "Regex (event-pattern, or a rate-threshold filter)." },
      eventKind: { type: "string", description: "Limit matches to this evidence kind (optional)." },
      threshold: { type: "number", description: "Count to trigger (rate-threshold)." },
      windowMs: { type: "number", description: "Window ms (rate-threshold / usage-burn)." },
      capFraction: { type: "number", description: "Daily-cap fraction (usage-burn)." },
    },
    mode: "confirm",
    run: async (ctx, args) => {
      const predicate = {
        kind: String(args?.kind ?? "").trim(),
        params: {
          ...(args?.pattern != null ? { pattern: String(args.pattern) } : {}),
          ...(args?.eventKind != null ? { eventKind: String(args.eventKind) } : {}),
          ...(args?.threshold != null ? { threshold: args.threshold } : {}),
          ...(args?.windowMs != null ? { windowMs: args.windowMs } : {}),
          ...(args?.capFraction != null ? { capFraction: args.capFraction } : {}),
        },
      };
      const v = validatePredicate(predicate);
      if (!v.ok) return { ok: false, error: v.error };
      const res = await resolveWatchers().register({ predicate, source: "user" });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { watch: res.data.watch } };
    },
  });

  register({
    name: "unwatch",
    description: "Remove a watcher by its id (from list_watches). Read what is registered," +
      " then stop the probe.",
    params: { id: { type: "string", description: "The watcher id to remove." } },
    run: async (ctx, args) => {
      const id = String(args?.id ?? "");
      const res = await resolveWatchers().unregister(id);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, data: { removed: res.data.removed } };
    },
  });

  register({
    name: "list_watches",
    description: "List every registered watcher: id, predicate kind, pattern signature," +
      " source, created, lastHit and hit count. Read-only.",
    params: {},
    run: async () => {
      const watchList = await resolveWatchers().list();
      return { ok: true, data: { watches: Array.isArray(watchList) ? watchList : [] } };
    },
  });

  register({
    name: "read_inbox",
    description: "Read the on-call CTO inbox (spec §4.4) — the durable queue of notes any " +
      "session sent via send_to_cto. Returns each note's kind (fyi|finding|blocker|" +
      "handoff|anomaly), message, tag, refs, sender, ts, read state, and count. " +
      "READ-ONLY: it does not mark notes read (the engine drain does at breakpoints) " +
      "and it never writes. Optionally filter by kind, read state, or tag. " +
      "An expired note is absent from the view.",
    params: {
      kind: { type: "string", description: "Only notes of this kind (fyi|finding|blocker|handoff|anomaly)." },
      read: { type: "boolean", description: "Only notes with this read state (true/false)." },
      tag: { type: "string", description: "Only notes carrying this dedupe tag." },
    },
    run: async (ctx, args) => {
      let data;
      try {
        data = await loadInbox();
      } catch {
        data = {};
      }
      let entries = Array.isArray(data?.entries) ? data.entries : [];
      const { keep } = purgeExpiredInbox(entries, { nowMs: now() });
      entries = keep;
      if (args && typeof args.kind === "string" && args.kind) {
        entries = entries.filter((e) => e?.kind === args.kind);
      }
      if (args && typeof args.read === "boolean") {
        entries = entries.filter((e) => e?.read === args.read);
      }
      if (args && typeof args.tag === "string" && args.tag) {
        entries = entries.filter((e) => e?.tag === args.tag);
      }
      return { ok: true, data: { entries } };
    },
  });

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------
  const byName = new Map(tools.map((t) => [t.name, t]));

  // The in-conversation confirmation loop (Issue 2's gate wiring). A confirm-
  // mode tool that is not in `trustedActions` (and not already approved)
  // returns `{ needConfirmation: true, id, preview }` WITHOUT running. The
  // caller surfaces "I need your go-ahead: <preview>"; approval or rejection
  // flows through approveConfirm(id) / rejectConfirm(id), and the re-dispatch
  // runs. Issue 3 gates that approval on the user's own spoken words.
  const pendingConfirms = new Map(); // id -> { tool, args, approved }

  async function dispatch(name, args, ctx = {}) {
    const def = byName.get(String(name ?? ""));
    if (!def) {
      return { ok: false, error: `unknown cto tool: ${name} (known: ${tools.map((t) => t.name).join(", ")})` };
    }
    // The tool's declared `mode` is the source of truth for confirmation:
    //   - `auto` tools (every read) never confirm — only deny policy applies,
    //     and a caller-supplied "confirm" gate is ignored (registry mode wins).
    //   - `confirm` tools pause for the user's go-ahead unless trusted or
    //     already approved.
    // So a caller can no longer manufacture a confirm for a read by passing a
    // hardcoded confirm gate; the seam stays for deny/allow policy only.
    const gate = typeof ctx?.gate === "function" ? ctx.gate : DEFAULT_GATE;

    if (def.mode === "confirm") {
      let decision;
      try {
        decision = gate(def.name, args ?? {});
      } catch {
        decision = "deny";
      }
      if (decision === "deny") {
        return { ok: false, error: `tool ${def.name} denied` };
      }
      // A trusted action runs without asking; anything else pauses for the
      // user's go-ahead (returns needConfirmation and does NOT act yet).
      const trusted = Array.isArray(ctx?.trustedActions) ? ctx.trustedActions : [];
      if (!trusted.includes(def.name)) {
        const id = computeConfirmId(def.name, args ?? {});
        const prior = pendingConfirms.get(id);
        if (prior?.approved) {
          // The user said "go ahead" → this exact (tool, args) is authorized;
          // consume the approval and run.
          pendingConfirms.delete(id);
        } else {
          if (!prior) pendingConfirms.set(id, { tool: def.name, args: args ?? {}, approved: false });
          return {
            ok: true,
            needConfirmation: true,
            id,
            tool: def.name,
            preview: buildPreview(def, args ?? {}),
          };
        }
      }
    } else {
      // Auto tool: confirmation never applies. Only deny policy is consulted;
      // a "confirm" decision is coerced to allow.
      let decision;
      try {
        decision = gate(def.name, args ?? {});
      } catch {
        decision = "deny";
      }
      if (decision === "deny") {
        return { ok: false, error: `tool ${def.name} denied` };
      }
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
    // In-conversation gate loop (Issue 2): the cto text agent surfaces a
    // needConfirmation preview; the user's "go ahead"/"no" drives these.
    approveConfirm: (id) => {
      const p = pendingConfirms.get(id);
      if (!p) return false;
      p.approved = true;
      pendingConfirms.set(id, p);
      return true;
    },
    rejectConfirm: (id) => pendingConfirms.delete(id),
    listPendingConfirms: () =>
      [...pendingConfirms.entries()].map(([id, p]) => ({ id, tool: p.tool, approved: p.approved })),
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

// ---------------------------------------------------------------------------
// Inbound funnel (superseded by BET-1397) — createCtoInbound
// ---------------------------------------------------------------------------
// The single place a CTO-bound event enters the box. Producers (the
// send_to_cto tool, the watcher poller, a scheduled prompt, a webhook) all
// call `inbound({ surface, payload, seenId })`. Live vs parked is decided by
// the server-side "call active" flag (Issue 3 sets it; this issue it is
// always false, so every event takes the parked route). Parked events are
// de-duped by seenId, persisted to the inbox.json store (spec §4.4), and only
// a `blocker` kind additionally enters the A8 card path (which fires the ONE
// blocking-tier notification through the existing router). The old direct
// blanket-notify branch is deleted — non-blocker notes are silent.
export function createCtoInbound({
  seenFilter = createSeenIdFilter(),
  isCallActive = () => false,
  ctoSessionID = null,
  sendPrompt = async () => {},
  // Legacy load/save seam (tests inject it). Left undefined by default —
  // see inboxPatch below.
  loadInbox,
  saveInbox,
  // BET-1492: the append runs as a patchStore section. Default: the REAL
  // inbox store — its path-keyed mutex is the one every inbox writer (the
  // engine drain, the retention sweep, concurrent appends) serializes on.
  // A caller injecting the legacy load/save pair gets an adapter built ONCE
  // per factory (stable object identity → stable mutex); it cannot share the
  // path mutex, but the injected pair IS the whole store world in those
  // (test) callers.
  patchInbox = null,
  registerBlocker = async () => {},
  now = () => Date.now(),
} = {}) {
  const legacySeam =
    loadInbox !== undefined || saveInbox !== undefined
      ? {
          load: loadInbox ?? (async () => inboxStore.load()),
          save: saveInbox ?? (async (data) => inboxStore.save(data)),
        }
      : null;
  // legacySeam is a FACTORY-SCOPE object: lockForStore falls back to object
  // identity for path-less stores, so a per-call literal would mean a fresh
  // mutex per call and concurrent appends through the injected pair would
  // stay unserialized (review Block, BET-1492 attempt 2).
  const inboxPatch =
    patchInbox ??
    (legacySeam ? (mutation) => patchStore(legacySeam, mutation) : (mutation) => patchStore(inboxStore, mutation));
  async function inbound({ surface = "session", payload = {}, seenId } = {}) {
    // De-dupe: an event whose seenId was already handled is a re-delivery
    // (the same opencode event arrives on multiple streams; a watcher may
    // re-poll). An event with no seenId is never swallowed.
    if (typeof seenId === "string" && seenId && seenFilter.seen(seenId)) {
      return { ok: true, deduped: true };
    }
    if (isCallActive()) {
      // LIVE route (stub — Issue 3 sets the "call active" flag and injects
      // the event as a turn into the CTO session). Until then this never runs.
      if (sendPrompt && ctoSessionID && typeof payload?.message === "string" && payload.message) {
        await sendPrompt({ sessionId: ctoSessionID, text: payload.message }).catch((e) =>
          console.warn("[cto] live inject failed:", e?.message ?? e),
        );
      }
      return { ok: true, live: true };
    }
    // PARKED route: write the inbox store. A bare {message} maps to the
    // `blocker` default (§4.4) — the current urgent semantics preserved.
    const kind = normalizeInboxKind(payload?.kind);
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message) {
      // Nothing meaningful to persist — resolve without writing or notifying.
      return { ok: true, parked: true, dropped: true };
    }
    const ts = now();
    const tag = typeof payload?.tag === "string" && payload.tag ? payload.tag : null;
    const sender = {
      sessionID: typeof payload?.sessionID === "string" && payload.sessionID ? payload.sessionID : null,
      name: typeof payload?.senderName === "string" && payload.senderName ? payload.senderName : null,
    };
    const entry = {
      id: tag ? stableHash(`tag:${tag}`) : stableHash(randomBytes(16).toString("hex")),
      kind,
      message,
      refs: Array.isArray(payload?.refs) ? payload.refs.filter((r) => typeof r === "string") : [],
      tag,
      sender,
      title: typeof payload?.title === "string" && payload.title ? payload.title : undefined,
      // BET-1516 (§10.3 predicate 2): the note may NAME a checkable condition
      // ("when the plan or note names one") — carried to the ask/card so the
      // §6.7 surface verify can auto-retract the blocker when it goes gone.
      condition: typeof payload?.condition === "string" && payload.condition ? payload.condition : undefined,
      ts,
      read: false,
      count: 1,
      expires: inboxExpiresAt(kind, ts, { now }),
    };

    // BET-1492: load-fresh → purge expired → dedupe by tag (coalesce) else
    // append → save, all inside ONE patchStore section under the inbox
    // store's mutex. The old unlocked load-spread-save (`saveInbox({
    // ...data, entries })`) could revert a note another writer (the drain's
    // mark-read, the retention sweep, a concurrent send_to_cto) committed
    // between the load and the save.
    let coalesced = false;
    let effective = entry;
    try {
      await inboxPatch((fresh) => {
        let entries = Array.isArray(fresh?.entries) ? fresh.entries : [];
        const { keep } = purgeExpiredInbox(entries, { nowMs: ts });
        entries = keep;
        if (tag) {
          const idx = entries.findIndex((e) => e?.tag === tag);
          if (idx >= 0) {
            entries[idx] = coalesceInboxEntry(entries[idx], entry, ts);
            coalesced = true;
          } else {
            entries.push(entry);
          }
        } else {
          entries.push(entry);
        }
        effective = coalesced ? entries.find((e) => e?.tag === tag) : entry;
        return { entries };
      });
    } catch (e) {
      console.warn("[cto] inbox save failed:", e?.message ?? e);
    }

    // blocker → the A8 card path (source 3), which fires the single
    // blocking-tier notification through the existing router. Other kinds are
    // silent — they surface later only via read_inbox / the engine drain.
    if (kind === "blocker") {
      try {
        await registerBlocker(effective);
      } catch (e) {
        console.warn("[cto] inbox blocker card failed:", e?.message ?? e);
      }
    }
    return { ok: true, parked: true, kind, tag, coalesced, entryId: effective.id };
  }
  return { inbound };
}

// Map a supplied kind to a valid inbox kind; anything unrecognised (or a bare
// {message}) is the `blocker` default — the prior urgent semantics, preserved.
export function normalizeInboxKind(kind) {
  return typeof kind === "string" && INBOX_KINDS.includes(kind) ? kind : "blocker";
}

// Coalesce a re-tagged note into its existing entry (spec §4.4): refs union,
// timestamp refreshed, count incremented; the merged note is unread until
// drained.
export function coalesceInboxEntry(existing, incoming, ts) {
  const refs = Array.from(new Set([...(existing?.refs ?? []), ...(incoming?.refs ?? [])]));
  return {
    ...existing,
    ...incoming,
    refs,
    ts,
    count: (typeof existing?.count === "number" ? existing.count : 1) + 1,
    read: false,
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Pure helpers (injectable wires, unit-tested)
// ---------------------------------------------------------------------------

// Stable short hash of a string (used for confirm ids).
export function stableHash(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Deterministic id for a pending confirmation of a (tool, args) pair, so the
// user's "go ahead" re-dispatch of the SAME tool+args resolves to the pending
// record.
export function computeConfirmId(toolName, args) {
  return stableHash(`${toolName}:${JSON.stringify(args ?? {})}`);
}

// A short human summary of a tool call for the "I need your go-ahead: …"
// surface. Used in the needConfirmation preview.
export function buildPreview(def, args) {
  const header = [def?.name ?? "?"];
  if (args && typeof args === "object") {
    const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (entries.length) {
      header.push(entries.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", "));
    }
  }
  const firstLine = (String(def?.description ?? "").split("\n")[0] ?? "").slice(0, 120);
  if (firstLine) header.push(`— ${firstLine}`);
  return header.join(" ");
}



// Agents, Phase 1 — named agents you can @mention and talk to.
// Spec: docs/superpowers/specs/2026-11-22-agents-phase1.md.
//
// An agent is a folder of plain Markdown under ~/.manta/agents/<slug>/ (agent.md + optional skills/ and seats/).
// Each valid one is compiled into an OpenCode agent block `agent-<slug>` through the single config writer
// (providers.editConfig), so it applies live. A task for an agent is a background job (delegate.startJob) running
// that opencode agent; the direct chat is an ordinary chat-mode window in the `manta-agents` tmux session.
//
// Dependency-injected like routines.mjs: tests drive it with fakes and a temp root, never the real ~/.manta,
// opencode or tmux.

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import fsPromises from "node:fs/promises";
import YAML from "yaml";
import { statePath } from "../shared/paths.mjs";
import { AGENT_PACKAGE_PREFIX } from "../shared/subagentSync.mjs";
import { createMutex } from "./jsonStore.mjs";

export const AGENTS_TMUX_SESSION = "manta-agents";
export const SLUG_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const RESERVED_SLUGS = ["build", "plan", "general", "explore", "compaction", "title", "summary", "cto", "manta-plan"];
export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 200;
export const EXCERPT_MESSAGES = 10;
export const EXCERPT_MAX_CHARS = 6000;
const ISOLATIONS = ["worktree", "none"];
const EXCERPT_FETCH = 60; // messages read to find EXCERPT_MESSAGES with text in them

const COMPILED_FILE = ".compiled.md";
const INSTALLED_FILE = ".installed.json";
const CHAT_FILE = ".chat.json";

/** A refusal whose message is a sentence meant for the person at the screen (HTTP 400 on /rpc). */
export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentError";
    this.rpcStatus = 400;
  }
}

export const agentKey = (slug) => `${AGENT_PACKAGE_PREFIX}${slug}`;
export const isUsableSlug = (slug) => typeof slug === "string" && SLUG_RE.test(slug) && !RESERVED_SLUGS.includes(slug);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Split `---` frontmatter from the Markdown body. Returns `{ yaml, body }` or null when there is none. */
export function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(String(text ?? "").replace(/^\uFEFF/, ""));
  return m ? { yaml: m[1], body: (m[2] ?? "").trim() } : null;
}

/**
 * Parse an `agent.md`. `{ ok:true, meta, body }` or `{ ok:false, error }` (a human sentence). Never throws.
 * meta: `{ name, description, isolation, model|null, color|null }`.
 */
export function parseAgentMd(text) {
  const parts = splitFrontmatter(text);
  if (!parts) return { ok: false, error: "agent.md must start with a --- frontmatter block" };
  let data;
  try {
    data = YAML.parse(parts.yaml);
  } catch (e) {
    return { ok: false, error: `agent.md frontmatter is not valid YAML: ${String(e?.message ?? e).split("\n")[0]}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "agent.md frontmatter must be a set of key: value lines" };
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const name = str(data.name);
  if (!name) return { ok: false, error: "agent.md needs a name" };
  if (name.length > NAME_MAX) return { ok: false, error: `The name is longer than ${NAME_MAX} characters` };
  const description = str(data.description);
  if (!description) return { ok: false, error: "agent.md needs a description" };
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `The description is longer than ${DESCRIPTION_MAX} characters` };
  const isolation = data.isolation == null ? "none" : str(data.isolation);
  if (!ISOLATIONS.includes(isolation)) return { ok: false, error: 'isolation must be "worktree" or "none"' };
  const model = data.model == null ? null : str(data.model);
  if (model !== null && !/^[^/\s]+\/\S+$/.test(model)) return { ok: false, error: 'model must look like "provider/model"' };
  const color = data.color == null ? null : str(data.color) || null;
  return { ok: true, meta: { name, description, isolation, model, color }, body: parts.body };
}

/** The `agent.md` text for a freshly created agent. */
export function buildAgentMd({ name, description, isolation }) {
  const front = YAML.stringify({ name, description, isolation }, { lineWidth: 0 }).trimEnd();
  const edits = isolation === "worktree";
  const body =
    `You are ${name}. ${description}\n\n` +
    "Do the task you are given carefully and end to end. Read what you need before you act, keep the work focused on " +
    "what was asked, and say plainly what you did, what you found and anything you are unsure about. " +
    (edits
      ? "You work in your own branch: commit as you go, and never merge."
      : "You can read and search but you cannot change files; give your answer in your final message.");
  return `---\n${front}\n---\n${body}\n`;
}

/** A folder name for an agent called `name`, free among `taken` (a Set). Throws a sentence for a reserved one. */
export function slugForName(name, taken = new Set()) {
  let base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "agent";
  if (!/^[a-z]/.test(base)) base = `a-${base}`;
  base = base.slice(0, 31).replace(/-+$/, "");
  if (RESERVED_SLUGS.includes(base)) throw new AgentError(`"${base}" is a reserved name — pick another`);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, 31 - suffix.length).replace(/-+$/, "")}${suffix}`;
  }
  return slug;
}

/** `.compiled.md`: the role prompt plus, when there are skills, an index the agent reads through the read tool. */
export function compileAgentPrompt({ body, skills = [] }) {
  let out = String(body ?? "").trim();
  if (skills.length > 0) {
    const lines = skills.map((s) => `- **${s.name}**${s.description ? ` — ${s.description}` : ""}\n  File: ${s.path}`);
    out += `\n\n## Your skills\n\nRead a skill's file before doing work it covers.\n\n${lines.join("\n")}`;
  }
  return `${out}\n`;
}

/** The OpenCode agent block of an agent package. */
export function buildAgentBlock({ dir, meta }) {
  return {
    mode: "all",
    description: meta.description,
    prompt: `{file:${join(dir, COMPILED_FILE)}}`,
    ...(meta.model ? { model: meta.model } : {}),
    permission: { external_directory: { [`${dir}/**`]: "allow" } },
  };
}

// JSON with sorted keys, so two blocks compare equal whatever order a file kept them in.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The first `n` words of a request, minus the @mention of the agent itself. */
export function requestTitle(text, slug) {
  const stripped = String(text ?? "").replace(new RegExp(`@${slug}(?![a-z0-9-])`, "gi"), " ").trim();
  return (stripped || String(text ?? "").trim()).split(/\s+/).slice(0, 6).join(" ");
}

function messageText(m) {
  const parts = Array.isArray(m?.parts) ? m.parts : [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The "Recent conversation" excerpt: the last EXCERPT_MESSAGES user/assistant messages that have text, oldest first,
 * at most EXCERPT_MAX_CHARS in total (older ones are dropped first). "" when there is nothing.
 */
export function buildConversationExcerpt(messages, { maxMessages = EXCERPT_MESSAGES, maxChars = EXCERPT_MAX_CHARS } = {}) {
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(m);
    if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const picked = [];
  let used = 0;
  for (const line of lines.slice(-maxMessages).reverse()) {
    const cost = line.length + (picked.length > 0 ? 2 : 0);
    if (used + cost > maxChars) {
      if (picked.length === 0) picked.push(line.slice(line.length - maxChars));
      break;
    }
    picked.push(line);
    used += cost;
  }
  return picked.reverse().join("\n\n");
}

/** The opening prompt of an agent task: the request, then the project brief (if any), then the recent conversation. */
export function buildDispatchPrompt({ text, seat = "", excerpt = "" }) {
  let out = String(text ?? "").trim();
  if (seat) out += `\n\n---\nYour brief for this project:\n${seat}`;
  if (excerpt) out += `\n\n---\nRecent conversation in the chat that asked you (oldest first), for context:\n${excerpt}`;
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const defaultTemplatesDir = () => fileURLToPath(new URL("./agentTemplates", import.meta.url));

async function exists(fs, path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(fs, path) {
  try {
    return await fs.readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonOptional(fs, path) {
  const text = await readOptional(fs, path);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {string} [deps.root]          ~/.manta/agents
 * @param {string} [deps.templatesDir]  the built-in agent folders shipped in the repo
 * @param {object} [deps.fs]            node:fs/promises
 * @param {(edits:any)=>Promise<{ok:boolean,changed?:boolean,error?:string}>} deps.editConfig  providers.editConfig
 * @param {()=>Promise<{ok:boolean,error?:string}>} deps.reload  reloadOpencodeConfig
 * @param {object} deps.oc              { listMessages, createSession, sessionExists? }
 * @param {object} deps.delegate        { startJob }
 * @param {object} deps.tmux            { listProjects, newWindow, newSession }
 * @param {object} [deps.registry]      { identify(directory) → { slug } | null }
 * @param {object} [deps.delegateView]  { assertWritable(sessionId) }
 * @param {(sessionId:string)=>Promise<boolean>} [deps.isCtoSession]
 * @param {object} [deps.syncState]     { refreshNow() }
 */
export function createAgentsEngine({
  root = statePath("agents"),
  templatesDir = defaultTemplatesDir(),
  fs = fsPromises,
  editConfig,
  reload,
  oc,
  delegate,
  tmux,
  registry = null,
  delegateView = null,
  isCtoSession = null,
  syncState = null,
  log = console,
} = {}) {
  const syncLock = createMutex();
  const chatLock = createMutex();
  let lastStamp = null;

  async function builtInSlugs() {
    try {
      const entries = await fs.readdir(templatesDir, { withFileTypes: true });
      return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      return new Set();
    }
  }

  async function skillsOf(dir) {
    const out = [];
    let names = [];
    try {
      names = (await fs.readdir(join(dir, "skills"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return { skills: out, stamp: "" };
    }
    let stamp = "";
    for (const dirName of names) {
      const file = join(dir, "skills", dirName, "SKILL.md");
      let text;
      let mtime;
      try {
        [text, mtime] = [await fs.readFile(file, "utf-8"), (await fs.stat(file)).mtimeMs];
      } catch {
        continue;
      }
      stamp += `|${file}:${mtime}`;
      let name = dirName;
      let description = "";
      const front = splitFrontmatter(text);
      if (front) {
        try {
          const data = YAML.parse(front.yaml);
          if (typeof data?.name === "string" && data.name.trim()) name = data.name.trim();
          if (typeof data?.description === "string") description = data.description.trim().replace(/\s+/g, " ");
        } catch {
          /* a skill with broken frontmatter keeps its folder name */
        }
      }
      out.push({ name, description, path: file });
    }
    return { skills: out, stamp };
  }

  /** Every agent folder under the root, valid or not, plus a stamp that changes when an agent file changes. */
  async function scan() {
    let dirs = [];
    try {
      dirs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
    } catch {
      return { entries: [], stamp: "" };
    }
    const builtIns = await builtInSlugs();
    const entries = [];
    let stamp = "";
    for (const slug of dirs) {
      if (!isUsableSlug(slug)) continue; // reserved / not a valid folder name: skipped, never listed
      const dir = join(root, slug);
      const file = join(dir, "agent.md");
      const info = { slug, name: slug, description: "", isolation: "none", model: null, color: null, builtIn: builtIns.has(slug) };
      const text = await readOptional(fs, file);
      let mtime = 0;
      try {
        mtime = (await fs.stat(file)).mtimeMs;
      } catch {
        /* missing */
      }
      stamp += `${slug}:${mtime}`;
      if (text == null) {
        entries.push({ slug, dir, info: { ...info, error: "agent.md is missing" } });
        continue;
      }
      const parsed = parseAgentMd(text);
      if (!parsed.ok) {
        entries.push({ slug, dir, info: { ...info, error: parsed.error } });
        continue;
      }
      const { skills, stamp: skillStamp } = await skillsOf(dir);
      stamp += skillStamp;
      entries.push({ slug, dir, meta: parsed.meta, body: parsed.body, skills, info: { ...info, ...parsed.meta } });
    }
    return { entries, stamp };
  }

  /** Compile every valid agent into `.compiled.md` and the OpenCode config. Throws a sentence on failure. */
  function sync() {
    return syncLock.runExclusive(async () => {
      const { entries, stamp } = await scan();
      const valid = entries.filter((e) => !e.info.error);
      let compiledChanged = false;
      for (const e of valid) {
        const compiled = compileAgentPrompt({ body: e.body, skills: e.skills });
        const file = join(e.dir, COMPILED_FILE);
        if ((await readOptional(fs, file)) !== compiled) {
          await fs.writeFile(file, compiled, "utf-8");
          compiledChanged = true;
        }
      }
      const desired = new Map(valid.map((e) => [agentKey(e.slug), buildAgentBlock({ dir: e.dir, meta: e.meta })]));
      const installedDoc = await readJsonOptional(fs, join(root, INSTALLED_FILE));
      const installed = Array.isArray(installedDoc) ? installedDoc.filter((k) => typeof k === "string" && k.startsWith(AGENT_PACKAGE_PREFIX)) : [];

      const r = await editConfig((cfg) => {
        const edits = [];
        for (const [key, block] of desired) {
          const existing = cfg?.agent?.[key];
          if (existing === undefined || canon(existing) !== canon(block)) edits.push({ path: ["agent", key], value: block });
        }
        // only what Manta installed earlier and whose package is gone — never someone else's block
        for (const key of installed) {
          if (!desired.has(key) && cfg?.agent?.[key] !== undefined) edits.push({ path: ["agent", key], value: undefined });
        }
        return edits;
      });
      if (!r.ok) throw new AgentError(`Couldn't update the agents in OpenCode: ${r.error ?? "unknown error"}`);
      // The prompt file's path never changes, so an edited prompt alone leaves the config untouched and would never
      // be reloaded by the writer.
      if (!r.changed && compiledChanged) {
        const rr = await reload();
        if (!rr?.ok) throw new AgentError(`Couldn't reload OpenCode after an agent changed: ${rr?.error ?? "unknown error"}`);
      }
      const next = [...desired.keys()];
      if (canon([...installed].sort()) !== canon([...next].sort()) || installedDoc === null) {
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(join(root, INSTALLED_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
      }
      lastStamp = stamp;
      return { entries };
    });
  }

  /** Copy the built-in agents that this box does not have yet. Never overwrites a folder (user edits win). */
  async function installBuiltIns() {
    await fs.mkdir(root, { recursive: true });
    const installed = [];
    for (const slug of await builtInSlugs()) {
      const target = join(root, slug);
      if (await exists(fs, target)) continue;
      await fs.cp(join(templatesDir, slug), target, { recursive: true });
      await fs.mkdir(join(target, "home"), { recursive: true });
      installed.push(slug);
    }
    return installed;
  }

  /** Boot: install the built-ins, then the first sync. Throws on failure (the caller logs; the box still starts). */
  async function init() {
    const installed = await installBuiltIns();
    await sync();
    return { installed };
  }

  async function list() {
    const { entries, stamp } = await scan();
    if (stamp !== lastStamp) {
      try {
        await sync();
      } catch (e) {
        // the list is still worth showing; the stamp is left stale so the next call tries again
        log.warn?.(`[agents] sync failed: ${e?.message ?? e}`);
      }
    }
    return entries.map((e) => e.info);
  }

  async function find(slug) {
    const { entries } = await scan();
    return entries.find((e) => e.slug === slug && !e.info.error) ?? null;
  }

  async function create(input) {
    const name = String(input?.name ?? "").trim();
    const description = String(input?.description ?? "").trim();
    const isolation = input?.isolation == null ? "none" : input.isolation;
    if (!name) throw new AgentError("Give the agent a name");
    if (name.length > NAME_MAX) throw new AgentError(`The name can be at most ${NAME_MAX} characters`);
    if (/[\r\n]/.test(name)) throw new AgentError("The name must be on one line");
    if (!description) throw new AgentError("Give the agent a one-line description");
    if (description.length > DESCRIPTION_MAX) throw new AgentError(`The description can be at most ${DESCRIPTION_MAX} characters`);
    if (/[\r\n]/.test(description)) throw new AgentError("The description must be on one line");
    if (!ISOLATIONS.includes(isolation)) throw new AgentError('isolation must be "worktree" or "none"');

    await fs.mkdir(root, { recursive: true });
    const taken = new Set((await fs.readdir(root)).map((n) => n));
    let slug = slugForName(name, taken);
    // mkdir without `recursive` is the claim: two creates racing for one slug cannot both win it
    for (;;) {
      try {
        await fs.mkdir(join(root, slug));
        break;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        taken.add(slug);
        slug = slugForName(name, taken);
      }
    }
    const dir = join(root, slug);
    await fs.mkdir(join(dir, "home"), { recursive: true });
    await fs.writeFile(join(dir, "agent.md"), buildAgentMd({ name, description, isolation }), "utf-8");
    await sync();
    const made = await find(slug);
    if (!made) throw new AgentError("The agent was written but could not be read back");
    return made.info;
  }

  async function dispatch(input) {
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
    const directory = typeof input?.directory === "string" ? input.directory : "";
    const slug = typeof input?.slug === "string" ? input.slug : "";
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!sessionId) throw new AgentError("There is no open chat to start the task from");
    const agent = await find(slug);
    if (!agent) throw new AgentError(`No agent named @${slug}`);
    if (isCtoSession && (await isCtoSession(sessionId))) throw new AgentError("@agent mentions aren't available here");
    if (!text) throw new AgentError(`Write what you want @${slug} to do`);
    if (!directory) throw new AgentError("This chat has no folder to start the task in");
    await delegateView?.assertWritable(sessionId);

    let seat = "";
    try {
      const project = await registry?.identify(directory);
      if (project?.slug && /^[a-z0-9-]+$/.test(project.slug)) {
        seat = ((await readOptional(fs, join(agent.dir, "seats", `${project.slug}.md`))) ?? "").trim();
      }
    } catch (e) {
      log.warn?.(`[agents] seat brief lookup failed: ${e?.message ?? e}`);
    }
    let excerpt = "";
    try {
      excerpt = buildConversationExcerpt(await oc.listMessages(sessionId, { limit: EXCERPT_FETCH }));
    } catch {
      excerpt = ""; // a read failure just omits the section
    }

    const res = await delegate.startJob({
      prompt: buildDispatchPrompt({ text, seat, excerpt }),
      parentSessionID: sessionId,
      parentDirectory: directory,
      agent: agentKey(slug),
      agentDir: agent.dir,
      isolation: agent.meta.isolation,
      ...(agent.meta.model ? { model: agent.meta.model } : {}),
      name: requestTitle(text, slug),
      agentName: agent.meta.name,
      request: text,
    });
    if (!res?.ok) throw new AgentError(res?.error || "The task couldn't be started");
    return { jobId: res.job.id };
  }

  function openChat(input) {
    const slug = typeof input?.slug === "string" ? input.slug : "";
    return chatLock.runExclusive(async () => {
      const agent = await find(slug);
      if (!agent) throw new AgentError(`No agent named @${slug}`);
      const home = join(agent.dir, "home");
      await fs.mkdir(home, { recursive: true });
      const chatFile = join(agent.dir, CHAT_FILE);
      const stored = (await readJsonOptional(fs, chatFile))?.sessionId;

      const projects = await tmux.listProjects();
      const space = projects.find((p) => p.tmuxSession === AGENTS_TMUX_SESSION);
      if (typeof stored === "string" && stored) {
        const open = space?.windows?.find((w) => w.opencodeSessionId === stored);
        if (open) return { tmuxSession: AGENTS_TMUX_SESSION, windowIndex: open.index };
      }
      // the window was closed but the conversation may still exist: reopen it rather than start over
      let sessionId = null;
      if (typeof stored === "string" && stored && typeof oc.sessionExists === "function" && (await oc.sessionExists(stored))) sessionId = stored;
      if (!sessionId) {
        const sess = await oc.createSession({ directory: home, agent: agentKey(slug), title: agent.meta.name });
        sessionId = sess?.id;
        if (!sessionId) throw new AgentError("OpenCode didn't start a chat for this agent");
        await fs.writeFile(chatFile, `${JSON.stringify({ sessionId }, null, 2)}\n`, "utf-8");
      }
      const windowName = agent.meta.name.replace(/[:.]/g, "-");
      const made = space
        ? await tmux.newWindow({ sessionName: AGENTS_TMUX_SESSION, windowName, cwd: home, chatMode: true, existingSessionId: sessionId, oc })
        : await tmux.newSession({ name: AGENTS_TMUX_SESSION, cwd: home, windowName, chatMode: true, existingSessionId: sessionId, oc });
      await syncState?.refreshNow?.();
      return { tmuxSession: AGENTS_TMUX_SESSION, windowIndex: made.windowIndex };
    });
  }

  return { init, installBuiltIns, sync, list, create, dispatch, openChat, scan, root };
}

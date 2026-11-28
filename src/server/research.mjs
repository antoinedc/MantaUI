// research.mjs — the research tools (Agents Phase 5A, spec docs/superpowers/specs/2026-11-24-agents-phase5-builder.md §4.3;
// open to every specialist's task by the research library spec, docs/superpowers/specs/2026-11-24-research-library.md).
//
// The server, not the model, fetches every page, keeps its raw text and later checks every quote against it (agents.mjs,
// `agent_propose`). Three tools: `research_fetch` (a public page), `research_read` (further into a stored source) and
// `research_search` (HN, arXiv, GitHub, packages, Stack Overflow, Reddit, X, and the user's own sources, all of them in the box-wide list
// of Settings → Research sources, `researchSources.mjs`). A fetch reads web pages, text, JSON, PDFs
// (papers; extracted to text in a worker thread) and GitHub files (a github.com blob address is read raw). Every call is bound first: the exact running tool
// part, the calling agent, and the calling session being the child of that agent's RUNNING job (`bind`, injected from the
// agents engine; the Architect also carries its capability stamp) — a refusal is a sentence, before any fetch, command or
// write. Only the Architect's binding says `architect: true`; it alone searches the `skills` source. Every outgoing request to an outside
// destination (a query to an outside source, a fetched address) passes the one outside-query check first (research/outsideQuery.mjs).
//
// Dependency-injected like the other engines: tests drive it with a fake transport, DNS, execFile and a temp folder.

import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { convert } from "html-to-text";
import { XMLParser } from "fast-xml-parser";
import pThrottle from "p-throttle";
import { statePath } from "../shared/paths.mjs";
import { QUERY_MAX, QUERY_TOKEN } from "../shared/architectSources.mjs";
import { BUILTIN_SOURCES } from "../shared/researchSources.mjs";
import { loadSecretsStrict as defaultLoadSecretsStrict } from "./secrets.mjs";
import { createGuardedTransport, fetchFollowing, ResearchError, BYTE_CAP, PDF_BYTE_CAP, FETCH_DEADLINE_MS } from "./research/transport.mjs";
import { extractPdfText } from "./research/pdf.mjs";
import { RESERVED_HOSTS, RESERVED_SENTENCE, canonicalPost, jinaRead, exaSearch } from "./research/reach.mjs";
import { runCommandSource, runUrlSource, queryRefusal } from "./research/extra.mjs";
import { createSkillsFinder } from "./research/skillsCli.mjs";
import { createOutsideCheck } from "./research/outsideQuery.mjs";

export const WINDOW_CHARS = 40_000;
export const STORE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const STORE_MAX_BYTES = 200 * 1024 * 1024;
export const BASE_SEARCH_SOURCES = Object.freeze(["hn", "arxiv", "reddit", "x", "github", "packages", "stackoverflow"]);
export const ANSWER_CACHE_MS = 10 * 60 * 1000;
/** Per task round / chat turn (spec §10): research_search and research_fetch calls, counted apart. */
export const TURN_CAPS = Object.freeze({ search: 30, fetch: 40 });
const TURNS_KEPT = 1000;
const ANSWER_CACHE_MAX = 200;
const THROTTLE_QUEUE_MAX = 3; // a queue longer than this is a refusal, not a wait
const DEPS_API = "https://api.deps.dev/v3/systems";
const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search";
const SE_API = "https://api.stackexchange.com/2.3/search/advanced";
const PACKAGE_SYSTEMS = Object.freeze({ npm: "NPM", pypi: "PYPI", go: "GO", maven: "MAVEN", cargo: "CARGO", nuget: "NUGET", rubygems: "RUBYGEMS" });
const PACKAGE_PREFIX_RE = /^(npm|pypi|go|maven|cargo|nuget|rubygems)\s*:\s*(\S.*)$/i;
const isoDay = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
const defaultRows = () => BUILTIN_SOURCES.map((b) => ({ id: b.id, builtin: true, kind: "builtin", enabled: true, private: false, name: b.name, description: b.description }));
export const SKILLS_SOURCE = "skills"; // the Architect's own: existing skills (src/server/research/skillsCli.mjs)
const SEARCHES_FILE = "searches.json"; // beside a session's sources: what its research_search calls asked and returned (never a source)
const SEARCHES_KEEP = 200;
const REFS_PER_SEARCH = 80;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_ID_RE = /^src_[0-9a-f]{16}$/;
const UNEXPECTED = "The research tool failed; try again";
const execFileAsync = promisify(execFile);

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const htmlText = (html) =>
  convert(html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }, { selector: "script", format: "skip" }, { selector: "style", format: "skip" }, { selector: "a", options: { ignoreHref: false } }] });

function decodeBody(buf, contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? "");
  try {
    return new TextDecoder(m ? m[1] : "utf-8", { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf-8");
  }
}

const htmlTitle = (html) => {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? collapse(htmlText(m[1])).slice(0, 200) : null;
};

/** The sentence refusing an address on EVERY hop of a generic fetch, or null. */
export function addressRefusal(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "That isn't a valid address";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http and https addresses can be read";
  if (u.username || u.password) return "Addresses with a username or password can't be read";
  const host = u.hostname.toLowerCase();
  if (RESERVED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return RESERVED_SENTENCE;
  return null;
}

// "author: comment" text from an HN item (hn.algolia.com/api/v1/items/<id>), indented by depth
function renderHnItem(item) {
  const lines = [];
  const head = [item.title, item.points != null ? `${item.points} points` : null, item.author ? `by ${item.author}` : null].filter(Boolean).join(" — ");
  if (head) lines.push(head);
  if (item.url) lines.push(item.url);
  if (item.text) lines.push("", htmlText(item.text));
  const walk = (children, depth) => {
    for (const c of Array.isArray(children) ? children : []) {
      if (c?.text) lines.push(`${"  ".repeat(depth)}${c.author ?? "?"}: ${collapse(htmlText(c.text))}`);
      walk(c?.children, depth + 1);
    }
  };
  walk(item.children, 1);
  return lines.join("\n");
}

const GITHUB_BLOB = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;

/** The raw-file address of a github.com blob address (`/<owner>/<repo>/blob/<ref>/<path>`), or null. Query and fragment are dropped. */
export function githubRawUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.hostname !== "github.com" && u.hostname !== "www.github.com")) return null;
  const m = GITHUB_BLOB.exec(u.pathname);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}

const GITHUB_API = "https://api.github.com/search/";
const HN_ITEM_PAGE = /^https:\/\/news\.ycombinator\.com\/item\?id=(\d{1,12})$/;

/**
 * @param {object} deps
 * @param {(b:object, tool:string)=>Promise<{job?:object, childSessionID?:string, refused?:string}>} deps.bind  the Architect binding
 * @param {string} [deps.root]          ~/.manta/research
 * @param {object} [deps.fs]            node:fs/promises
 * @param {Function} [deps.hop]         one HTTP request (the guarded transport); tests inject a fake. The engine wraps it (see `hop` below): the
 *                                      outside-query check runs on EVERY request that goes through it, redirect hops included
 * @param {()=>Promise<object[]>} [deps.sourceList]   the box-wide ordered research sources (researchSources.rows()): built-in and user rows, enabled or not
 * @param {{check:Function}} [deps.outside]  the outside-query check (default: built from this engine's own stores)
 * @param {(sessionID:string)=>Promise<string|null>} [deps.folderOf]  the folder of a task / chat session, for the outside-query check
 * @param {(opts:object)=>Function} [deps.makeThrottle]  p-throttle-shaped, for the per-source throttles
 * @param {(req:{query:string,directory:string})=>Promise<object[]>} [deps.webSearch]  OpenCode's own web-search route (`POST /api/websearch`), for Settings → Test on the web row
 * @param {()=>Promise<object[]>} [deps.loadSecretsStrict]  the stored secrets, read strictly
 * @param {Function} [deps.exec]        execFile-shaped, for command sources
 */
export function createResearchEngine({
  bind,
  root = statePath("research"),
  fs = fsPromises,
  hop: transport = createGuardedTransport(),
  sourceList = async () => defaultRows(),
  outside = null,
  folderOf = async () => null,
  webSearch = async () => {
    throw new ResearchError("Testing web search isn't available here");
  },
  makeThrottle = (opts) => pThrottle(opts),
  loadSecretsStrict = defaultLoadSecretsStrict,
  exec = (file, args, opts) => execFileAsync(file, args, { ...opts, encoding: "utf8" }),
  extractPdf = extractPdfText,
  agentHome = statePath("agents", "architect", "home"),
  toolsRoot = statePath("tools", "skills"),
  home = homedir(),
  pathEnv = process.env.PATH,
  now = Date.now,
  log = console,
} = {}) {
  // ---- the store: server-owned, immutable sources per child session ----

  const sessionDir = (child) => join(root, child);

  async function storeSource(child, { url = null, finalUrl = null, title = null, text, isPrivate = false }) {
    const id = `src_${randomBytes(8).toString("hex")}`;
    const rec = { id, url, finalUrl, title, fetchedAt: now(), private: isPrivate, text };
    await fs.mkdir(sessionDir(child), { recursive: true });
    await fs.writeFile(join(sessionDir(child), `${id}.json`), `${JSON.stringify(rec)}\n`, { flag: "wx" });
    return rec;
  }

  /** A stored source of THIS session (`{id,url,finalUrl,title,fetchedAt,private,text}`) or null. Never another session's. */
  async function getSource(child, id) {
    if (typeof child !== "string" || !SESSION_RE.test(child) || typeof id !== "string" || !SOURCE_ID_RE.test(id)) return null;
    try {
      const rec = JSON.parse(await fs.readFile(join(sessionDir(child), `${id}.json`), "utf-8"));
      return rec && typeof rec.text === "string" ? rec : null;
    } catch {
      return null;
    }
  }

  // ---- the search record (Architect v2 §4.2): what each research_search call asked and which repositories / addresses it returned ----

  let searchChain = Promise.resolve();

  /** The searches of THIS session, oldest first: `[{ source, query, refs[], at }]` (never another session's). */
  async function searchesOf(child) {
    if (typeof child !== "string" || !SESSION_RE.test(child)) return [];
    try {
      const doc = JSON.parse(await fs.readFile(join(sessionDir(child), SEARCHES_FILE), "utf-8"));
      return Array.isArray(doc) ? doc.filter((s) => s && typeof s.source === "string" && typeof s.query === "string" && Array.isArray(s.refs)) : [];
    } catch {
      return [];
    }
  }

  function recordSearch(child, entry) {
    const run = searchChain.then(async () => {
      const list = await searchesOf(child);
      list.push({ ...entry, at: now() });
      await fs.mkdir(sessionDir(child), { recursive: true });
      const file = join(sessionDir(child), SEARCHES_FILE);
      const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
      await fs.writeFile(tmp, `${JSON.stringify(list.slice(-SEARCHES_KEEP))}\n`);
      await fs.rename(tmp, file);
    });
    searchChain = run.catch(() => {});
    return run;
  }

  const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
  /** The repository names and addresses a search returned (what a later claim "I saw it in a result" is checked against). */
  function refsOf(results) {
    const out = new Set();
    const add = (v) => {
      if (typeof v === "string" && v.trim() !== "" && v.length <= 300) out.add(v.trim());
    };
    for (const r of Array.isArray(results) ? results : []) {
      for (const k of ["ref", "repo", "url", "item"]) add(r?.[k]);
      const repo = typeof r?.title === "string" ? r.title.split(" — ")[0].trim() : "";
      if (REPO_NAME.test(repo)) add(repo);
    }
    return [...out].slice(0, REFS_PER_SEARCH);
  }

  /** Every stored source of THIS session (`{id,url,finalUrl,private,text}`), for the server's own checks; never shown to a model. */
  async function listSources(child) {
    if (typeof child !== "string" || !SESSION_RE.test(child)) return [];
    let names;
    try {
      names = (await fs.readdir(sessionDir(child))).filter((n) => /^src_[0-9a-f]{16}\.json$/.test(n));
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const rec = await getSource(child, n.slice(0, -".json".length));
      if (rec) out.push(rec);
    }
    return out;
  }

  // the first window of a stored source, the shape every fetching tool answers with
  function windowed(rec, offset = 0) {
    const total = rec.text.length;
    const text = rec.text.slice(offset, offset + WINDOW_CHARS);
    const nextOffset = offset + WINDOW_CHARS < total ? offset + WINDOW_CHARS : null;
    return { sourceId: rec.id, title: rec.title, text, offset, total, nextOffset, ...(nextOffset !== null ? { note: `More follows: read on with research_read({sourceId: "${rec.id}", offset: ${nextOffset}})` } : {}) };
  }

  // ---- the binding: nothing is read, fetched or run before it passes ----

  async function bound(input, tool, keys) {
    const str = (k) => (typeof input?.[k] === "string" ? input[k] : "");
    const raw = {};
    for (const k of keys) if (input && typeof input === "object" && Object.hasOwn(input, k)) raw[k] = input[k];
    const b = { sessionID: str("sessionID"), messageID: str("messageID"), callID: str("callID"), raw };
    const r = await bind(b, tool);
    if (r.refused) return { refused: r.refused };
    return { child: r.childSessionID ?? b.sessionID, architect: r.architect === true, turnKey: typeof r.turnKey === "string" && r.turnKey ? r.turnKey : null, scope: r.scope === "round" ? "round" : "turn", raw };
  }

  // what each task round / chat turn has used (the binding names it: `turnKey`); memory only — a restart gives a fresh allowance
  const turns = new Map();
  /** Uses one call of `kind` ("search" | "fetch") from this turn's allowance; throws the refusal when it is spent. A binding with no turn isn't capped. */
  function useAllowance(b, kind) {
    if (!b.turnKey) return;
    let t = turns.get(b.turnKey);
    if (!t) {
      t = { search: 0, fetch: 0 };
      turns.set(b.turnKey, t);
      while (turns.size > TURNS_KEPT) turns.delete(turns.keys().next().value);
    }
    if (t[kind] >= TURN_CAPS[kind]) {
      throw new ResearchError(`You've used the ${TURN_CAPS[kind]} ${kind === "search" ? "searches" : "fetches"} allowed in this ${b.scope}; work with what you have, or tell the user what is still missing`);
    }
    t[kind] += 1;
  }

  const guard = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ResearchError) return { ok: false, error: e.message };
      log.warn?.(`[research] unexpected failure: ${e?.message ?? e}`);
      return { ok: false, error: UNEXPECTED };
    }
  };

  // shared secrets only, never a session- or project-scoped one: a source always gets the same credential
  async function resolveSecrets(names) {
    let all;
    try {
      all = await loadSecretsStrict();
    } catch (e) {
      log.warn?.(`[research] couldn't read the secrets store: ${e?.message ?? e}`);
      throw new ResearchError("Couldn't read the stored secrets for this source; try again");
    }
    const found = new Map();
    for (const name of names) {
      const entry = all.find((s) => s?.scope === "shared" && s.key === name && typeof s.value === "string");
      if (entry) found.set(name, entry.value);
    }
    return found;
  }

  // ---- the outside-query check: one function for every outgoing request to an outside destination ----

  const outsideCheck =
    outside ??
    createOutsideCheck({
      loadSecrets: loadSecretsStrict,
      privateAnswers: async (sessionID) => (await listSources(sessionID)).filter((rec) => rec.private === true).map((rec) => rec.text),
      folderOf,
      webEnabled: async () => (await sourceList()).find((r) => r.id === "web")?.enabled !== false,
      record: ({ kind, tool }) => log.info?.(`[research] outside query refused kind=${kind} tool=${tool}`),
      log,
    });

  // THE chokepoint of every outgoing research request. All network access of this engine (the fetch tool's redirect following, every built-in
  // adapter, the user's URL sources, Exa, Jina, GitHub) goes through `hop`, so no adapter can skip the outside-query check, redirect hops
  // included, and a future one is checked by default: a request made outside any tool context is checked as an outside request. Only a call
  // explicitly marked private (a user source marked private — it may receive private material) or a person's own Settings → Test is not.
  const outbound = new AsyncLocalStorage();
  const asOutside = (sessionID, tool, fn) => outbound.run({ outside: true, sessionID, tool }, fn);
  const asUnchecked = (fn) => outbound.run({ outside: false }, fn);
  const hop = async (req) => {
    const c = outbound.getStore() ?? { outside: true, sessionID: "", tool: "research_search" };
    if (c.outside) {
      const verdict = await outsideCheck.check({ sessionID: c.sessionID, tool: c.tool, input: { url: req?.url } });
      if (!verdict.ok) throw new ResearchError(verdict.error);
    }
    return transport(req);
  };

  /** Throws a ResearchError with the check's sentence when the request may not go out. */
  async function assertOutside(sessionID, tool, input) {
    const verdict = await outsideCheck.check({ sessionID, tool, input });
    if (!verdict.ok) throw new ResearchError(verdict.error);
  }

  // ---- research_fetch ----

  async function contentOf(res, finalUrl) {
    if (res.status < 200 || res.status >= 300) throw new ResearchError(`The page answered with status ${res.status}`);
    const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/pdf") {
      const pdf = await extractPdf(res.body);
      return { title: pdf.title ?? null, text: pdf.text };
    }
    const body = decodeBody(res.body, res.headers["content-type"]);
    const host = (() => {
      try {
        return new URL(finalUrl).hostname;
      } catch {
        return "";
      }
    })();
    if (type === "text/html" || type === "application/xhtml+xml") return { title: htmlTitle(body), text: htmlText(body) };
    if (type.endsWith("json")) {
      if (host === "hn.algolia.com" && /^\/api\/v1\/items\/\d+$/.test(new URL(finalUrl).pathname)) {
        try {
          const item = JSON.parse(body);
          return { title: item.title ?? null, text: renderHnItem(item) };
        } catch {
          throw new ResearchError("That Hacker News item couldn't be read");
        }
      }
      return { title: null, text: body };
    }
    if (type === "text/plain" || type === "text/markdown" || type === "text/x-markdown") return { title: null, text: body };
    throw new ResearchError("This kind of file can't be read yet");
  }

  async function fetchTool(input) {
    const b = await bound(input, "research_fetch", ["url"]);
    if (b.refused) return { ok: false, error: b.refused };
    return guard(() => asOutside(b.child, "research_fetch", async () => {
      useAllowance(b, "fetch");
      const url = typeof b.raw.url === "string" ? b.raw.url.trim() : "";
      if (!url || url.length > 2000) throw new ResearchError("Give one web address");
      const refused = addressRefusal(url);
      if (refused) throw new ResearchError(refused);
      await assertOutside(b.child, "research_fetch", { url });
      const post = canonicalPost(url);
      let rec;
      if (post.error) throw new ResearchError(post.error);
      if (post.platform) {
        // Reddit / X: the Jina reader, from the validated components only
        const page = await jinaRead(hop, post.url, { deadlineAt: now() + FETCH_DEADLINE_MS, bytesLeft: BYTE_CAP });
        rec = await storeSource(b.child, { url, finalUrl: post.url, title: page.title, text: page.text });
      } else {
        const hn = HN_ITEM_PAGE.exec(url);
        const target = hn ? `https://hn.algolia.com/api/v1/items/${hn[1]}` : (githubRawUrl(url) ?? url);
        // every hop (the first and each redirect) is an outgoing request: the address policy here, the outside-query check in `hop`
        const res = await fetchFollowing(hop, target, { check: addressRefusal, now, pdfByteCap: PDF_BYTE_CAP });
        const content = await contentOf(res, res.finalUrl);
        rec = await storeSource(b.child, { url, finalUrl: res.finalUrl, title: content.title, text: content.text });
      }
      return { ok: true, ...windowed(rec) };
    }));
  }

  async function readTool(input) {
    const b = await bound(input, "research_read", ["sourceId", "offset"]);
    if (b.refused) return { ok: false, error: b.refused };
    return guard(async () => {
      const rec = await getSource(b.child, b.raw.sourceId);
      if (!rec) throw new ResearchError("That source wasn't fetched in this task; read it with research_fetch first");
      const offset = b.raw.offset === undefined ? 0 : b.raw.offset;
      if (!Number.isInteger(offset) || offset < 0 || offset > rec.text.length) throw new ResearchError("offset must be a whole number inside the source");
      return { ok: true, ...windowed(rec, offset) };
    });
  }

  // ---- research_search ----

  const getResponse = (url) => fetchFollowing(hop, url, { check: addressRefusal, now });
  const getJson = async (url) => {
    const res = await getResponse(url);
    if (res.status !== 200) throw new ResearchError(`The search answered with status ${res.status}`);
    return res.body.toString("utf-8");
  };
  const parseJson = (text, what) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new ResearchError(`${what}'s answer wasn't understood`);
    }
  };

  // box-wide throttles (p-throttle): arXiv asks for one request every 3 s, GitHub allows 10 a minute keyless. A queue that is already long is a refusal.
  const arxivRun = makeThrottle({ limit: 1, interval: 3000, strict: true })((fn) => fn());
  const githubRun = makeThrottle({ limit: 10, interval: 60_000, strict: true })((fn) => fn());
  const throttled = (run, sentence, fn) => {
    if ((run.queueSize ?? 0) >= THROTTLE_QUEUE_MAX) throw new ResearchError(sentence);
    // the queue may run `fn` later, from another call's timer: keep THIS call's check context
    const ctx = outbound.getStore();
    return run(() => (ctx ? outbound.run(ctx, fn) : fn()));
  };

  async function searchHn(query) {
    const json = parseJson(await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`), "Hacker News");
    return (Array.isArray(json.hits) ? json.hits : []).slice(0, 10).map((h) => ({
      title: h.title ?? null,
      url: h.url ?? null,
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      item: `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));
  }

  async function searchArxiv(query) {
    const xml = await throttled(arxivRun, "arXiv allows one request every 3 seconds; try again in a moment, or use the built-in websearch with site:arxiv.org", () => getJson(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=8&sortBy=relevance`));
    const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (name) => name === "entry" || name === "author" }).parse(xml);
    return (doc?.feed?.entry ?? []).map((e) => ({
      title: collapse(e.title),
      authors: (e.author ?? []).map((a) => collapse(a?.name)).filter(Boolean).slice(0, 4),
      date: String(e.published ?? "").slice(0, 10),
      url: String(e.id ?? "").replace(/^http:/, "https:"),
      summary: collapse(e.summary).slice(0, 300),
    }));
  }

  // GitHub's REST search: repositories always (no key needed); code search for SKILL.md files only with a shared GITHUB_TOKEN
  // (GitHub refuses unauthenticated code search). The token goes to api.github.com only and no redirect is ever followed.
  async function githubGet(path, params, token) {
    const url = `${GITHUB_API}${path}?${params}`;
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const limit = "GitHub's search limit was reached; wait a minute, or use the built-in websearch with site:github.com";
    const res = await throttled(githubRun, limit, () => hop({ url, headers, deadlineAt: now() + FETCH_DEADLINE_MS, bytesLeft: BYTE_CAP }));
    const text = res.body.toString("utf-8");
    if (res.status === 401 && token) return githubGet(path, params, null); // a stale token must not break the search
    if (res.status === 429 || (res.status === 403 && (res.headers["x-ratelimit-remaining"] === "0" || res.headers["retry-after"] || /rate limit/i.test(text)))) {
      throw new ResearchError(limit);
    }
    if (res.status === 422) throw new ResearchError("GitHub rejected the search; simplify the query");
    if (res.status !== 200) throw new ResearchError(`GitHub answered with status ${res.status}`);
    try {
      const json = JSON.parse(text);
      return Array.isArray(json?.items) ? json.items : [];
    } catch {
      throw new ResearchError("GitHub's answer wasn't understood");
    }
  }

  async function searchGithub(query) {
    let token = null;
    try {
      token = (await resolveSecrets(["GITHUB_TOKEN"])).get("GITHUB_TOKEN") ?? null; // optional: an unreadable store just means no token
    } catch {
      token = null;
    }
    const repos = await githubGet("repositories", `q=${encodeURIComponent(`${query} skill in:name,description,topics,readme`)}&per_page=10`, token);
    const results = repos.slice(0, 10).map((r) => ({
      title: r.full_name ?? null,
      url: r.html_url ?? null,
      stars: r.stargazers_count ?? 0,
      pushed: String(r.pushed_at ?? "").slice(0, 10),
      license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : (r.license?.name ?? null),
      description: r.description ? collapse(r.description).slice(0, 300) : null,
    }));
    let note;
    if (!token) {
      note = "Code search (SKILL.md files) needs a GITHUB_TOKEN shared secret and was skipped; only repositories were searched.";
    } else {
      try {
        const files = await githubGet("code", `q=${encodeURIComponent(`${query} filename:SKILL.md`)}&per_page=8`, token);
        for (const f of files.slice(0, 8)) {
          results.push({ title: `${f.repository?.full_name ?? "?"} — ${f.path ?? f.name ?? "?"}`, url: f.html_url ?? null, description: f.repository?.description ? collapse(f.repository.description).slice(0, 300) : null });
        }
      } catch {
        note = "Code search for SKILL.md files failed; only repositories are listed.";
      }
    }
    return { results, ...(note ? { note } : {}) };
  }

  // ---- packages: deps.dev (versions, licences, advisories, deprecation for seven ecosystems) and the npm registry's keyword search ----

  const repoUrl = (u) => (typeof u === "string" ? u.replace(/^git\+/, "").replace(/\.git$/, "") : "");

  async function packageFacts(system, ecosystem, name) {
    const enc = encodeURIComponent(name);
    const res = await getResponse(`${DEPS_API}/${system}/packages/${enc}`);
    if (res.status === 404) throw new ResearchError(`No package ${ecosystem}:${name} found; check the spelling, or search by keyword without a prefix (npm only)`);
    if (res.status !== 200) throw new ResearchError(`deps.dev answered with status ${res.status}`);
    const pkg = parseJson(res.body.toString("utf-8"), "deps.dev");
    const versions = (Array.isArray(pkg.versions) ? pkg.versions : []).filter((v) => typeof v?.versionKey?.version === "string");
    if (versions.length === 0) throw new ResearchError(`No package ${ecosystem}:${name} found; check the spelling, or search by keyword without a prefix (npm only)`);
    const newest = [...versions].sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));
    const chosen = versions.find((v) => v.isDefault === true) ?? newest.find((v) => !v.isDeprecated) ?? newest[0];
    const out = { title: `${ecosystem}:${name}`, url: `https://deps.dev/${ecosystem}/${enc}`, version: chosen.versionKey.version, date: isoDay(chosen.publishedAt) };
    let detail = null;
    try {
      const d = await getResponse(`${DEPS_API}/${system}/packages/${enc}/versions/${encodeURIComponent(chosen.versionKey.version)}`);
      if (d.status === 200) detail = parseJson(d.body.toString("utf-8"), "deps.dev");
    } catch {
      detail = null; // the package line stands without its licence and advisories
    }
    const licenses = Array.isArray(detail?.licenses) ? detail.licenses.filter((l) => typeof l === "string") : [];
    const deprecated = chosen.isDeprecated === true || detail?.isDeprecated === true;
    const link = (label) => (Array.isArray(detail?.links) ? detail.links.find((l) => l?.label === label)?.url : undefined);
    return {
      ...out,
      license: licenses.length > 0 ? licenses.join(", ") : null,
      deprecated,
      ...(deprecated && chosen.deprecatedReason ? { deprecatedReason: collapse(chosen.deprecatedReason).slice(0, 200) } : {}),
      advisories: Array.isArray(detail?.advisoryKeys) ? detail.advisoryKeys.length : null,
      ...(link("HOMEPAGE") ? { homepage: link("HOMEPAGE") } : {}),
      ...(link("SOURCE_REPO") ? { repo: repoUrl(link("SOURCE_REPO")) } : {}),
      recent: newest.slice(0, 5).map((v) => ({ version: v.versionKey.version, date: isoDay(v.publishedAt) })),
    };
  }

  async function searchPackages(query) {
    const m = PACKAGE_PREFIX_RE.exec(query.trim());
    if (m) return [await packageFacts(PACKAGE_SYSTEMS[m[1].toLowerCase()], m[1].toLowerCase(), m[2].trim())];
    const json = parseJson(await getJson(`${NPM_SEARCH}?text=${encodeURIComponent(query)}&size=8`), "The npm registry");
    return (Array.isArray(json.objects) ? json.objects : []).slice(0, 8).flatMap((o) => {
      const p = o?.package;
      if (typeof p?.name !== "string") return [];
      return [
        {
          title: `npm:${p.name}`,
          url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
          version: p.version ?? null,
          date: isoDay(p.date),
          ...(p.license ? { license: String(p.license) } : {}),
          weeklyDownloads: o.downloads?.weekly ?? 0,
          ...(p.description ? { description: collapse(p.description).slice(0, 300) } : {}),
        },
      ];
    });
  }

  // ---- Stack Overflow: the Stack Exchange API, keyless (300 requests a day per address): stops for the day when `quota_remaining` hits 0 and honours `backoff` ----

  const se = { exhaustedUntil: 0, backoffUntil: 0 };
  const SE_DAILY = "Stack Overflow's free daily limit was reached; use websearch with site:stackoverflow.com";
  const nextUtcMidnight = () => {
    const d = new Date(now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  };
  const sePause = (ms) => new ResearchError(`Stack Overflow asked for a pause; try again in ${Math.max(1, Math.ceil(ms / 1000))} seconds, or use websearch with site:stackoverflow.com`);

  async function searchStackOverflow(query) {
    if (se.exhaustedUntil > now()) throw new ResearchError(SE_DAILY);
    if (se.backoffUntil > now()) throw sePause(se.backoffUntil - now());
    const res = await getResponse(`${SE_API}?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=8`);
    const json = (() => {
      try {
        return JSON.parse(res.body.toString("utf-8"));
      } catch {
        return null;
      }
    })();
    if (Number.isFinite(json?.backoff) && json.backoff > 0) se.backoffUntil = now() + json.backoff * 1000;
    if (json?.quota_remaining === 0) se.exhaustedUntil = nextUtcMidnight();
    if (res.status === 400 && json?.error_name === "throttle_violation") {
      se.backoffUntil = Math.max(se.backoffUntil, now() + 60_000);
      throw sePause(se.backoffUntil - now());
    }
    if (res.status !== 200) throw new ResearchError(`Stack Overflow answered with status ${res.status}`);
    if (!json || !Array.isArray(json.items)) throw new ResearchError("Stack Overflow's answer wasn't understood");
    return json.items.slice(0, 8).map((q) => ({
      title: collapse(htmlText(String(q.title ?? ""))).slice(0, 300),
      url: q.link ?? null,
      score: q.score ?? 0,
      answers: q.answer_count ?? 0,
      accepted: q.accepted_answer_id != null,
      date: Number.isFinite(q.creation_date) ? new Date(q.creation_date * 1000).toISOString().slice(0, 10) : "",
      tags: Array.isArray(q.tags) ? q.tags.slice(0, 6).map(String) : [],
    }));
  }

  // ---- the user's own sources ----

  /** The text a command or url source answers with (secrets redacted); throws a ResearchError. Nothing is stored here. */
  async function extraText(source, query) {
    let text;
    if (source.command) {
      ({ text } = await runCommandSource(source, query, { home, cwd: agentHome, pathEnv, exec, fs, resolveSecrets }));
    } else {
      const res = await runUrlSource(source, query, { hop, resolveSecrets });
      if (res.status < 200 || res.status >= 300) throw new ResearchError(`The source answered with status ${res.status}`);
      const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const body = decodeBody(res.body, res.headers["content-type"]);
      if (type === "text/html") text = htmlText(body);
      else if (type.endsWith("json") || type.startsWith("text/")) text = body;
      else throw new ResearchError("This source answered with something that can't be read yet");
      for (const v of res.used) if (v) text = text.split(v).join("[secret]");
    }
    return text;
  }

  async function searchExtra(source, query, child) {
    const text = await extraText(source, query);
    // one stored source, private or not as the definition says; no link in it is ever fetched by the server on its own
    const rec = await storeSource(child, { url: null, finalUrl: null, title: `${source.name}: ${query}`.slice(0, 200), text, isPrivate: source.private !== false });
    return windowed(rec);
  }

  const skillsFinder = createSkillsFinder({ toolsRoot, exec, fs, pathEnv, now, log });

  // ---- built-in sources: one answer cache (10 minutes, identical query) for every session ----

  const answerCache = new Map();
  async function queryBuiltin(source, query) {
    if (source === "hn") return { results: await searchHn(query) };
    if (source === "arxiv") return { results: await searchArxiv(query) };
    if (source === "github") return searchGithub(query);
    if (source === "packages") return { results: await searchPackages(query) };
    if (source === "stackoverflow") return { results: await searchStackOverflow(query) };
    return { results: await exaSearch(hop, query, source, { deadlineAt: now() + FETCH_DEADLINE_MS }) }; // reddit, x
  }

  async function builtinAnswer(source, query) {
    const key = `${source}\n${query}`;
    const hit = answerCache.get(key);
    if (hit && now() - hit.at < ANSWER_CACHE_MS) return structuredClone(hit.answer);
    const answer = await queryBuiltin(source, query);
    answerCache.set(key, { at: now(), answer: structuredClone(answer) });
    while (answerCache.size > ANSWER_CACHE_MAX) answerCache.delete(answerCache.keys().next().value);
    return answer;
  }

  const OFF = (id) => `The source "${id}" is turned off in Settings → Research sources`;

  async function searchTool(input) {
    const b = await bound(input, "research_search", ["source", "query"]);
    if (b.refused) return { ok: false, error: b.refused };
    return guard(async () => {
      useAllowance(b, "search");
      const source = typeof b.raw.source === "string" ? b.raw.source : "";
      const query = b.raw.query;
      if (typeof query !== "string" || query.trim() === "" || query.length > QUERY_MAX) throw new ResearchError(`The query must be 1 to ${QUERY_MAX} characters`);
      const rows = await sourceList();
      const row = rows.find((r) => r.id === source);
      const unknown = () => {
        const ids = rows.filter((r) => r.enabled && r.id !== "web").map((r) => r.id);
        return new ResearchError(`Unknown source "${source}". Available: ${[...ids, ...(b.architect ? [SKILLS_SOURCE] : [])].join(", ")}`);
      };
      // every request below goes through `hop`: checked as an outside request (redirect hops too), except a source marked private
      const net = (isPrivate, fn) => (isPrivate ? asUnchecked(fn) : asOutside(b.child, "research_search", fn));
      let answer;
      if (source === SKILLS_SOURCE) {
        // the Architect's own: existing skills (src/server/research/skillsCli.mjs)
        if (!b.architect) throw unknown();
        await assertOutside(b.child, "research_search", { query });
        answer = { ok: true, source, ...(await net(false, () => skillsFinder.find(query))) };
      } else {
        if (!row) throw unknown();
        if (!row.enabled) throw new ResearchError(OFF(source));
        if (source === "web") throw new ResearchError("Use the built-in websearch for the web");
        // a query to an outside source (every built-in, every user source not marked private) must not carry private material
        if (row.private === false || row.builtin === true) {
          await assertOutside(b.child, "research_search", row.url ? { url: row.url.replace(QUERY_TOKEN, encodeURIComponent(query)) } : { query });
        }
        if (row.builtin !== true) {
          answer = { ok: true, source, ...(await net(row.private !== false, () => searchExtra(row, query, b.child))) };
        } else {
          const refused = queryRefusal(query);
          if (refused) throw new ResearchError(refused);
          answer = { ok: true, source, ...(await net(false, () => builtinAnswer(source, query))) };
        }
      }
      // what the search asked and returned is kept for the server's later checks; a failed search throws above and leaves nothing
      try {
        await recordSearch(b.child, { source, query, refs: refsOf(answer.results) });
      } catch (e) {
        log.warn?.(`[research] couldn't record a search: ${e?.message ?? e}`);
      }
      return answer;
    });
  }

  /**
   * Settings → Research sources → Test: run ONE source for `query` and report what it gave — `{ count, first?: {title, url?}, text? }` (`text`
   * only for a user source: the page shows its first 200 characters). Stores nothing, records nothing, never reads the answer cache.
   * Throws a ResearchError with the sentence the search itself would give. A person typed this query, so the outside check is not applied.
   */
  async function testWeb(query) {
    const refused = queryRefusal(query);
    if (refused) throw new ResearchError(refused);
    // the same check an agent's websearch passes; the research_search tool name keeps it working while the source is still turned off
    await assertOutside("", "research_search", { query });
    let results;
    try {
      results = await webSearch({ query, directory: home });
    } catch (e) {
      if (e instanceof ResearchError) throw e;
      log.warn?.(`[research] web search test failed: ${e?.message ?? e}`);
      const text = String(e?.message ?? "");
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ResearchError("Web search took too long to answer");
      if (/provider/i.test(text)) throw new ResearchError("OpenCode has no web search provider set up on this box yet");
      throw new ResearchError("Web search failed; try again");
    }
    const list = Array.isArray(results) ? results : [];
    const top = list[0];
    return { count: list.length, ...(top ? { first: { title: String(top.title || top.url || "(untitled)").slice(0, 200), ...(top.url ? { url: top.url } : {}) } } : {}) };
  }

  function testSource(def, query) {
    // a person's own query: its requests are not run through the outside-query check (the web row's test does run it, in `testWeb`)
    return asUnchecked(() => testSourceUnchecked(def, query));
  }

  async function testSourceUnchecked(def, query) {
    if (def?.builtin === true) {
      if (def.id === "web") return testWeb(query);
      if (!BASE_SEARCH_SOURCES.includes(def.id)) throw new ResearchError(`Unknown source "${def.id}"`);
      const refused = queryRefusal(query);
      if (refused) throw new ResearchError(refused);
      const results = (await queryBuiltin(def.id, query)).results ?? [];
      const first = results[0] ? { title: String(results[0].title ?? results[0].ref ?? "(untitled)").slice(0, 200), ...(results[0].url ? { url: results[0].url } : {}) } : undefined;
      return { count: results.length, ...(first ? { first } : {}) };
    }
    const text = await extraText(def, query);
    const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    return { count: text.trim() ? 1 : 0, ...(line ? { first: { title: line.slice(0, 200) } } : {}), text };
  }

  // ---- the sweep: 30 days, and 200 MB box-wide (oldest sessions first) ----

  async function sweep({ maxBytes = STORE_MAX_BYTES, keepMs = STORE_KEEP_MS } = {}) {
    let names;
    try {
      names = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && SESSION_RE.test(e.name)).map((e) => e.name);
    } catch {
      return { removed: 0 };
    }
    const sessions = [];
    for (const name of names) {
      let size = 0;
      let newest = 0;
      try {
        for (const f of await fs.readdir(sessionDir(name))) {
          const st = await fs.stat(join(sessionDir(name), f));
          size += st.size;
          newest = Math.max(newest, st.mtimeMs);
        }
        if (newest === 0) newest = (await fs.stat(sessionDir(name))).mtimeMs;
      } catch {
        continue;
      }
      sessions.push({ name, size, newest });
    }
    let removed = 0;
    const drop = async (s) => {
      await fs.rm(sessionDir(s.name), { recursive: true, force: true });
      removed++;
    };
    const t = now();
    const alive = [];
    for (const s of sessions) (t - s.newest > keepMs ? await drop(s) : alive.push(s));
    let total = alive.reduce((n, s) => n + s.size, 0);
    for (const s of alive.sort((a, b) => a.newest - b.newest)) {
      if (total <= maxBytes) break;
      await drop(s);
      total -= s.size;
    }
    return { removed };
  }

  return { fetch: fetchTool, read: readTool, search: searchTool, getSource, searchesOf, listSources, sweep, root, outsideCheck: (req) => outsideCheck.check(req), testSource };
}

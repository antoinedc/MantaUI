// agentSkills.mjs — the Architect proposes skills for an agent (Architect v2 Stage 2, docs/superpowers/specs/2026-11-27-architect-v2.md §4).
//
// Pure logic with injected lookups, no I/O of its own: it turns the `skills` of a draft into the complete resulting `skills/**` file set and
// the card's `skillsDiff`, checking FACTS only — limits, that every copied file really occurs in a page this task fetched, that the licence
// allows copying and its notice travels with the copy, that the searches and candidates a proposal names were really made. Whether a skill is
// good is the Architect's judgement; nothing here reads it. The server writes `SOURCE.md` and `LICENSE`; the model never sends them.

export const SKILL_NAME_RE = /^[a-z0-9-]{1,50}$/;
export const SKILLS_MAX = 15; // per agent
export const SKILL_FILES_MAX = 20; // a change names at most this many files for one skill
export const SKILL_BYTES_MAX = 256 * 1024; // one skill, every file of it
export const AGENT_SKILLS_BYTES_MAX = 1024 * 1024; // all of an agent's skills
export const AGENT_SKILL_FILES_MAX = 250; // all of an agent's skill files (a snapshot also holds agent.md and learned/**: 300 files at most)
export const COPIED_MIN_CHARS = 20; // shorter copied text would occur in any page and proves nothing
export const SKILL_PATH_MAX = 120;
export const SKILL_PATH_DEPTH = 4;
export const GENERATED_FILES = Object.freeze(["SOURCE.md", "LICENSE"]);

/** The licences a skill may be copied under (SPDX ids). Anything else, unknown or missing: write your own and cite the source as research. */
export const COPY_LICENCES = Object.freeze(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0", "CC-BY-4.0", "MPL-2.0"]);
/** These need no notice to travel with the copy; every other allowed licence needs `licenseSourceId`. */
export const NO_NOTICE_LICENCES = Object.freeze(["0BSD", "Unlicense", "CC0-1.0"]);

const OP_KEYS = ["name", "op", "files", "provenance"];
const FILE_KEYS = ["path", "content", "origin", "sourceId"];
const PROVENANCE_KEYS = ["url", "sourceId", "repo", "ref", "licence", "licenseSourceId", "taken", "registry"];
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const SCRIPT_RE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
const wsNorm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
const bytes = (t) => Buffer.byteLength(t, "utf-8");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const normUrl = (u) => String(u ?? "").trim().replace(/#.*$/, "").replace(/\/+$/, "");

/** The canonical SPDX spelling of an allowed licence, or null. */
export const copyLicenceOf = (licence) => (typeof licence === "string" ? (COPY_LICENCES.find((l) => l.toLowerCase() === licence.trim().toLowerCase()) ?? null) : null);

/** Is this skill file a script (by name or shebang)? The card flags the ones that were copied. */
export const isScriptFile = (path, content = "") => SCRIPT_RE.test(path) || String(content).startsWith("#!");

// ---- SOURCE.md: written by the server, read back for the profile and skills_installed ----

/** `SOURCE.md` for a copied skill: origin link, ref, licence, what was taken, installs / stars at the time. Deterministic (the draft hash covers it). */
export function renderSourceMd(provenance, { copied = [], written = [] } = {}) {
  const p = provenance;
  const lines = [
    "# Where this skill comes from",
    "",
    `- Origin: ${p.url}`,
    `- Repository: ${p.repo}`,
    `- Ref: ${p.ref}`,
    `- Licence: ${p.licence}`,
    `- Taken: ${p.taken}`,
    ...(p.registry?.installs != null ? [`- Installs: ${p.registry.installs}`] : []),
    ...(p.registry?.stars != null ? [`- Stars: ${p.registry.stars}`] : []),
    `- Source id: ${p.sourceId}`,
    ...(p.licenseSourceId ? [`- Licence source id: ${p.licenseSourceId}`] : []),
    `- Copied files: ${[...copied].sort(cmp).join(", ")}`,
    ...(written.length > 0 ? [`- Written for this agent: ${[...written].sort(cmp).join(", ")}`] : []),
    "",
    "The copied files are the origin's own text, taken under the licence above (the notice is in LICENSE when the licence asks for one). Installs and stars are as they were when the skill was added.",
  ];
  return `${lines.join("\n")}\n`;
}

/** The provenance a `SOURCE.md` of ours records, or null when the text isn't one. */
export function parseSourceMd(text) {
  const field = (label) => new RegExp(`^- ${label}: (.+)$`, "m").exec(String(text ?? ""))?.[1]?.trim() ?? null;
  const url = field("Origin");
  const repo = field("Repository");
  const ref = field("Ref");
  const licence = field("Licence");
  const taken = field("Taken");
  if (!url || !repo || !ref || !licence || (taken !== "whole" && taken !== "part")) return null;
  const num = (v) => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  const installs = num(field("Installs"));
  const stars = num(field("Stars"));
  const licenseSourceId = field("Licence source id");
  return {
    url,
    sourceId: field("Source id") ?? "",
    repo,
    ref,
    licence,
    ...(licenseSourceId ? { licenseSourceId } : {}),
    taken,
    ...(installs !== null || stars !== null ? { registry: { installs, stars } } : {}),
  };
}

// ---- the draft's skill changes ----

const fail = (error) => ({ error });
const isNonNegInt = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 1e12);

function checkPath(path) {
  if (typeof path !== "string" || path === "" || path.length > SKILL_PATH_MAX || !PATH_RE.test(path)) return "a file path must be a relative path of letters, digits, dots, dashes and underscores, without `..`, a leading dot or an absolute start";
  const parts = path.split("/");
  if (parts.length > SKILL_PATH_DEPTH) return `a file path can be at most ${SKILL_PATH_DEPTH} folders deep`;
  if (parts.some((p) => p.startsWith("."))) return "a file path can't hold a name that starts with a dot";
  return null;
}

/**
 * Check the shape of the `skills` of a draft: `{ ops }` (trimmed) or `{ error }` (a sentence). Facts that need no lookup.
 * `header(text)` → `{ name, description }` of a SKILL.md's frontmatter, or null when it has none.
 */
export function checkSkillOps(raw, { header }) {
  if (!Array.isArray(raw) || raw.length === 0) return fail("skills must list the skill changes, each {name, op, files?, provenance?}");
  if (raw.length > SKILLS_MAX) return fail(`An agent can have at most ${SKILLS_MAX} skills; this draft names ${raw.length}`);
  const ops = [];
  for (const o of raw) {
    if (!isPlain(o)) return fail("every skill change must be {name, op, files?, provenance?}");
    for (const k of Object.keys(o)) if (!OP_KEYS.includes(k)) return fail(`Unknown field "${k}" in a skill change`);
    if (typeof o.name !== "string" || !SKILL_NAME_RE.test(o.name)) return fail(`A skill's name must be 1 to 50 lowercase letters, digits and dashes (got ${JSON.stringify(String(o.name).slice(0, 60))})`);
    if (!["add", "replace", "remove"].includes(o.op)) return fail(`The op of skill ${o.name} must be "add", "replace" or "remove"`);
    if (ops.some((x) => x.name === o.name)) return fail(`Skill ${o.name} is named twice; change it once`);
    if (o.op === "remove") {
      if (o.files !== undefined && !(Array.isArray(o.files) && o.files.length === 0)) return fail(`A remove of skill ${o.name} takes no files`);
      if (o.provenance !== undefined) return fail(`A remove of skill ${o.name} takes no provenance`);
      ops.push({ name: o.name, op: "remove", files: [], provenance: null });
      continue;
    }
    if (!Array.isArray(o.files) || o.files.length === 0) return fail(`Skill ${o.name} needs its files: [{path, content, origin}], with a SKILL.md`);
    if (o.files.length > SKILL_FILES_MAX) return fail(`A skill can have at most ${SKILL_FILES_MAX} files (skill ${o.name} has ${o.files.length})`);
    const files = [];
    for (const f of o.files) {
      if (!isPlain(f)) return fail(`Every file of skill ${o.name} must be {path, content, origin, sourceId?}`);
      for (const k of Object.keys(f)) if (!FILE_KEYS.includes(k)) return fail(`Unknown field "${k}" in a file of skill ${o.name}`);
      const bad = checkPath(f.path);
      if (bad) return fail(`Skill ${o.name}: ${bad} (got ${JSON.stringify(String(f.path).slice(0, 60))})`);
      if (GENERATED_FILES.includes(f.path)) return fail(`Skill ${o.name}: ${f.path} is written by the server; don't send it`);
      if (files.some((x) => x.path === f.path)) return fail(`Skill ${o.name} has the file ${f.path} twice`);
      if (typeof f.content !== "string") return fail(`Skill ${o.name}: ${f.path} must be text`);
      if (f.content.includes("\u0000")) return fail(`Skill ${o.name}: ${f.path} must be UTF-8 text (it holds a NUL character)`);
      if (f.origin !== "copied" && f.origin !== "written") return fail(`Skill ${o.name}: the origin of ${f.path} must be "copied" or "written"`);
      if (f.origin === "copied" && (typeof f.sourceId !== "string" || f.sourceId === "")) return fail(`Skill ${o.name}: ${f.path} is copied, so it needs the sourceId of the page you copied it from`);
      files.push({ path: f.path, content: f.content, origin: f.origin, ...(f.origin === "copied" ? { sourceId: f.sourceId } : {}) });
    }
    const md = files.find((f) => f.path === "SKILL.md");
    if (!md) return fail(`Skill ${o.name} needs a SKILL.md`);
    const h = header(md.content);
    if (!h) return fail(`The SKILL.md of skill ${o.name} needs frontmatter with name and description`);
    if (h.name !== o.name) return fail(`The frontmatter name of skill ${o.name} must be ${o.name} (it says ${JSON.stringify(h.name ?? "")})`);
    if (!h.description) return fail(`The SKILL.md of skill ${o.name} needs a description in its frontmatter`);
    let provenance = null;
    if (o.provenance !== undefined) {
      if (!files.some((f) => f.origin === "copied")) return fail(`Skill ${o.name}: provenance is for skills with copied files; this one has none`);
      if (!isPlain(o.provenance)) return fail(`The provenance of skill ${o.name} must be {url, sourceId, repo, ref, licence, taken, ...}`);
      for (const k of Object.keys(o.provenance)) if (!PROVENANCE_KEYS.includes(k)) return fail(`Unknown field "${k}" in the provenance of skill ${o.name}`);
      provenance = o.provenance;
    } else if (files.some((f) => f.origin === "copied")) {
      return fail(`Skill ${o.name} has copied files, so it needs provenance: {url, sourceId, repo, ref, licence, licenseSourceId, taken}`);
    }
    ops.push({ name: o.name, op: o.op, files, provenance });
  }
  return { ops };
}

/** Is this provenance well-formed? `{ provenance }` (trimmed) or `{ error }`. The licence is judged by `checkLicence`. */
function checkProvenanceShape(p, name) {
  const who = `The provenance of skill ${name}`;
  if (typeof p.url !== "string" || p.url.length > 500 || !/^https:\/\/[^\s]+$/.test(p.url)) return fail(`${who}: url must be the https address of the page it was taken from`);
  if (typeof p.sourceId !== "string" || p.sourceId === "") return fail(`${who}: sourceId must be the source id of that page (from research_fetch)`);
  if (typeof p.repo !== "string" || !REPO_RE.test(p.repo)) return fail(`${who}: repo must look like owner/repo`);
  if (typeof p.ref !== "string" || !REF_RE.test(p.ref)) return fail(`${who}: ref must be the commit or tag it was taken at`);
  if (p.taken !== "whole" && p.taken !== "part") return fail(`${who}: taken must be "whole" or "part"`);
  let registry;
  if (p.registry !== undefined && p.registry !== null) {
    if (!isPlain(p.registry) || !isNonNegInt(p.registry.installs ?? null) || !isNonNegInt(p.registry.stars ?? null)) return fail(`${who}: registry installs and stars must be whole numbers or null`);
    registry = { installs: p.registry.installs ?? null, stars: p.registry.stars ?? null };
  }
  return { provenance: { url: p.url.trim(), sourceId: p.sourceId, repo: p.repo, ref: p.ref, licence: typeof p.licence === "string" ? p.licence.trim() : "", ...(typeof p.licenseSourceId === "string" && p.licenseSourceId ? { licenseSourceId: p.licenseSourceId } : {}), taken: p.taken, ...(registry ? { registry } : {}) } };
}

/** `{ licence }` (canonical) or `{ error }`: the licence allows copying, and its notice travels with the copy unless it needs none. */
function checkLicence(p, name) {
  const licence = copyLicenceOf(p.licence);
  if (!licence) {
    const given = p.licence ? JSON.stringify(p.licence.slice(0, 60)) : "none given";
    return fail(`Skill ${name}: the licence (${given}) doesn't allow copying; write your own and cite what you learned as research. Copying is allowed under ${COPY_LICENCES.join(", ")}`);
  }
  if (!NO_NOTICE_LICENCES.includes(licence) && !p.licenseSourceId) return fail(`Skill ${name}: ${licence} needs its notice to travel with the copy; fetch the licence file and pass its source id as provenance.licenseSourceId`);
  return { licence };
}

/**
 * The complete resulting `skills/**` set and the card's diff. `existing`: `Map<skillName, Map<relPath, string>>` (what the agent has now;
 * empty for a new agent). `fetchSource(sourceId)` → the stored source of THIS task (any of its rounds) or null. `ops`: from `checkSkillOps`.
 * `{ files: Map<"skills/<name>/<path>", text>, diff }` or `{ error }`.
 */
export async function planSkills({ ops, existing, fetchSource }) {
  const result = new Map([...existing].map(([name, files]) => [name, new Map(files)]));
  const diff = [];
  const unfetched = (id) => `Source ${id} wasn't fetched in this task; read it with research_fetch first`;
  for (const o of ops) {
    const had = existing.get(o.name);
    if (o.op === "add" && had) return fail(`The agent already has a skill named ${o.name}; use op "replace" to change it`);
    if (o.op !== "add" && !had) return fail(`The agent has no skill named ${o.name} to ${o.op}`);
    if (o.op === "remove") {
      result.delete(o.name);
      diff.push({ name: o.name, op: "remove", paths: [...had.keys()].sort(cmp), provenance: null, scripts: [] });
      continue;
    }
    // every copied file really occurs in a page this task fetched, and that page is a public one
    const copiedPaths = [];
    const cache = new Map();
    const source = async (id) => {
      if (!cache.has(id)) cache.set(id, (await fetchSource(id)) ?? null);
      return cache.get(id);
    };
    for (const f of o.files) {
      if (f.origin !== "copied") continue;
      if (wsNorm(f.content).length < COPIED_MIN_CHARS) return fail(`Skill ${o.name}: ${f.path} is copied but too short (under ${COPIED_MIN_CHARS} characters) to show where it came from; write it instead`);
      const src = await source(f.sourceId);
      if (!src || typeof src.text !== "string") return fail(unfetched(f.sourceId));
      if (src.private === true) return fail(`Skill ${o.name}: ${f.path} would be copied from a private source (${f.sourceId}); private sources never appear in an agent's files`);
      if (!wsNorm(src.text).includes(wsNorm(f.content))) return fail(`The text of ${o.name}/${f.path} doesn't occur in source ${f.sourceId}; copy only text you fetched, exactly (whitespace may differ, case may not)`);
      copiedPaths.push(f.path);
    }
    let provenance = null;
    let licenceText = null;
    if (copiedPaths.length > 0) {
      const shaped = checkProvenanceShape(o.provenance, o.name);
      if (shaped.error) return shaped;
      const p = shaped.provenance;
      const page = await source(p.sourceId);
      if (!page || typeof page.text !== "string") return fail(unfetched(p.sourceId));
      if (page.private === true) return fail(`Skill ${o.name}: provenance.sourceId is a private source; cite a public page`);
      const urls = [page.url, page.finalUrl].filter(Boolean).map(normUrl);
      if (!urls.includes(normUrl(p.url))) return fail(`The provenance url of skill ${o.name} doesn't match the page source ${p.sourceId} was fetched from (${urls[0] ?? "no address"}); give that page's address as url`);
      const lic = checkLicence(p, o.name);
      if (lic.error) return lic;
      p.licence = lic.licence;
      if (p.licenseSourceId) {
        const l = await source(p.licenseSourceId);
        if (!l || typeof l.text !== "string") return fail(unfetched(p.licenseSourceId));
        if (l.private === true) return fail(`Skill ${o.name}: provenance.licenseSourceId is a private source; cite a public page`);
        if (wsNorm(l.text) === "") return fail(`Skill ${o.name}: the licence page ${p.licenseSourceId} has no text`);
        licenceText = l.text;
      }
      provenance = p;
    }
    const now = new Map(o.files.map((f) => [f.path, f.content]));
    if (provenance) {
      now.set("SOURCE.md", renderSourceMd(provenance, { copied: copiedPaths, written: o.files.filter((f) => f.origin === "written").map((f) => f.path) }));
      if (licenceText !== null) now.set("LICENSE", licenceText);
    }
    const size = [...now.values()].reduce((n, t) => n + bytes(t), 0);
    if (size > SKILL_BYTES_MAX) return fail(`Skill ${o.name} is ${Math.ceil(size / 1024)} KiB; a skill can be at most 256 KiB`);
    result.set(o.name, now);
    const paths = [...new Set([...now.keys(), ...(had ? had.keys() : [])])].filter((p) => (had?.get(p) ?? null) !== (now.get(p) ?? null)).sort(cmp);
    diff.push({
      name: o.name,
      op: o.op,
      paths,
      provenance,
      scripts: o.files.filter((f) => f.origin === "copied" && paths.includes(f.path) && isScriptFile(f.path, f.content)).map((f) => f.path).sort(cmp),
    });
  }
  if (result.size > SKILLS_MAX) return fail(`An agent can have at most ${SKILLS_MAX} skills; this change leaves ${result.size}`);
  let total = 0;
  let count = 0;
  for (const files of result.values()) {
    for (const t of files.values()) {
      total += bytes(t);
      count += 1;
    }
  }
  if (total > AGENT_SKILLS_BYTES_MAX) return fail(`An agent's skills can total at most 1 MiB; this change leaves ${(total / 1024 / 1024).toFixed(1)} MiB`);
  if (count > AGENT_SKILL_FILES_MAX) return fail(`An agent's skills can hold at most ${AGENT_SKILL_FILES_MAX} files; this change leaves ${count}`);
  const files = new Map();
  for (const [name, fs] of result) for (const [p, text] of fs) files.set(`skills/${name}/${p}`, text);
  return { files, diff };
}

/** `Map<skillName, Map<relPath, text>>` from a `Map<"skills/<name>/<path>", Buffer>` (the rest of an agent's space is ignored). */
export function existingSkillsOf(space) {
  const out = new Map();
  for (const [rel, buf] of space ?? []) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(rel);
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], new Map());
    out.get(m[1]).set(m[2], Buffer.isBuffer(buf) ? buf.toString("utf-8") : String(buf));
  }
  return out;
}

// ---- skillSearch (§4.2): what the Architect says it searched, checked against what the server recorded ----

export const SKILL_VERDICTS = Object.freeze(["used-whole", "used-part", "rejected"]);
const SEARCH_QUERIES_MAX = 10;
const CANDIDATES_MAX = 20;
export const SKILL_SEARCH_MISSING =
  "Adding a skill needs skillSearch before you propose: {queries: [{source, query}] — the searches you ran with research_search, and candidates: [{ref, installs, stars, licence, verdict, why}] — the skills you looked at (verdict used-whole, used-part or rejected, and why), including what you found in skills_installed";

/** `{ skillSearch }` (trimmed) or `{ error }`. Shape only; `checkSkillSearchFacts` compares it with what was recorded. */
export function checkSkillSearch(raw) {
  if (!isPlain(raw)) return fail(SKILL_SEARCH_MISSING);
  if (!Array.isArray(raw.queries) || raw.queries.length < 1 || raw.queries.length > SEARCH_QUERIES_MAX) return fail(`skillSearch.queries must list 1 to ${SEARCH_QUERIES_MAX} searches you ran: {source, query}`);
  const queries = [];
  for (const q of raw.queries) {
    if (!isPlain(q) || typeof q.source !== "string" || !q.source.trim() || typeof q.query !== "string" || !q.query.trim() || q.query.length > 200) return fail("every skillSearch query needs a source and a query (up to 200 characters), as you passed them to research_search");
    queries.push({ source: q.source.trim(), query: q.query.trim() });
  }
  const list = raw.candidates ?? [];
  if (!Array.isArray(list) || list.length > CANDIDATES_MAX) return fail(`skillSearch.candidates can list at most ${CANDIDATES_MAX} skills`);
  const candidates = [];
  for (const c of list) {
    if (!isPlain(c) || typeof c.ref !== "string" || !c.ref.trim() || c.ref.length > 300) return fail("every skillSearch candidate needs a ref (owner/repo@skill, owner/repo, an address or an installed skill's name)");
    if (!SKILL_VERDICTS.includes(c.verdict)) return fail(`The verdict of candidate ${c.ref.slice(0, 60)} must be one of ${SKILL_VERDICTS.join(", ")}`);
    if (typeof c.why !== "string" || !c.why.trim() || c.why.length > 300) return fail(`Candidate ${c.ref.slice(0, 60)} needs a why (1 to 300 characters)`);
    for (const k of ["installs", "stars"]) if (c[k] !== undefined && c[k] !== null && !isNonNegInt(c[k])) return fail(`The ${k} of candidate ${c.ref.slice(0, 60)} must be a whole number or null`);
    if (c.licence !== undefined && c.licence !== null && (typeof c.licence !== "string" || c.licence.length > 60)) return fail(`The licence of candidate ${c.ref.slice(0, 60)} must be text or null`);
    candidates.push({ ref: c.ref.trim(), installs: c.installs ?? null, stars: c.stars ?? null, licence: c.licence ?? null, verdict: c.verdict, why: c.why.trim() });
  }
  return { skillSearch: { queries, candidates } };
}

const searchKey = (s) => `${String(s.source).trim().toLowerCase()}\u0000${wsNorm(s.query).toLowerCase()}`;
const refKey = (r) => String(r).trim().toLowerCase();

/**
 * Facts: every query was run in this task (`searches`: the recorded `{source, query, refs}` of every child session of the root task) and every
 * candidate ref appeared in a recorded result or names a skill on this box (`installed`: skills_installed's rows). A sentence or null.
 */
export function checkSkillSearchFacts(skillSearch, { searches, installed }) {
  const ran = new Set(searches.map(searchKey));
  for (const q of skillSearch.queries) {
    if (!ran.has(searchKey(q))) return `The search "${q.query.slice(0, 60)}" on ${q.source} wasn't searched in this task; run it with research_search first (or list only searches you ran)`;
  }
  const seen = new Set(searches.flatMap((s) => s.refs.map(refKey)));
  for (const row of installed) {
    for (const v of [row.name, row.folder, row.provenance ? `${row.provenance.repo}@${row.name}` : null, row.provenance?.repo]) if (v) seen.add(refKey(v));
  }
  for (const c of skillSearch.candidates) {
    if (!seen.has(refKey(c.ref))) return `The candidate ${c.ref.slice(0, 80)} didn't appear in any search result of this task or among the skills installed on this box; list only skills you saw`;
  }
  return null;
}

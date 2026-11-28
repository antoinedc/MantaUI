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
export const AGENT_SKILL_FILES_MAX = 250; // all of an agent's skill files (a snapshot also holds agent.md: 300 files at most)
export const COPIED_MIN_CHARS = 20; // shorter copied text would occur in any page and proves nothing
export const SKILL_PATH_MAX = 120;
export const SKILL_PATH_DEPTH = 4;
export const GENERATED_FILES = Object.freeze(["SOURCE.md", "LICENSE"]);

/** The licences a skill may be copied under (SPDX ids). Anything else, unknown or missing: write your own and cite the source as research. */
export const COPY_LICENCES = Object.freeze(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0", "CC-BY-4.0", "MPL-2.0"]);
/** These need no notice to travel with the copy; every other allowed licence needs `licenseSourceId`. */
export const NO_NOTICE_LICENCES = Object.freeze(["0BSD", "Unlicense", "CC0-1.0"]);

const OP_KEYS = ["name", "op", "files", "provenance", "installed"];
const INSTALLED_KEYS = ["skill", "taken", "take"];
export const INSTALLED_TAKE_MAX = 100; // paths one part-adoption may name
const FILE_KEYS = ["path", "content", "origin", "sourceId"];
const PROVENANCE_KEYS = ["url", "sourceId", "repo", "ref", "licence", "licenseSourceId", "taken", "registry"];
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const SCRIPT_RE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|mts|cts|rb|pl|ps1|bat|cmd)$/i;
export const SKILL_DESCRIPTION_MAX = 300;
const LAUNDER_RUN = 400; // a written file may not hold a run this long that a fetched page holds verbatim
const LAUNDER_BLOCK = 200;
const wsNorm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
const bytes = (t) => Buffer.byteLength(t, "utf-8");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const normUrl = (u) => String(u ?? "").trim().replace(/#.*$/, "").replace(/\/+$/, "");
/** What copied text is compared under: line endings and trailing spaces are noise; newlines and indentation are not (a shell line must stay the line it was). */
export const normText = (t) => String(t ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
const lower = (t) => String(t ?? "").toLowerCase();

/** `{ repo: "owner/repo", ref|null }` of a github.com page (blob / tree) or a raw.githubusercontent.com file, else null. */
export function parseGithubUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let owner;
  let repo;
  let ref = null;
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    [owner, repo] = parts;
    if ((parts[2] === "blob" || parts[2] === "tree") && parts[3]) ref = parts[3];
  } else if (u.hostname === "raw.githubusercontent.com") {
    [owner, repo] = parts;
    if (parts[2] && parts.length > 3) ref = parts[2];
  } else {
    return null;
  }
  repo = String(repo ?? "").replace(/\.git$/, "");
  if (!owner || !repo || !REPO_RE.test(`${owner}/${repo}`)) return null;
  return { repo: `${owner}/${repo}`, ref };
}
const sameRepoPage = (src, repo) => [src?.url, src?.finalUrl].some((u) => u && lower(parseGithubUrl(u)?.repo) === lower(repo));

/** What each allowed licence's own text holds (on lower-cased, whitespace-collapsed text): a page that says MIT must read like MIT. */
const REDISTRIBUTION = /redistribution and use in source and binary forms, with or without modification, are permitted provided that/;
const LICENCE_TEXT = {
  MIT: (t) => t.includes("permission is hereby granted, free of charge, to any person obtaining a copy"),
  "Apache-2.0": (t) => /apache license,? version 2\.0/.test(t),
  "BSD-2-Clause": (t) => REDISTRIBUTION.test(t) && !t.includes("neither the name of"),
  "BSD-3-Clause": (t) => REDISTRIBUTION.test(t) && t.includes("neither the name of"),
  ISC: (t) => /with or without fee is hereby granted, provided that the above copyright notice/.test(t),
  "0BSD": (t) => /with or without fee is hereby granted\./.test(t),
  Unlicense: (t) => t.includes("this is free and unencumbered software released into the public domain"),
  "CC0-1.0": (t) => /cc0 1\.0 universal/.test(t),
  "CC-BY-4.0": (t) => /attribution 4\.0 international/.test(t),
  "MPL-2.0": (t) => /mozilla public license,? (?:version|v\.?) ?2\.0/.test(t),
};
const holdsLicence = (licence, text) => LICENCE_TEXT[licence]?.(wsNorm(lower(text))) === true;
/** A page that states its licence by id (`license: CC0-1.0`), as a SKILL.md or a README often does. */
const statesLicence = (licence, text) => new RegExp(`licen[sc]e\\s*[:=]\\s*["']?${licence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9.-])`, "i").test(String(text ?? ""));

/** Does a run of LAUNDER_RUN characters of `a` occur verbatim in `b` (both already collapsed)? Aligned blocks find any such run. */
function sharesLongRun(a, b) {
  if (a.length < LAUNDER_RUN) return false;
  for (let i = 0; i + LAUNDER_BLOCK <= a.length; i += LAUNDER_BLOCK) {
    const block = a.slice(i, i + LAUNDER_BLOCK);
    for (let at = b.indexOf(block); at !== -1; at = b.indexOf(block, at + 1)) {
      let l = 0;
      while (i - l - 1 >= 0 && at - l - 1 >= 0 && a[i - l - 1] === b[at - l - 1]) l++;
      let r = 0;
      while (i + LAUNDER_BLOCK + r < a.length && at + LAUNDER_BLOCK + r < b.length && a[i + LAUNDER_BLOCK + r] === b[at + LAUNDER_BLOCK + r]) r++;
      if (l + LAUNDER_BLOCK + r >= LAUNDER_RUN) return true;
    }
  }
  return false;
}

/** The canonical SPDX spelling of an allowed licence, or null. */
export const copyLicenceOf = (licence) => (typeof licence === "string" ? (COPY_LICENCES.find((l) => l.toLowerCase() === licence.trim().toLowerCase()) ?? null) : null);

/** Is this skill file a script (by name or shebang)? The card flags the ones that were copied. */
export const isScriptFile = (path, content = "") => SCRIPT_RE.test(path) || String(content).startsWith("#!");

// ---- SOURCE.md: written by the server, read back for the profile and skills_installed ----

/** `SOURCE.md` for a copied skill: origin link, ref, licence, what was taken, installs / stars at the time. Deterministic (the draft hash covers it). */
export function renderSourceMd(provenance, { copied = [], written = [], left = [] } = {}) {
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
    ...(left.length > 0 ? [`- Left out: ${left.join(", ")}`] : []),
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
      if (o.installed !== undefined) return fail(`A remove of skill ${o.name} takes no installed`);
      ops.push({ name: o.name, op: "remove", files: [], provenance: null });
      continue;
    }
    if (o.installed !== undefined) {
      // a skill already installed on this box, taken by reference: the server copies its files, so no file or provenance comes from the model
      if (o.files !== undefined) return fail(`Skill ${o.name}: give either files or installed, not both (an installed skill's files are copied by the server)`);
      if (o.provenance !== undefined) return fail(`Skill ${o.name}: an installed skill takes no provenance (the server writes SOURCE.md from the installed folder)`);
      const inst = checkInstalledSpec(o.installed, o.name);
      if (inst.error) return inst;
      ops.push({ name: o.name, op: o.op, files: [], provenance: null, installed: inst.installed });
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
      if (GENERATED_FILES.some((g) => lower(g) === lower(f.path))) return fail(`Skill ${o.name}: ${f.path} is written by the server; don't send it`);
      if (files.some((x) => lower(x.path) === lower(f.path))) return fail(`Skill ${o.name} has the file ${f.path} twice (paths are compared without regard to case)`);
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
    if (h.description.length > SKILL_DESCRIPTION_MAX) return fail(`The description of skill ${o.name} is ${h.description.length} characters; at most ${SKILL_DESCRIPTION_MAX}`);
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

/** `{ installed: { skill, taken, take } }` (trimmed) or `{ error }`: the shape of an installed-skill reference. */
function checkInstalledSpec(raw, name) {
  const who = `The installed of skill ${name}`;
  if (!isPlain(raw)) return fail(`${who} must be {skill, taken, take?}: skill is the name or folder skills_installed lists, taken is "whole" or "part"`);
  for (const k of Object.keys(raw)) if (!INSTALLED_KEYS.includes(k)) return fail(`Unknown field "${k}" in the installed of skill ${name}`);
  if (typeof raw.skill !== "string" || raw.skill.trim() === "" || raw.skill.length > 400) return fail(`${who}: skill must be the name or folder of a skill skills_installed lists`);
  if (raw.taken !== "whole" && raw.taken !== "part") return fail(`${who}: taken must be "whole" or "part"`);
  if (raw.taken === "whole") {
    if (raw.take !== undefined) return fail(`${who}: take goes with taken "part" (it lists what to take); a whole skill takes everything`);
    return { installed: { skill: raw.skill.trim(), taken: "whole", take: null } };
  }
  if (!Array.isArray(raw.take) || raw.take.length === 0 || raw.take.length > INSTALLED_TAKE_MAX) return fail(`${who}: taken "part" needs take, 1 to ${INSTALLED_TAKE_MAX} paths (files or folders of the skill, e.g. ["reference"]; SKILL.md is always taken)`);
  const take = [];
  for (const t of raw.take) {
    const bad = typeof t === "string" ? checkPath(t) : "a path must be text";
    if (bad) return fail(`${who}: ${bad} (got ${JSON.stringify(String(t).slice(0, 60))})`);
    if (!take.includes(t)) take.push(t);
  }
  return { installed: { skill: raw.skill.trim(), taken: "part", take } };
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

// ---- adopting a skill that is already installed on this box ----

const MODEST_VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;
/** The licence an installed skill declares, in order of trust: its SOURCE.md (ours, written when it was copied), its SKILL.md frontmatter. */
const declaredLicence = (sourceMd, fm) => {
  if (sourceMd?.licence) return sourceMd.licence;
  for (const k of ["license", "licence"]) if (typeof fm?.[k] === "string" && fm[k].trim()) return fm[k].trim();
  return "";
};
/** The allowed licence whose own text a licence file holds, or null. */
const detectLicence = (text) => COPY_LICENCES.find((l) => holdsLicence(l, text)) ?? null;
/** `owner/repo` from a frontmatter's repository / repo field (an address or the short form), or null. */
function repoFromFrontmatter(fm) {
  const v = fm?.repository ?? fm?.repo;
  const raw = typeof v === "string" ? v : typeof v?.url === "string" ? v.url : "";
  if (!raw) return null;
  if (REPO_RE.test(raw.trim())) return raw.trim();
  return parseGithubUrl(raw.trim().replace(/^git\+/, ""))?.repo ?? null;
}
const versionFromFrontmatter = (fm) => {
  const v = fm?.version ?? fm?.metadata?.version;
  const t = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return MODEST_VERSION_RE.test(t) ? t : null;
};

/** Left-out report for a part-adoption: a whole folder when nothing of it was taken, else the single files that were not. Short. */
function leftOutOf(all, taken) {
  const takenSet = new Set(taken);
  const by = new Map();
  for (const p of all) {
    const top = p.includes("/") ? p.slice(0, p.indexOf("/")) : p;
    (by.get(top) ?? by.set(top, []).get(top)).push(p);
  }
  const out = [];
  for (const [top, paths] of [...by].sort((a, b) => cmp(a[0], b[0]))) {
    const left = paths.filter((p) => !takenSet.has(p));
    if (left.length === 0) continue;
    if (left.length === paths.length) out.push(top);
    else out.push(...left.sort(cmp));
  }
  return out.length > 12 ? [...out.slice(0, 12), `… (${out.length - 12} more)`] : out;
}

/**
 * The files, provenance and notice of an installed skill the server read (`got`: { files: Map<path, text>, all, licenceText, sourceMd } from the
 * installed folder), or `{ error }`. Facts only: the same path, case-folding and size protections as a skill the model sends (the per-skill
 * 20-file / 256 KiB caps bound what a MODEL has to type out, and nothing is typed here, so only the agent-wide 250 files / 1 MiB apply), a
 * SKILL.md with a frontmatter naming the skill, and a licence that allows copying — from the skill's own SOURCE.md or frontmatter, else its
 * licence file. `{ files: [{path, content}], provenance, licenceText, left }`.
 */
function adoptInstalled(o, got, { header, frontmatter }) {
  const spec = o.installed;
  const who = `Skill ${o.name}`;
  const hint = ` Take part of it instead: taken "part" with take listing what fits (SKILL.md is always taken); scripts and long references are the usual things to leave out`;
  const files = [];
  for (const [path, content] of got.files) {
    const bad = checkPath(path);
    if (bad) return fail(`${who}: ${bad} (the installed skill has ${JSON.stringify(path.slice(0, 60))}).${hint}`);
    if (GENERATED_FILES.some((g) => lower(g) === lower(path))) continue; // written by the server
    if (files.some((x) => lower(x.path) === lower(path))) return fail(`${who}: the installed skill has the file ${path} twice (paths are compared without regard to case).${hint}`);
    files.push({ path, content });
  }
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) return fail(`${who}: the installed skill has no SKILL.md`);
  const h = header(md.content);
  if (!h) return fail(`The SKILL.md of the installed skill ${o.name} has no frontmatter with name and description`);
  if (h.name !== o.name) return fail(`The installed skill's own name is ${JSON.stringify(h.name ?? "")}: name the skill ${h.name || "after its folder"} (${who} says ${o.name})`);
  if (!h.description) return fail(`The SKILL.md of the installed skill ${o.name} needs a description in its frontmatter`);
  if (h.description.length > SKILL_DESCRIPTION_MAX) return fail(`The description of the installed skill ${o.name} is ${h.description.length} characters; at most ${SKILL_DESCRIPTION_MAX}`);
  const size = files.reduce((n, f) => n + bytes(f.content), 0);
  if (size > AGENT_SKILLS_BYTES_MAX) return fail(`${who} is ${(size / 1024 / 1024).toFixed(1)} MiB; an agent's skills can total at most 1 MiB.${hint}`);
  if (files.length > AGENT_SKILL_FILES_MAX) return fail(`${who} has ${files.length} files; an agent's skills can hold at most ${AGENT_SKILL_FILES_MAX}.${hint}`);
  // the licence: declared by the skill itself, else read from its licence file; it must allow copying and agree with the licence file
  const fm = frontmatter(md.content) ?? {};
  const carried = parseSourceMd(got.sourceMd);
  const declared = declaredLicence(carried, fm);
  const fromFile = got.licenceText ? detectLicence(got.licenceText) : null;
  const licence = declared ? copyLicenceOf(declared) : fromFile;
  if (!licence) {
    const given = declared ? JSON.stringify(declared.slice(0, 60)) : "none stated";
    return fail(`${who}: the installed skill's licence (${given}) doesn't allow copying; write your own and cite what you learned as research. Copying is allowed under ${COPY_LICENCES.join(", ")}. Its frontmatter (license: <id>), its SOURCE.md or its licence file has to say which`);
  }
  if (declared && fromFile && fromFile !== licence) return fail(`${who}: the installed skill says ${licence} but its licence file is ${fromFile}; it can't be copied until that agrees`);
  const left = spec.taken === "part" ? leftOutOf(got.all, files.map((f) => f.path)) : [];
  const repo = carried?.repo && carried.repo !== "unknown" ? carried.repo : repoFromFrontmatter(fm) ?? "unknown";
  const ref = carried?.ref && carried.ref !== "unknown" ? carried.ref : versionFromFrontmatter(fm) ?? "unknown";
  const url = carried && /^https:\/\/[^\s]+$/.test(carried.url) ? carried.url : `installed on this box: ${o.name}`;
  const provenance = { url, sourceId: `installed:${o.name}`, repo, ref, licence, taken: spec.taken, ...(carried?.registry ? { registry: carried.registry } : {}) };
  return { files, provenance, licenceText: typeof got.licenceText === "string" && got.licenceText ? got.licenceText : null, left };
}

/**
 * The complete resulting `skills/**` set and the card's diff. `existing`: `Map<skillName, Map<relPath, string>>` (what the agent has now;
 * empty for a new agent). `fetchSource(sourceId)` → the stored source of THIS task (any of its rounds) or null; `listSources()` → every
 * source this task fetched (`{id, text}`), asked only when a written file is long enough to be checked. `ops`: from `checkSkillOps`.
 * `readInstalled(spec)` → what the server read of an installed skill (see `adoptInstalled`) or `{ error }`; `header` / `frontmatter` read a SKILL.md.
 * `{ files: Map<"skills/<name>/<path>", text>, diff }` or `{ error }`.
 */
export async function planSkills({ ops, existing, fetchSource, listSources = null, readInstalled = null, header = null, frontmatter = null }) {
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
    let adopted = null;
    if (o.installed) {
      if (!readInstalled || !header || !frontmatter) return fail(`Skill ${o.name}: installed skills can't be read here`);
      const got = await readInstalled(o.installed);
      if (!got || got.error) return fail(`Skill ${o.name}: ${got?.error ?? "the installed skill couldn't be read"}`);
      adopted = adoptInstalled(o, got, { header, frontmatter });
      if (adopted.error) return adopted;
    }
    const skillFiles = adopted ? adopted.files.map((f) => ({ ...f, origin: "copied" })) : o.files;
    // copied files: their provenance is tied to the text (the page, its repository, the commit in its url, its licence), and each file
    // is a contiguous piece of a public page of that repository this task fetched
    const copiedFiles = adopted ? [] : o.files.filter((f) => f.origin === "copied");
    const copiedPaths = copiedFiles.map((f) => f.path);
    const cache = new Map();
    const source = async (id) => {
      if (!cache.has(id)) cache.set(id, (await fetchSource(id)) ?? null);
      return cache.get(id);
    };
    let provenance = adopted ? adopted.provenance : null;
    let licenceText = adopted ? adopted.licenceText : null;
    if (copiedFiles.length > 0) {
      const shaped = checkProvenanceShape(o.provenance, o.name);
      if (shaped.error) return shaped;
      const p = shaped.provenance;
      const page = await source(p.sourceId);
      if (!page || typeof page.text !== "string") return fail(unfetched(p.sourceId));
      if (page.private === true) return fail(`Skill ${o.name}: provenance.sourceId is a private source; cite a public page`);
      const urls = [page.url, page.finalUrl].filter(Boolean).map(normUrl);
      if (!urls.includes(normUrl(p.url))) return fail(`The provenance url of skill ${o.name} doesn't match the page source ${p.sourceId} was fetched from (${urls[0] ?? "no address"}); give that page's address as url`);
      // the repository (and the commit, when the address names one) come from the address, never from what the model says
      const gh = parseGithubUrl(p.url);
      if (!gh) return fail(`The provenance url of skill ${o.name} must be a page on github.com (or raw.githubusercontent.com) of the repository the skill is in`);
      if (lower(p.repo) !== lower(gh.repo)) return fail(`The provenance repo of skill ${o.name} (${p.repo}) isn't the repository its url points to (${gh.repo})`);
      if (gh.ref && p.ref !== gh.ref) return fail(`The provenance ref of skill ${o.name} (${p.ref}) isn't the ref its url names (${gh.ref}); copy it from the address`);
      p.repo = gh.repo;
      p.ref = gh.ref ?? p.ref;
      const lic = checkLicence(p, o.name);
      if (lic.error) return lic;
      p.licence = lic.licence;
      if (p.licenseSourceId) {
        const l = await source(p.licenseSourceId);
        if (!l || typeof l.text !== "string") return fail(unfetched(p.licenseSourceId));
        if (l.private === true) return fail(`Skill ${o.name}: provenance.licenseSourceId is a private source; cite a public page`);
        if (!sameRepoPage(l, p.repo)) return fail(`Skill ${o.name}: the licence page ${p.licenseSourceId} isn't a page of the same repository as the skill (${p.repo})`);
        if (!holdsLicence(p.licence, l.text)) return fail(`Skill ${o.name}: the licence page ${p.licenseSourceId} doesn't hold the text of ${p.licence}; fetch the repository's own licence file`);
        licenceText = l.text;
      } else if (!holdsLicence(p.licence, page.text) && !statesLicence(p.licence, page.text)) {
        return fail(`Skill ${o.name}: nothing fetched from ${p.repo} states the ${p.licence} licence; fetch its licence file and pass the source id as provenance.licenseSourceId`);
      }
      provenance = p;
      for (const f of copiedFiles) {
        if (wsNorm(f.content).length < COPIED_MIN_CHARS) return fail(`Skill ${o.name}: ${f.path} is copied but too short (under ${COPIED_MIN_CHARS} characters) to show where it came from; write it instead`);
        const src = f.sourceId === p.sourceId ? page : await source(f.sourceId);
        if (!src || typeof src.text !== "string") return fail(unfetched(f.sourceId));
        if (src.private === true) return fail(`Skill ${o.name}: ${f.path} would be copied from a private source (${f.sourceId}); private sources never appear in an agent's files`);
        if (f.sourceId !== p.sourceId && !sameRepoPage(src, p.repo)) return fail(`Skill ${o.name}: ${f.path} was copied from a page (${f.sourceId}) that isn't of the same repository as the provenance (${p.repo}); one skill is taken from one repository`);
        if (!normText(src.text).includes(normText(f.content))) return fail(`The text of ${o.name}/${f.path} doesn't occur in source ${f.sourceId}; copy only text you fetched, exactly (line endings and trailing spaces may differ; newlines, indentation and case may not)`);
      }
    }
    // a written file is the Architect's own: a long run that a page it fetched holds verbatim is copied text under the wrong label
    const writtenLong = o.files.filter((f) => f.origin === "written" && wsNorm(f.content).length >= LAUNDER_RUN);
    if (writtenLong.length > 0) {
      const pages = (await listSources?.()) ?? [];
      for (const f of writtenLong) {
        const mine = wsNorm(f.content);
        const hit = pages.find((pg) => typeof pg?.text === "string" && sharesLongRun(mine, wsNorm(pg.text)));
        if (hit) return fail(`Skill ${o.name}: ${f.path} holds a passage of ${LAUNDER_RUN} or more characters that is verbatim in a page you fetched (${hit.id}); if it is copied, label it copied with provenance, otherwise write it in your own words`);
      }
    }
    const now = new Map(skillFiles.map((f) => [f.path, f.content]));
    if (provenance) {
      now.set("SOURCE.md", renderSourceMd(provenance, { copied: adopted ? skillFiles.map((f) => f.path) : copiedPaths, written: skillFiles.filter((f) => f.origin === "written").map((f) => f.path), left: adopted?.left ?? [] }));
      if (licenceText !== null) now.set("LICENSE", licenceText);
    }
    const size = [...now.values()].reduce((n, t) => n + bytes(t), 0);
    // (an installed skill is copied by the server, not typed by the model: the agent-wide caps below are its limits)
    if (!adopted && size > SKILL_BYTES_MAX) return fail(`Skill ${o.name} is ${Math.ceil(size / 1024)} KiB; a skill can be at most 256 KiB`);
    result.set(o.name, now);
    const paths = [...new Set([...now.keys(), ...(had ? had.keys() : [])])].filter((p) => (had?.get(p) ?? null) !== (now.get(p) ?? null)).sort(cmp);
    diff.push({
      name: o.name,
      op: o.op,
      paths,
      provenance,
      // every script among the changed files, whoever wrote it: an agent with a shell can run what it finds
      scripts: skillFiles.filter((f) => paths.includes(f.path) && isScriptFile(f.path, f.content)).map((f) => f.path).sort(cmp),
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

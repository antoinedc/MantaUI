// architectSources.mjs — the extra research sources of the Architect (Agents Phase 5A, spec
// docs/superpowers/specs/2026-11-24-agents-phase5-builder.md §4.3a), as pure functions shared by the box (validation,
// execution) and the renderer (the change card's source blocks). No I/O.
//
// A source lives in the Architect's own agent.md frontmatter (`sources:`). Exactly one of `command` (an argv template run
// without a shell) or `url` (a literal https origin + path with one `{query}` query value). Credentials are never written
// into a source: `{secret:NAME}` references (env / header values only) are resolved from the shared secrets at run time.

import { parse as parseYaml, parseDocument, visit } from "yaml";

export const SOURCE_ID_RE = /^[a-z][a-z0-9-]{0,29}$/;
export const BASE_SOURCE_IDS = Object.freeze(["hn", "arxiv", "reddit", "x", "web"]);
export const SOURCES_MAX = 10;
export const SOURCE_NAME_MAX = 60;
export const SOURCE_DESCRIPTION_MAX = 300;
export const QUERY_MAX = 200;
export const QUERY_TOKEN = "{query}";
export const SECRET_REF_RE = /\{secret:([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
const SECRET_REF_ONE = "\\{secret:[A-Za-z_][A-Za-z0-9_]{0,63}\\}";
const SOURCE_KEYS = ["id", "name", "description", "private", "command", "url", "headers", "env"];
const FORBIDDEN_HEADERS = ["host", "cookie", "forwarded", "content-length", "transfer-encoding", "connection"];
const FORBIDDEN_ENV = ["PATH", "HOME"];
const CREDENTIAL_PARAMS = ["key", "api_key", "apikey", "token", "access_token", "secret", "password", "auth"];
const CREDENTIAL_OPTION_RE = /^(?:--token|--api-key|--apikey|--password|--passwd|--secret|-p)(?:=[\s\S]*)?$/i;
export const CREDENTIAL_HINT = "Put this value in Secrets and use {secret:NAME} in a header or env value";

const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const refsOf = (s) => [...String(s).matchAll(SECRET_REF_RE)].map((m) => m[1]);
const stripRefs = (s) => String(s).replace(SECRET_REF_RE, "");

/** Is a header name one that carries a credential (its value must be only a reference)? */
export function isCredentialHeader(name) {
  const n = String(name).toLowerCase();
  return n === "authorization" || n === "proxy-authorization" || n === "x-api-key" || n === "api-key" || n.endsWith("-token");
}

/** Is an environment variable name one that carries a credential? */
export function isCredentialEnv(name) {
  return /TOKEN|KEY|SECRET|PASSWORD/i.test(String(name));
}

const onlyReference = (value) => new RegExp(`^(?:(?:Bearer|Token|Basic) )?${SECRET_REF_ONE}$`).test(String(value));

/**
 * Validate ONE source's shape. `{ ok:true, source }` (normalised: `private` is always a boolean, default true) or
 * `{ ok:false, error }`, a sentence. Pure: it cannot know whether a literal is a credential (see `credentialLiterals`).
 */
export function validateSource(raw) {
  const bad = (error) => ({ ok: false, error });
  if (!isPlain(raw)) return bad("A source must be a set of key: value lines");
  const label = typeof raw.id === "string" && raw.id ? `source "${raw.id}"` : "a source";
  for (const k of Object.keys(raw)) if (!SOURCE_KEYS.includes(k)) return bad(`${label}: unknown key "${k}"`);
  if (typeof raw.id !== "string" || !SOURCE_ID_RE.test(raw.id)) return bad(`${label}: the id must be lowercase letters, digits and dashes (at most 30)`);
  if (BASE_SOURCE_IDS.includes(raw.id)) return bad(`${label}: "${raw.id}" is a built-in source id`);
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > SOURCE_NAME_MAX || CONTROL_RE.test(raw.name)) {
    return bad(`${label}: the name must be one line of at most ${SOURCE_NAME_MAX} characters`);
  }
  if (typeof raw.description !== "string" || !raw.description.trim() || raw.description.trim().length > SOURCE_DESCRIPTION_MAX || CONTROL_RE.test(raw.description)) {
    return bad(`${label}: the description must be one line of at most ${SOURCE_DESCRIPTION_MAX} characters`);
  }
  if (raw.private !== undefined && typeof raw.private !== "boolean") return bad(`${label}: private must be true or false`);
  const hasCommand = raw.command !== undefined && raw.command !== null;
  const hasUrl = raw.url !== undefined && raw.url !== null;
  if (hasCommand === hasUrl) return bad(`${label}: give exactly one of command or url`);
  const source = {
    id: raw.id,
    name: raw.name.trim(),
    description: raw.description.trim(),
    private: raw.private === undefined ? true : raw.private,
  };

  const checkValues = (obj, kind) => {
    const entries = Object.entries(obj);
    if (entries.length > 20) return `${label}: at most 20 ${kind}`;
    for (const [k, v] of entries) {
      if (typeof v !== "string" || v.length > 500 || CONTROL_RE.test(v)) return `${label}: the ${kind === "headers" ? "header" : "variable"} "${k}" must be one line of at most 500 characters`;
    }
    return null;
  };

  if (hasCommand) {
    if (raw.headers !== undefined && raw.headers !== null) return bad(`${label}: headers go with a url source; a command source uses env`);
    const cmd = raw.command;
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > 30) return bad(`${label}: the command must be a list of 1 to 30 words`);
    for (const el of cmd) {
      if (typeof el !== "string" || !el || el.length > 500 || CONTROL_RE.test(el)) return bad(`${label}: every word of the command must be non-empty text on one line`);
    }
    const [program, ...rest] = cmd;
    if (program.includes(QUERY_TOKEN)) return bad(`${label}: ${QUERY_TOKEN} can't be part of the program name`);
    if (program.startsWith("~") || (program.includes("/") && !program.startsWith("/"))) {
      return bad(`${label}: the program must be a bare name or an absolute path`);
    }
    if (refsOf(cmd.join("\n")).length > 0) return bad(`${label}: {secret:…} is only allowed in env and header values; ${CREDENTIAL_HINT}`);
    const at = rest.filter((el) => el.includes(QUERY_TOKEN));
    if (at.length !== 1 || at[0] !== QUERY_TOKEN || rest.join("\n").split(QUERY_TOKEN).length !== 2) {
      return bad(`${label}: ${QUERY_TOKEN} must appear exactly once, as a whole word of the command`);
    }
    for (const el of rest) {
      if (el !== QUERY_TOKEN && CREDENTIAL_OPTION_RE.test(el)) return bad(`${label}: ${CREDENTIAL_HINT}`);
    }
    source.command = cmd.slice();
    if (raw.env !== undefined && raw.env !== null) {
      if (!isPlain(raw.env)) return bad(`${label}: env must be a set of NAME: value lines`);
      const err = checkValues(raw.env, "variables");
      if (err) return bad(err);
      const env = {};
      for (const [k, v] of Object.entries(raw.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) return bad(`${label}: "${k}" isn't a valid variable name`);
        if (FORBIDDEN_ENV.includes(k.toUpperCase()) || /^(?:LD_|DYLD_)/i.test(k)) return bad(`${label}: the variable ${k} can't be set`);
        if (isCredentialEnv(k) && !onlyReference(v)) return bad(`${label}: ${CREDENTIAL_HINT}`);
        env[k] = v;
      }
      if (Object.keys(env).length > 0) source.env = env;
    }
    return { ok: true, source };
  }

  if (raw.env !== undefined && raw.env !== null) return bad(`${label}: env goes with a command source; a url source uses headers`);
  const url = raw.url;
  if (typeof url !== "string" || !url || url.length > 1000 || CONTROL_RE.test(url) || /\s/.test(url)) return bad(`${label}: the url must be one https address`);
  if (refsOf(url).length > 0) return bad(`${label}: {secret:…} is only allowed in env and header values; ${CREDENTIAL_HINT}`);
  if (url.split(QUERY_TOKEN).length !== 2) return bad(`${label}: ${QUERY_TOKEN} must appear exactly once in the url`);
  if (url.includes("#")) return bad(`${label}: the url can't have a fragment`);
  const q = url.indexOf("?");
  if (q < 0 || url.slice(0, q).includes(QUERY_TOKEN)) return bad(`${label}: ${QUERY_TOKEN} must be the whole value of one query parameter`);
  const params = url.slice(q + 1).split("&");
  const holder = params.filter((p) => p.includes(QUERY_TOKEN));
  const eq = holder[0]?.indexOf("=") ?? -1;
  if (holder.length !== 1 || eq <= 0 || holder[0].slice(eq + 1) !== QUERY_TOKEN) {
    return bad(`${label}: ${QUERY_TOKEN} must be the whole value of one query parameter`);
  }
  let parsed;
  try {
    parsed = new URL(url.replace(QUERY_TOKEN, "q"));
  } catch {
    return bad(`${label}: the url isn't a valid address`);
  }
  if (parsed.protocol !== "https:") return bad(`${label}: the url must start with https://`);
  if (parsed.username || parsed.password) return bad(`${label}: the url can't contain a username or password; ${CREDENTIAL_HINT}`);
  for (const p of params) {
    const name = decodeURIComponentSafe(p.split("=")[0]).toLowerCase();
    if (CREDENTIAL_PARAMS.includes(name)) return bad(`${label}: ${CREDENTIAL_HINT}`);
  }
  source.url = url;
  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isPlain(raw.headers)) return bad(`${label}: headers must be a set of Name: value lines`);
    const err = checkValues(raw.headers, "headers");
    if (err) return bad(err);
    const headers = {};
    for (const [k, v] of Object.entries(raw.headers)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) return bad(`${label}: "${k}" isn't a valid header name`);
      const n = k.toLowerCase();
      if (FORBIDDEN_HEADERS.includes(n) || n.startsWith("x-forwarded-")) return bad(`${label}: the header ${k} can't be set`);
      if (isCredentialHeader(k) && !onlyReference(v)) return bad(`${label}: ${CREDENTIAL_HINT}`);
      headers[k] = v;
    }
    if (Object.keys(headers).length > 0) source.headers = headers;
  }
  return { ok: true, source };
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return String(s);
  }
}

/** A draft's `sources`: every entry must be valid and the ids unique. `{ ok:true, sources }` or `{ ok:false, error }`. */
export function validateSourceList(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: "sources must be a list" };
  if (raw.length > SOURCES_MAX) return { ok: false, error: `At most ${SOURCES_MAX} sources` };
  const sources = [];
  for (const entry of raw) {
    const r = validateSource(entry);
    if (!r.ok) return r;
    if (sources.some((s) => s.id === r.source.id)) return { ok: false, error: `Two sources share the id "${r.source.id}"` };
    sources.push(r.source);
  }
  return { ok: true, sources };
}

/**
 * The sources of a parsed frontmatter value: the valid entries (the first of a repeated id; none past the 10th) plus one
 * note per skipped entry, so the Architect's row can say what was ignored. Never throws.
 */
export function parseSourceList(raw) {
  const sources = [];
  const notes = [];
  if (raw === undefined || raw === null) return { sources, notes };
  if (!Array.isArray(raw)) return { sources, notes: ["sources must be a list; none were loaded"] };
  raw.forEach((entry, i) => {
    const r = validateSource(entry);
    if (!r.ok) {
      notes.push(`Skipped a source: ${r.error}`);
      return;
    }
    if (sources.some((s) => s.id === r.source.id)) {
      notes.push(`Skipped a source: two sources share the id "${r.source.id}"`);
      return;
    }
    if (sources.length >= SOURCES_MAX) {
      notes.push(`Skipped source ${i + 1}: at most ${SOURCES_MAX} sources are used`);
      return;
    }
    sources.push(r.source);
  });
  return { sources, notes };
}

/** Does a YAML text use an anchor or an alias anywhere? */
export function hasYamlAliases(yamlText) {
  let found = false;
  try {
    const doc = parseDocument(String(yamlText ?? ""));
    visit(doc, {
      Alias() {
        found = true;
        return visit.BREAK;
      },
      Node(_key, node) {
        if (node.anchor) {
          found = true;
          return visit.BREAK;
        }
        return undefined;
      },
    });
  } catch {
    return false;
  }
  return found;
}

const FRONT_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * The sources an agent.md declares: `{ sources, notes, refused }`. `refused: true` = the file uses YAML anchors or aliases
 * (the whole file is refused, so a source can't be hidden behind one). A file without frontmatter has no sources.
 */
export function sourcesOfAgentMd(text) {
  const m = FRONT_RE.exec(String(text ?? "").replace(/^\uFEFF/, ""));
  if (!m) return { sources: [], notes: [], refused: false };
  if (hasYamlAliases(m[1])) return { sources: [], notes: ["The file uses YAML anchors or aliases, which aren't allowed"], refused: true };
  let data;
  try {
    data = parseYaml(m[1]);
  } catch {
    return { sources: [], notes: [], refused: false };
  }
  if (!isPlain(data)) return { sources: [], notes: [], refused: false };
  return { ...parseSourceList(data.sources), refused: false };
}

/**
 * The literal text of a source that could hold a credential, with `{secret:…}` references removed: every command word
 * (but the query), the URL, and the values of every header and variable that is NOT a credential field (a credential field
 * is already known to be only a reference). The server runs the secret scanner over each.
 */
export function credentialLiterals(source) {
  const out = [];
  if (Array.isArray(source.command)) for (const el of source.command.slice(1)) if (el !== QUERY_TOKEN) out.push(el);
  if (typeof source.url === "string") {
    const [path, query = ""] = source.url.split("?");
    out.push(path);
    for (const p of query.split("&")) {
      const eq = p.indexOf("=");
      const value = eq >= 0 ? p.slice(eq + 1) : "";
      if (value !== QUERY_TOKEN && value) out.push(decodeURIComponentSafe(value));
      if (eq >= 0) out.push(p.slice(0, eq));
    }
  }
  for (const [k, v] of Object.entries(source.headers ?? {})) if (!isCredentialHeader(k)) out.push(stripRefs(v));
  for (const [k, v] of Object.entries(source.env ?? {})) if (!isCredentialEnv(k)) out.push(stripRefs(v));
  return out.filter((s) => s.trim().length > 0);
}

/** The names of every secret a source references. */
export function secretNamesOf(source) {
  const names = [...Object.values(source.headers ?? {}), ...Object.values(source.env ?? {})].flatMap(refsOf);
  return [...new Set(names)];
}

const quoteWord = (w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) || w === QUERY_TOKEN ? w : JSON.stringify(w));

/** What a source does, for the change card: `{ id, name, kind, runs, secrets, private, line }`. */
export function describeSource(source) {
  const secrets = secretNamesOf(source);
  if (Array.isArray(source.command)) {
    const runs = source.command.map(quoteWord).join(" ");
    return {
      id: source.id,
      name: source.name,
      kind: "command",
      runs,
      host: null,
      secrets,
      private: source.private !== false,
      line: `Runs ${runs} on this box with your account's access. Manta passes the query as one argument, without a shell; the program decides what it means.`,
    };
  }
  let host = "";
  try {
    host = new URL(String(source.url).replace(QUERY_TOKEN, "q")).host;
  } catch {
    host = String(source.url);
  }
  return { id: source.id, name: source.name, kind: "url", runs: source.url, host, secrets, private: source.private !== false, line: `Calls ${host}` };
}

export const PRIVATE_SENTENCE =
  "Private: results go to the AI model and its local transcript, and may be repeated in what the Architect writes or searches; only the quote and link on cards are hidden";
export const PRIVATE_TO_PUBLIC_SENTENCE = "Private → Public: future evidence may show quotes and links";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a change does to the Architect's sources: one row per added, changed or removed source —
 * `{ change: "added" | "changed" | "removed", source, privateToPublic }` (a removed row carries the old source).
 */
export function diffSources(before, after) {
  const was = new Map((before ?? []).map((s) => [s.id, s]));
  const rows = [];
  for (const s of after ?? []) {
    const old = was.get(s.id);
    if (!old) rows.push({ change: "added", source: s, privateToPublic: false });
    else if (!same(old, s)) rows.push({ change: "changed", source: s, privateToPublic: old.private !== false && s.private === false });
    was.delete(s.id);
  }
  for (const old of was.values()) rows.push({ change: "removed", source: old, privateToPublic: false });
  return rows;
}

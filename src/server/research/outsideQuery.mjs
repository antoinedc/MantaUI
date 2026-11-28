// outsideQuery.mjs — the ONE check every outgoing request to an outside destination passes (research layer spec
// docs/superpowers/specs/2026-11-28-research-layer.md AC-2.8, §6.3a). Covered callers: `research_search` to an outside source,
// `research_fetch`, OpenCode's built-in `websearch` (its `query`) and `webfetch` (its `url`) through the plugin's
// `execute.before` hook — they all call `check` before any network request is made.
//
// What is checked is the WHOLE query text or the WHOLE URL (user-info, host, every path segment, every query name and value,
// the fragment; each percent-decoded, `+` read as a space), for: (a) a secret in the Secrets store or anything the secret
// scanner flags, (b) an absolute file path or a path under the task's / chat's folder, (c) an e-mail address, (d) a private
// network address or an internal host name, (e) 6+ consecutive words copied from a private source's answer stored in this
// task or chat. A refusal is a fixed sentence and is recorded as `{ kind, tool }` — never the text. It FAILS CLOSED: any
// failure to check (the secrets store, the scanner, a reader, a malformed request) is a refusal of its own.
//
// The destination host of a URL is exempt from the private-ADDRESS test only (an IP literal is never sent to a resolver, so it
// reveals nothing to an outsider); an internal host NAME as the destination is refused, since the name would go to a public resolver.
//
// Pure + injected I/O, like the other engines. The mechanical check catches the clear cases; paraphrases are the rule's job.

import { createSecretScanner, MIN_SECRET_LENGTH } from "../knowledge/secretScan.mjs";

export const OUTSIDE_REFUSAL = "This query would send private material to an outside source; rephrase it in general terms, or use a private source";
export const CHECK_UNAVAILABLE = "Couldn't check this query for private material; try again";
export const VERBATIM_WORDS = 6;
const PRIVATE_TEXT_MAX = 400_000; // characters of one private answer compared against
const FOLDER_MIN = 4;

const TOOLS = new Set(["websearch", "webfetch", "research_search", "research_fetch"]);

class Unavailable extends Error {}

// ---- text detectors: each returns true when the text carries that kind of material ----

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const ABS_PATH_RE = /(?:^|[\s"'`(\[{=,;:<>|])(?:~\/|\/(?:home|root|etc|usr|var|tmp|opt|mnt|srv|Users|Volumes|proc|private|workspace)\b|\/[\w.@+-]+\/[\w.@+-]+|[A-Za-z]:[\\/][\w.-])/;
const INTERNAL_HOST_RE = /(?:^|[^a-z0-9.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:local|internal|lan|corp|home\.arpa)(?![a-z0-9-])/i;
const IPV4_RE = /(?:^|[^0-9.])((?:\d{1,3}\.){3}\d{1,3})(?![0-9])/g;
const IPV6_RE = /(?:^|[^0-9a-f:])(?:\[?::1\]?(?![0-9a-f:])|(?:fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):[0-9a-f:]*[0-9a-f])/i;

const isPrivateV4 = (ip) => {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return o[0] === 10 || o[0] === 127 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254);
};

function hasPrivateAddress(text) {
  for (const m of text.matchAll(IPV4_RE)) if (isPrivateV4(m[1])) return true;
  return IPV6_RE.test(text);
}

/** The kinds of material one piece of free text carries (the (b)-(d) detectors; secrets and verbatim text are checked on the whole). */
function textKinds(text, { homeRun = false } = {}) {
  const kinds = [];
  if (ABS_PATH_RE.test(text) || (homeRun && /^\/?(?:home|Users|Volumes)\//.test(text))) kinds.push("path");
  if (EMAIL_RE.test(text)) kinds.push("email");
  if (INTERNAL_HOST_RE.test(text) || hasPrivateAddress(text)) kinds.push("network");
  return kinds;
}

const decode = (s) => {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch {
    return String(s);
  }
};
const words = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Every piece of free text a URL carries, decoded; `host` and `destination` are what the request is sent to. */
function splitUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const pieces = [];
  const userinfo = `${u.username}${u.password ? `:${u.password}` : ""}`;
  if (userinfo) pieces.push({ text: decode(userinfo), kind: "userinfo" });
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const segments = u.pathname.split("/").filter((s) => s !== "").map(decode);
  const params = [];
  for (const part of u.search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    params.push(decode(eq < 0 ? part : part.slice(0, eq)));
    if (eq >= 0) params.push(decode(part.slice(eq + 1)));
  }
  const fragment = u.hash ? decode(u.hash.replace(/^#/, "")) : "";
  return { host, userinfo: pieces[0]?.text ?? "", segments, params, fragment, decodedWhole: decode(raw), decodedPath: segments.join("/") };
}

/**
 * @param {object} deps
 * @param {()=>Promise<object[]>} deps.loadSecrets        the stored secrets, read strictly (throws when unreadable)
 * @param {(sessionID:string)=>Promise<string[]>} [deps.privateAnswers]  the texts of the private sources stored for this task / chat
 * @param {(sessionID:string)=>Promise<string|null>} [deps.folderOf]     the task's / chat's folder
 * @param {(r:{kind:string,tool:string})=>void} [deps.record]            one refusal: its kind and tool, never the text
 * @param {Function} [deps.createScanner]                 createSecretScanner-shaped
 */
export function createOutsideCheck({ loadSecrets, privateAnswers = async () => [], folderOf = async () => null, record = () => {}, createScanner = createSecretScanner, log = console } = {}) {
  /** The refusal kind for this request, or null when it is clean. Throws `Unavailable` when it can't be checked. */
  async function kindOf({ sessionID, input }) {
    const isUrl = typeof input?.url === "string";
    const isQuery = typeof input?.query === "string";
    if (isUrl === isQuery) throw new Unavailable("neither a query nor a url");
    const raw = isUrl ? input.url : input.query;

    // the pieces of free text, each decoded; (d)'s destination-host exemption applies to `hostText` only
    const free = [];
    let hostText = "";
    let whole = decode(raw);
    const parsed = isUrl ? splitUrl(raw) : null;
    if (parsed) {
      free.push(...parsed.segments.map((text) => ({ text, segment: true })), ...parsed.params.map((text) => ({ text })));
      if (parsed.fragment) free.push({ text: parsed.fragment });
      if (parsed.userinfo) free.push({ text: parsed.userinfo, userinfo: true });
      hostText = parsed.host;
      whole = [parsed.userinfo, parsed.host, parsed.segments.join("/"), ...parsed.params, parsed.fragment, parsed.decodedWhole].join("\n");
    } else {
      free.push({ text: whole });
    }

    // (a) a stored secret or anything the scanner flags — over the raw text and every decoded piece
    let values;
    try {
      values = (await loadSecrets()).map((s) => s?.value).filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH);
    } catch (e) {
      log.warn?.(`[research] outside check: couldn't read the secrets store: ${e?.message ?? e}`);
      throw new Unavailable("secrets");
    }
    const scanner = createScanner({ secretValues: () => values });
    const scanned = await scanner.scan(`${raw}\n${whole}`);
    if (scanned?.unavailable) throw new Unavailable("scanner");
    if (scanned?.clean === false) return "secret";

    // (b) the task's / chat's own folder, anywhere in the text
    const folder = await folderOf(sessionID);
    if (typeof folder === "string" && folder.length >= FOLDER_MIN && (whole.includes(folder) || raw.includes(folder))) return "path";

    // (b)–(d) on every piece of free text; a URL's userinfo and (b)'s home-directory run (`/home/jane/x`) are URL-only rules
    if (parsed) {
      if (parsed.userinfo) return "email"; // a username in a URL is an identity; a password a credential
      const run = parsed.segments.findIndex((s, i) => /^(?:home|Users|Volumes)$/.test(s) && parsed.segments.length - i >= 3);
      if (run >= 0) return "path";
      if (INTERNAL_HOST_RE.test(` ${hostText}`)) return "network";
    }
    for (const piece of free) {
      const kinds = textKinds(piece.text);
      if (kinds.length > 0) return kinds[0];
    }

    // (e) 6+ consecutive words copied from a private answer of this task / chat (path words are joined by - _ + or /, all read as spaces)
    const queryWords = words(parsed ? [parsed.host, ...parsed.segments, ...parsed.params, parsed.fragment].join(" ") : whole);
    if (queryWords.length >= VERBATIM_WORDS) {
      const texts = await privateAnswers(sessionID);
      for (const t of Array.isArray(texts) ? texts : []) {
        if (typeof t !== "string" || t === "") continue;
        const hay = ` ${words(t.slice(0, PRIVATE_TEXT_MAX)).join(" ")} `;
        for (let i = 0; i + VERBATIM_WORDS <= queryWords.length; i++) {
          if (hay.includes(` ${queryWords.slice(i, i + VERBATIM_WORDS).join(" ")} `)) return "verbatim";
        }
      }
    }
    return null;
  }

  /**
   * `{ sessionID, tool, input: { query } | { url } }` → `{ ok: true }` or `{ ok: false, error }`. Never throws; never logs the
   * input. A refusal is recorded as `{ kind, tool }`.
   */
  async function check(req) {
    try {
      if (!req || typeof req !== "object" || !TOOLS.has(req.tool) || !req.input || typeof req.input !== "object") throw new Unavailable("malformed request");
      const kind = await kindOf({ sessionID: typeof req.sessionID === "string" ? req.sessionID : "", input: req.input });
      if (kind === null) return { ok: true };
      try {
        record({ kind, tool: req.tool });
      } catch {
        /* recording never decides */
      }
      return { ok: false, error: OUTSIDE_REFUSAL };
    } catch (e) {
      if (!(e instanceof Unavailable)) log.warn?.(`[research] outside check failed: ${e?.message ?? e}`);
      return { ok: false, error: CHECK_UNAVAILABLE };
    }
  }

  return { check };
}

// ctoToolScan.mjs — §7.1 evidence channels 2 + 3 (BET-1395).
//
// Channel 2 (deterministic transcript extractors): batched extraction over
// opencode db `part` rows whose data parses to a tool-call — CLI invocations
// (first token of bash command segments against the catalog), API domains in
// network calls (curl/fetch URLs + webfetch input), and issue-key patterns in
// branch names + commit subjects. Pure row→evidence functions are exported
// for tests; the db query is a thin injected-handle call.
//
// Channel 3 (existing config reads): MCP servers in opencode config, forge
// rules repos, inbound webhooks, git remotes, schedule targets — all passed
// in already-read by the caller (the registry/engine owns I/O); the module
// only reshapes them into evidence rows.
//
// An evidence row is what the §7.2 registry fuses:
//   { channel, identity, detail, ts, sessionID?, project? }
// `identity` is a canonical tool identity from the catalog, or null when the
// evidence is raw (kept for the LLM fallback; never fused until classified).

import { internalSessionIds } from "./internalSessions.mjs";
import { readConversationSessionId, CONVERSATION_ROLE } from "./ctoBinding.mjs";
import {
  matchCliIdentity,
  matchDomainIdentity,
  matchIssueKeys,
} from "./ctoToolCatalog.mjs";

export const CHANNEL_SECRET = "secret";
export const CHANNEL_TRANSCRIPT = "transcript";
export const CHANNEL_CONFIG = "config";

// Cap on part rows scanned per batch — a runaway range can never wedge a tick.
export const SCAN_ROW_CAP = 1000;

// W10: every collectDbRows throw site carries its own code so the registry's
// scan failure surfaces the real cause instead of a catch-all label. Only
// codes cross the boundary; exception text never does.
export function withCode(error, code) {
  if (error instanceof Error) {
    error.code = code;
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.code = code;
  return wrapped;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// W10/BET-1542: the config-surface seam's five readers, each with its own
// failure code. The seam resolves every reader's failure in place (see
// settleSurface) so the scan's ledger row names WHICH surface failed instead
// of one catch-all `surfaces-unavailable` label. Only codes cross the
// boundary; exception text never does.
export const SURFACES_READER_CODES = Object.freeze({
  config: "surfaces-config-unavailable",
  forge: "surfaces-forge-unavailable",
  webhooks: "surfaces-webhooks-unavailable",
  schedules: "surfaces-schedules-unavailable",
  gitRemotes: "surfaces-git-unavailable",
});

// One surfaces reader's outcome: the read resolves → `{ value }`; it rejects
// → the value degrades to `fallback` and the reader's code is attached, so
// the seam's surfaces object carries the failure as `<reader>Code`.
export async function settleSurface(read, code, fallback) {
  try {
    return { value: await read() };
  } catch {
    return { value: fallback, code };
  }
}

// First per-reader failure code on a surfaces object (the seam's resolved
// outcomes), or null when every reader succeeded. Iterated in the seam's own
// reader order, so the code the row names is deterministic.
export function firstSurfacesCode(surfaces = {}) {
  for (const key of Object.keys(SURFACES_READER_CODES)) {
    const code = surfaces?.[`${key}Code`];
    if (typeof code === "string" && code) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel 2 — transcript extractors
// ---------------------------------------------------------------------------

// Parse one opencode `part.data` JSON blob → { tool, input } when it is a
// tool-call part, else null. Defensive: any malformed row yields null.
export function parseToolPart(data) {
  let p;
  if (typeof data === "string") {
    try {
      p = JSON.parse(data);
    } catch {
      return null;
    }
  } else {
    p = data;
  }
  if (!p || typeof p !== "object" || p.type !== "tool") return null;
  const tool = typeof p.tool === "string" ? p.tool : "";
  if (!tool) return null;
  const state = p.state && typeof p.state === "object" ? p.state : {};
  const input = state.input !== undefined ? state.input : null;
  return { tool, input };
}

// ---------------------------------------------------------------------------
// CLI-name shape — the ONE validator shared by the scanner (cliTokens) and the
// registry (fuseRow / payloadFrom prune). A bash command carries heredocs,
// inline python/node scripts and multi-line strings whose "first word of each
// line" is not a command; without a shape gate those fragments (`by`, `const`,
// `d=json.load(x)`, `print(d['status'],`) became registry tools (40k of them).
// ---------------------------------------------------------------------------

// A bare command name, after basename.
export const CLI_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
// What a raw token may be made of before basename: a name or a path to one
// (`gh`, `/usr/bin/gh`, `./scripts/x.sh`, `~/bin/x`). Everything else —
// quotes, brackets, parens, `$`, `=`, `{`, `\`, `:` — is script, not a command.
const CLI_PATH_CHARS = /^[A-Za-z0-9._+~/_-]+$/;
// Shell reserved words open/close compound statements; they are syntax, never
// a program.
const SHELL_RESERVED = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "select", "function", "time", "coproc",
]);

const LEADING_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "time", "!"]);

// A raw token → the bare command name, or null when it does not look like one.
// Paths reduce to their basename. Pure.
export function cliNameFrom(token) {
  const raw = String(token ?? "");
  if (!raw || !CLI_PATH_CHARS.test(raw)) return null;
  const name = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  if (!CLI_NAME_SHAPE.test(name)) return null;
  if (/^[0-9]+$/.test(name)) return null; // pure numbers
  if (SHELL_RESERVED.has(name.toLowerCase())) return null;
  return name;
}

// Identity shape for a registry entry (tool ids are lowercased names).
export function isCliNameShape(token) {
  return cliNameFrom(token) !== null;
}

// Command-string → first token of each real invocation. A bash command is
// usually one pipeline, but compounds (`a && b`, `a; b`, `a | b`, newlines)
// carry several invocations — each segment's first token is the CLI that ran.
// The scan is quote-aware (separators inside quotes do not split), skips
// comments, and skips heredoc bodies (`<<EOF` … `EOF`).
const HEREDOC_START = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][A-Za-z0-9_.-]*))/;

export function cliTokens(command) {
  const text = String(command ?? "");
  if (!text) return [];
  const segments = [];
  let seg = "";
  let quote = "";
  const pending = []; // heredoc terminators awaiting the next newline
  const flush = () => {
    if (seg.trim()) segments.push(seg);
    seg = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      seg += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) seg += text[++i];
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      seg += ch + text[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      seg += ch;
      continue;
    }
    if (ch === "#" && (seg === "" || /\s/.test(seg[seg.length - 1]))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++; // comment: skip to EOL
      continue;
    }
    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<" && text[i - 1] !== "<") {
      const m = HEREDOC_START.exec(text.slice(i));
      if (m) {
        pending.push({ dash: m[1] === "-", term: m[2] ?? m[3] ?? m[4] ?? "" });
        seg += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === "\n") {
      flush();
      // Consume heredoc bodies: every line up to (and including) its terminator.
      while (pending.length) {
        const { dash, term } = pending.shift();
        for (i++; i < text.length; i++) {
          const nl = text.indexOf("\n", i);
          const line = nl === -1 ? text.slice(i) : text.slice(i, nl);
          i = nl === -1 ? text.length : nl;
          if ((dash ? line.replace(/^\t+/, "") : line) === term) break;
        }
      }
      continue;
    }
    if (ch === ";" || ch === "|" || (ch === "&" && text[i + 1] === "&")) {
      if (ch === "&" || (ch === "|" && text[i + 1] === "|")) i++;
      flush();
      continue;
    }
    seg += ch;
  }
  flush();
  const out = [];
  for (const s of segments) {
    // Compound-statement keywords that introduce a command (`do echo x`,
    // `then git add`) are skipped so the real command is what gets named.
    const words = s.trim().split(/\s+/);
    let w = 0;
    while (w < words.length - 1 && LEADING_KEYWORDS.has(words[w])) w++;
    const token = words[w] ?? "";
    const cleaned = token.replace(/^\$\(\)?/, "").replace(/^-+/, "");
    const name = cliNameFrom(cleaned);
    if (name) out.push(name);
  }
  return out;
}

// Free text → https URL hosts (deduped). Anything from curl/fetch/webfetch
// command strings or tool inputs lands here.
const URL_SHAPE = /https:\/\/[A-Za-z0-9._~-]+/g;

export function extractUrlHosts(text) {
  const t = String(text ?? "");
  if (!t) return [];
  const out = [];
  const seen = new Set();
  for (const m of t.matchAll(URL_SHAPE)) {
    const host = m[0].slice("https://".length).toLowerCase().replace(/[.,;)\]]+$/, "");
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

// One tool-call part → evidence rows. `project` is resolved by the caller
// (session-directory cache), may be null.
export function extractFromToolPart({ data, ts, sessionID = null, project = null } = {}) {
  const parsed = parseToolPart(data);
  if (!parsed) return [];
  const rows = [];
  const base = { channel: CHANNEL_TRANSCRIPT, ts, sessionID, project };

  if (parsed.tool === "bash" || parsed.tool === "terminal" || parsed.tool === "shell") {
    const command =
      typeof parsed.input === "string"
        ? parsed.input
        : parsed.input && typeof parsed.input.command === "string"
          ? parsed.input.command
          : "";
    if (command) {
      // CLI invocations: first token of each segment against the catalog.
      for (const token of cliTokens(command)) {
        const identity = matchCliIdentity(token);
        if (identity === "local") continue;
        rows.push({ ...base, identity, source: identity ? "catalog" : "raw", detail: `cli:${token}` });
      }
      // API domains in network calls: hosts of https URLs in the command.
      for (const host of extractUrlHosts(command)) {
        const identity = matchDomainIdentity(host);
        if (identity === undefined) continue; // private/own — not evidence
        rows.push({ ...base, identity, source: identity ? "catalog" : "raw", detail: `domain:${host}` });
      }
      // Issue-key patterns in branch names + commit subjects (both appear in
      // the command string — `git checkout -b BET-123-x`, `git commit -m "…"`).
      for (const key of matchIssueKeys(command)) {
        rows.push({ ...base, identity: null, source: "raw", detail: `key:${key}` });
      }
    }
  } else if (parsed.tool === "webfetch" || parsed.tool === "fetch" || parsed.tool === "web_fetch") {
    const url = parsed.input && typeof parsed.input === "object" ? String(parsed.input.url ?? "") : "";
    for (const host of extractUrlHosts(url)) {
      const identity = matchDomainIdentity(host);
      if (identity === undefined) continue;
      rows.push({ ...base, identity, source: identity ? "catalog" : "raw", detail: `domain:${host}` });
    }
  }
  return rows;
}

// The daily/db batch: opencode db rows → evidence rows. `rows` come from
// collectDbRows (already filtered to the time range + provenance-tagged);
// each row is { data, time_created, session_id, internal?, provenance?, role? }.
//
// Role-aware exclusion (P3a1 review round 2, blocker 4): generic CTO-internal
// sessions contribute nothing; the durable CTO conversation contributes its
// USER rows (CEO instructions — consumable under their own role path) while
// its ASSISTANT rows (the CTO's own tool calls/output) are never ordinary
// evidence. Unknown role on a conversation row is conservatively excluded.
export function extractFromDbRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const provenance =
      typeof r?.provenance === "string" ? r.provenance : r?.internal === true ? "cto_internal" : null;
    if (provenance === "cto_internal") continue;
    if (provenance === CONVERSATION_ROLE && r.role !== "user") continue;
    const ts = Number(r?.time_created);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    out.push(
      ...extractFromToolPart({
        data: r.data,
        ts,
        sessionID: typeof r.session_id === "string" ? r.session_id : null,
      }),
    );
  }
  return out;
}

// Query the read-only opencode db handle (the same one the backfill and
// ⌘F search use). Returns part rows in the half-open (sinceTs, untilTs] range,
// each tagged with distinct provenance: "cto_internal" (generic tombstones),
// "cto_conversation" (the durable CEO channel — via the binding record, NOT
// the tombstones), or null (ordinary pipeline sessions). The row's message
// role is joined from the message table when one exists.
export async function collectDbRows(db, { sinceTs, afterId = "", untilTs, cap = SCAN_ROW_CAP } = {}) {
  if (!db || typeof db.prepare !== "function") throw codedError("db-handle-invalid", "discovery-db-unavailable");
  const range = `(p.time_created > ? OR (p.time_created = ? AND ? != '' AND p.id > ?)) AND p.time_created <= ?`;
  const order = ` ORDER BY p.time_created ASC, p.id ASC LIMIT ?`;
  let rows;
  try {
    const withMessage = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='message'`)
      .all().length > 0;
    const stmt = db.prepare(
      withMessage
        ? `SELECT p.id AS id, p.session_id AS session_id, p.data AS data, p.time_created AS time_created,
                CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS role
           FROM part p LEFT JOIN message m ON m.id = p.message_id
          WHERE ${range}${order}`
        : `SELECT p.id AS id, p.session_id AS session_id, p.data AS data, p.time_created AS time_created
           FROM part p
          WHERE ${range}${order}`,
    );
    rows = stmt.all(sinceTs, sinceTs, afterId, afterId, untilTs, cap) ?? [];
  } catch (error) {
    throw withCode(error, "db-query-failed");
  }
  let internal;
  try {
    internal = await internalSessionIds();
  } catch (error) {
    throw withCode(error, "internal-provenance-failed");
  }
  // Fail-closed: an unreadable binding store refuses classification rather
  // than letting the CEO channel leak into ordinary evidence.
  let conversationSid;
  try {
    conversationSid = await readConversationSessionId();
  } catch (error) {
    throw withCode(error, "internal-provenance-failed");
  }
  // Keep internal rows in the page for cursor advancement, not evidence.
  return rows.map((row) => {
    const isInternal = internal.has(row.session_id);
    const provenance = isInternal
      ? "cto_internal"
      : conversationSid !== null && row.session_id === conversationSid
        ? CONVERSATION_ROLE
        : null;
    return {
      ...row,
      internal: isInternal,
      provenance,
      role: typeof row.role === "string" ? row.role : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Channel 3 — config surfaces (all inputs already-read by the caller; the
// module only reshapes). Unknown shapes yield zero rows, never throws.
// ---------------------------------------------------------------------------

// opencode config → MCP server evidence. `mcp` is {name: {url?}|{command?}}
// — remote servers have a URL (host catalog-matched); local ones are labeled
// by name.
export function extractMcpEvidence(config, { ts } = {}) {
  const mcp = config && typeof config === "object" ? config.mcp : null;
  if (!mcp || typeof mcp !== "object") return [];
  const rows = [];
  for (const [name, def] of Object.entries(mcp)) {
    if (!def || typeof def !== "object") continue;
    const base = { channel: CHANNEL_CONFIG, ts, detail: `mcp:${name}` };
    const url = typeof def.url === "string" ? def.url : "";
    if (url) {
      for (const host of extractUrlHosts(url)) {
        const identity = matchDomainIdentity(host);
        if (identity === undefined) continue;
        rows.push({ ...base, identity, source: identity ? "catalog" : "raw", detail: `mcp:${name}:${host}` });
        break;
      }
    } else {
      rows.push({ ...base, identity: null, source: "raw" });
    }
  }
  return rows;
}

// Forge-rules repos (box-side `~/.manta/forge-rules/<host>/<owner>/<repo>.yaml`
// stems) → evidence for the forge host itself.
export function extractForgeEvidence(repoStems, { ts } = {}) {
  const rows = [];
  for (const stem of Array.isArray(repoStems) ? repoStems : []) {
    if (typeof stem !== "string" || !stem) continue;
    // stem shape: "<host>/<owner>/<repo>" — the host is the identity.
    const host = stem.split("/")[0]?.toLowerCase() ?? "";
    if (!host) continue;
    const identity = matchDomainIdentity(host);
    if (identity === undefined) continue;
    rows.push({ channel: CHANNEL_CONFIG, identity, source: identity ? "catalog" : "raw", detail: `forge:${stem}`, ts });
  }
  return rows;
}

// Inbound webhooks (labels from the webhooks store) → raw evidence (labels
// are user-named; the LLM fallback may classify, at most once).
export function extractWebhookEvidence(hooks, { ts } = {}) {
  const rows = [];
  for (const h of Array.isArray(hooks) ? hooks : []) {
    const label = typeof h?.label === "string" ? h.label.trim() : "";
    if (!label) continue;
    rows.push({ channel: CHANNEL_CONFIG, identity: null, source: "raw", detail: `webhook:${label}`, ts });
  }
  return rows;
}

// Git remotes per project ([{project, url}]) → domain evidence (e.g.
// github.com → github).
export function extractGitRemoteEvidence(remotes, { ts } = {}) {
  const rows = [];
  for (const r of Array.isArray(remotes) ? remotes : []) {
    const url = typeof r?.url === "string" ? r.url : "";
    const project = typeof r?.project === "string" ? r.project : null;
    if (!url) continue;
    const host = String(extractUrlHosts(url)[0] ?? url).toLowerCase();
    // scp-ish git remotes: git@github.com:owner/repo.git
    const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
    const hostname = scp ? scp[1].toLowerCase() : host;
    const identity = matchDomainIdentity(hostname);
    if (identity === undefined) continue;
    rows.push({
      channel: CHANNEL_CONFIG,
      identity,
      source: identity ? "catalog" : "raw",
      detail: `git:${hostname}`,
      ts,
      project,
    });
  }
  return rows;
}

// Schedule targets (labels from the schedule store) → raw evidence.
export function extractScheduleEvidence(schedules, { ts } = {}) {
  const rows = [];
  for (const s of Array.isArray(schedules) ? schedules : []) {
    const label = typeof s?.label === "string" ? s.label.trim() : "";
    if (!label) continue;
    rows.push({ channel: CHANNEL_CONFIG, identity: null, source: "raw", detail: `schedule:${label}`, ts });
  }
  return rows;
}

// The whole channel-3 batch from already-read surfaces. Unknown/missing
// surfaces are skipped (undefined), never throwing.
export function collectConfigEvidence(surfaces = {}, { ts } = {}) {
  return [
    ...extractMcpEvidence(surfaces.config, { ts }),
    ...extractForgeEvidence(surfaces.forgeRepos, { ts }),
    ...extractWebhookEvidence(surfaces.webhooks, { ts }),
    ...extractGitRemoteEvidence(surfaces.gitRemotes, { ts }),
    ...extractScheduleEvidence(surfaces.schedules, { ts }),
  ];
}

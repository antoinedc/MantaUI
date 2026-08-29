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

import {
  matchCliIdentity,
  matchDomainIdentity,
  matchIssueKeys,
} from "./ctoToolCatalog.mjs";

export const CHANNEL_SECRET = "secret";
export const CHANNEL_TRANSCRIPT = "transcript";
export const CHANNEL_CONFIG = "config";

// Cap on part rows scanned per batch — a runaway range can never wedge a tick.
export const SCAN_ROW_CAP = 20_000;

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

// Command-string → first tokens of each segment. A bash command is usually
// one pipeline, but compounds (`a && b`, `a; b`, `a | b`, newlines) carry
// several invocations — each segment's first token is the CLI that ran.
const SEGMENT_SPLIT = /(?:&&|\|\||;|\||\n)+/;

export function cliTokens(command) {
  const text = String(command ?? "");
  if (!text) return [];
  const out = [];
  for (const seg of text.split(SEGMENT_SPLIT)) {
    const token = seg.trim().split(/\s+/)[0] ?? "";
    const cleaned = token.replace(/^\$\(\)?/, "").replace(/^\-+/, "");
    if (cleaned) out.push(cleaned);
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
// collectDbRows (already filtered to the time range); each row is
// { data, time_created, session_id }.
export function extractFromDbRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
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
// ⌘F search use). Returns part rows in the half-open (sinceTs, untilTs] range.
export async function collectDbRows(db, { sinceTs, untilTs, cap = SCAN_ROW_CAP } = {}) {
  if (!db || typeof db.prepare !== "function") return [];
  try {
    const stmt = db.prepare(
      `SELECT p.session_id AS session_id, p.data AS data, p.time_created AS time_created
       FROM part p
       WHERE p.time_created > ? AND p.time_created <= ?
       ORDER BY p.time_created ASC
       LIMIT ?`,
    );
    return stmt.all(sinceTs, untilTs, cap) ?? [];
  } catch {
    return [];
  }
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

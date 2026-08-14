// src/server/forge/selfhost.mjs — user-configured host→kind mapping (BET-799 §Self-hosted).
//
// `detectForge` in src/shared/forge.mjs deliberately returns `null` for unknown
// hosts (a deliberate design decision — never guess a forge from a bare URL).
// This module LAYERS a user-configured mapping on top of it WITHOUT touching
// shared/forge.mjs: a host in the AppConfig `forgeHosts` list resolves to its
// configured kind + apiBase; every known host (github.com / gitlab.com) still
// resolves through the shared detector, unchanged.
//
// It also owns per-host API base derivation: the adapters no longer hardcode a
// single hosted root (github.com → api.github.com, gitlab.com → gitlab.com/api/v4),
// so a self-hosted instance serves its own `<host>/api/v4` (GitLab) or
// `<host>/api/v3` (GitHub). Pure — no I/O, no network.

import { detectForge } from "../../shared/forge.mjs";

// Default API roots for the two hosted forges.
const HOSTED_API_BASE = Object.freeze({
  "github.com": "https://api.github.com",
  "gitlab.com": "https://gitlab.com/api/v4",
});

/**
 * Derive an API base for `kind` at `host`. Hosted hosts get their canonical root;
 * a self-hosted host gets `<host>/api/vN` (GitLab v4, GitHub v3) — the
 * conventional self-managed mount points.
 * @param {"github"|"gitlab"} kind
 * @param {string} host
 * @returns {string}
 */
export function defaultApiBase(kind, host) {
  const h = String(host ?? "").toLowerCase();
  const hosted = HOSTED_API_BASE[h];
  if (hosted) return hosted;
  if (kind === "gitlab") return `https://${h}/api/v4`;
  if (kind === "github") return `https://${h}/api/v3`;
  return "";
}

/**
 * Parse a git remote string into `{ host, owner, repo }` for ANY host, mirroring
 * the shared `detectForge` parsing (https/ssh/scp forms, `.git` suffix, nested
 * subgroup owners). Pure. Returns `null` for a local path / non-git / empty.
 *
 * @param {unknown} remoteUrl
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
export function parseRemotePath(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const input = remoteUrl.trim();
  if (input === "") return null;

  let host;
  let path;
  const scp = input.match(/^[^@\s/]+@([^:\s]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ssh:") return null;
    host = url.hostname;
    path = url.pathname;
  }

  host = String(host).toLowerCase();
  const clean = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter((s) => s !== "");
  if (parts.length < 2) return null;
  const owner = parts.slice(0, -1).join("/").toLowerCase();
  const repo = parts[parts.length - 1].toLowerCase().replace(/\.git$/, "");
  if (owner === "" || repo === "") return null;
  return { host, owner, repo };
}

const KNOWN_KINDS = new Set(["github", "gitlab"]);

/**
 * Layer the configured host→kind mapping on top of the shared detector.
 *
 * - A known host (github.com / gitlab.com) resolves through `detectForge`, with
 *   its canonical apiBase — behaviour identical to before.
 * - An unknown host resolves ONLY when it is present in `hostKinds` (the
 *   AppConfig list, `[{ host, kind, apiBase? }]`). Its kind comes from the
 *   config, never from guessing the URL; apiBase is the configured one or the
 *   conventional `<host>/api/vN` default.
 * - Anything else → null (the shared "unknown host is out of scope" contract).
 *
 * @param {unknown} remoteUrl
 * @param {Array<{ host?: string, kind?: string, apiBase?: string }>} [hostKinds]
 * @returns {{ kind: "github"|"gitlab", host: string, owner: string, repo: string, apiBase: string } | null}
 */
export function detectForgeWithHosts(remoteUrl, hostKinds = []) {
  const known = detectForge(remoteUrl);
  if (known) {
    return {
      ...known,
      apiBase: HOSTED_API_BASE[known.host] ?? defaultApiBase(known.kind, known.host),
    };
  }
  const parsed = parseRemotePath(remoteUrl);
  if (!parsed) return null;
  const host = parsed.host;
  const entry = (Array.isArray(hostKinds) ? hostKinds : []).find(
    (e) => e && typeof e.host === "string" && e.host.toLowerCase() === host && KNOWN_KINDS.has(e.kind),
  );
  if (!entry) return null;
  return {
    kind: entry.kind,
    host,
    owner: parsed.owner,
    repo: parsed.repo,
    apiBase: (typeof entry.apiBase === "string" && entry.apiBase) || defaultApiBase(entry.kind, host),
  };
}

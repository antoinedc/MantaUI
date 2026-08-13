// src/server/forgeRules.mjs — box-side forge rules registry (BET-797).
//
// The rules file for a repo lives at
//   ~/.manta/forge-rules/<host>/<owner>/<repo>.yaml
// authored by the AI through the forge_rules opencode tool, validated by the
// ONE shared validator (src/shared/forgeRules.mjs), and stored on the BOX — so
// nothing a PR can edit ever reaches a rules file (design spec §5.2). This
// module is the server half the tool talks to: it saves/get/lists rules,
// registers the per-repo webhook, records (logs, never acts on) inbound forge
// events, and drives the hot-reload publish.
//
// Box-side placement is the whole point. A malicious pull request editing a
// checked-in rules file was the sharpest risk in the original design; placing
// the file here deletes it outright, and replaces a per-repo trust dialog with
// one global toggle (AppConfig.forgeRulesEnabled, default off).
//
// State files go through statePath() so npm test (which runs with a sandboxed
// MANTA_STATE_HOME) never writes production data.

import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { repoKey } from "../shared/forge.mjs";
import {
  parseRules,
  validateForgeRepoPath,
} from "../shared/forgeRules.mjs";
import { genDeliveryToken, upsertForgeHook, findForgeHook } from "./webhooks.mjs";
import { ensureRepoHook } from "./forge/webhook.mjs";
import { publicBaseUrl } from "./gatewayRegister.mjs";

const RULES_ROOT = "forge-rules";
const EVENTS_LOG = statePath("forge-events.jsonl");

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

// Split a canonical "host/owner/repo" key back into parts. host is the first
// segment, repo the last, owner everything between (so GitLab subgroup owners
// "group/subgroup" survive). Input is the join key produced by repoKey(), so
// it is already lowercased with no trailing slash / .git.
export function parseRepoKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split("/").filter((s) => s !== "");
  if (parts.length < 3) return null;
  return {
    host: parts[0],
    owner: parts.slice(1, -1).join("/"),
    repo: parts[parts.length - 1],
  };
}

// The on-disk rules file path for a repo identity, after path-component
// validation. Returns {ok:true, path} or {ok:false, error}. The owner may be a
// GitLab subgroup path; each component is validated by validateForgeRepoPath
// so a crafted repo name cannot escape forge-rules/.
export function rulesPathFor({ host, owner, repo }) {
  const v = validateForgeRepoPath({ host, owner, repo });
  if (!v.ok) return v;
  return { ok: true, path: statePath(RULES_ROOT, host, ...owner.split("/"), `${repo}.yaml`) };
}

// ---------------------------------------------------------------------------
// Registry I/O (injectable for tests; never touches the network)
// ---------------------------------------------------------------------------

const DEFAULT_IO = {
  stateRoot: () => statePath(RULES_ROOT),
  read: (p) => readFile(p, "utf-8"),
  write: async (p, data) => {
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600 });
  },
  append: (p, data) => appendFile(p, data, { mode: 0o600 }),
  readdir,
};

// Canonical repo key for a rules file path (reverse of rulesPathFor).
function repoKeyFromPath(rel) {
  const parts = rel.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
  if (parts.length < 3) return null;
  const repo = parts[parts.length - 1].replace(/\.yaml$/, "");
  const host = parts[0];
  const owner = parts.slice(1, -1).join("/");
  if (!host || !owner || !repo) return null;
  return `${host}/${owner}/${repo}`;
}

// Recursively collect *.yaml files under the rules root, as repo keys.
async function listRuleFiles(root, rd) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await rd(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".yaml")) out.push(p);
    }
  }
  try {
    await walk(root);
  } catch {
    return [];
  }
  return out;
}

// Get the current source of a repo's rules file. Returns {ok:true, repoKey,
// yaml} when present, {ok:false, error:"not found"} when absent.
export async function getRules(repoKeyStr, io = DEFAULT_IO) {
  const parts = parseRepoKey(repoKeyStr);
  if (!parts) return { ok: false, error: "invalid repo key" };
  const p = rulesPathFor(parts);
  if (!p.ok) return { ok: false, error: p.error };
  try {
    const yaml = await io.read(p.path);
    return { ok: true, repoKey: repoKeyStr, yaml };
  } catch {
    return { ok: false, error: "not found" };
  }
}

// List EVERY repo with a rules file, INCLUDING invalid ones with their
// validation error and their raw source. A rules file that silently fails to
// load is far worse than one that loudly refuses (the same rule the plugin
// registry enforces). Returns [{repoKey, valid, error?, yaml}].
export async function listRules(io = DEFAULT_IO) {
  const root = io.stateRoot();
  const files = await listRuleFiles(root, io.readdir);
  const rows = [];
  for (const file of files) {
    const rel = file.slice(root.length).replace(/^[/\\]+/, "");
    const key = repoKeyFromPath(rel);
    if (!key) continue;
    let yaml;
    try {
      yaml = await io.read(file);
    } catch (e) {
      rows.push({ repoKey: key, valid: false, error: `read failed: ${e?.message ?? e}`, yaml: null });
      continue;
    }
    const parsed = parseRules(yaml);
    rows.push({
      repoKey: key,
      valid: parsed.ok,
      error: parsed.ok ? undefined : formatErrors(parsed.errors),
      yaml,
    });
  }
  return rows.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
}

function formatErrors(errors) {
  return (errors ?? []).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("; ");
}

// ---------------------------------------------------------------------------
// Save — validate → write → register/update the webhook → reload
// ---------------------------------------------------------------------------

/**
 * Save a repo's rules. Pure of the network path: validates first (fail loud,
 * write nothing on a validation error), writes the file, then registers the
 * per-repo webhook and hot-reloads. Returns:
 *   {ok:true, repoKey, webhook:{registered:boolean, url?, error?}} on success,
 * or {ok:false, errors:[...]} with the validator's errors VERBATIM (nothing
 * written) on a validation failure.
 *
 * Registration needs the box's public hostname and a forge token; when either
 * is absent it fails LOUDLY (the rules file is still saved — the rules are the
 * point — but the returned webhook.error tells the caller no delivery can
 * arrive). With the global toggle off this whole path refuses before any write.
 *
 * @param {{repo: string, yaml: string}} input
 * @param {object} [deps]
 * @param {() => boolean} [deps.enabled]
 * @param {{host?:string, token?:string}} [deps.forge] forge identity + token for registration
 * @param {object} [deps.io]
 * @param {typeof ensureRepoHook} [deps.ensureHook]
 * @param {() => void} [deps.reload]
 */
export async function saveRules(
  { repo, yaml },
  {
    enabled = () => true,
    forge = {},
    io = DEFAULT_IO,
    ensureHook = ensureRepoHook,
    reload = () => {},
  } = {},
) {
  if (!enabled()) {
    return { ok: false, error: "forge rules are disabled" };
  }
  const parts = parseRepoKey(repo);
  if (!parts) return { ok: false, error: "invalid repo key" };
  const parsed = parseRules(yaml);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors, written: false };
  }
  const p = rulesPathFor(parts);
  if (!p.ok) return { ok: false, error: p.error };

  await io.write(p.path, yaml);

  let webhook = { registered: false };
  try {
    const pub = publicBaseUrl();
    if (!pub) {
      webhook = {
        registered: false,
        error:
          "no public hostname — this box cannot receive webhooks (Tailscale-only / macOS " +
          "boxes deliberately skip public TLS; polling covers them)",
      };
    } else if (!forge.token) {
      webhook = {
        registered: false,
        error: "no forge token configured (the auth ladder arrives with the adapter)",
      };
    } else {
      const key = repoKey(parts);
      // Reuse the existing hook's delivery token so the URL stays stable across
      // re-saves; otherwise mint a fresh capability token for this repo.
      const existing = await findForgeHook(key);
      const deliveryToken = existing?.token ?? genDeliveryToken();
      const res = await ensureHook({
        host: parts.host,
        owner: parts.owner,
        repo: parts.repo,
        githubToken: forge.token,
        deliveryToken,
        publicBase: pub,
        events: eventsForRules(parsed.rules),
      });
      if (!res.ok) {
        webhook = { registered: false, error: res.error };
      } else {
        await upsertForgeHook({
          repoKey: key,
          label: key,
          token: deliveryToken,
          secret: res.secret,
          events: eventsForRules(parsed.rules),
        });
        webhook = { registered: true, url: res.url };
      }
    }
  } catch (e) {
    webhook = { registered: false, error: e?.message ?? String(e) };
  }

  reload();
  return { ok: true, repoKey: repo, webhook };
}

// The GitHub webhook events a repo's rules subscribe to. Map each MantaUI rule
// event to the GitHub delivery event(s) that can carry it (X-GitHub-Event).
// This is the thin seed of the GitHub adapter's normalisation (a later issue):
// registering for ONLY the relevant events is what lets the event-type filter
// drop an irrelevant delivery before it is normalised. `ping` is the standard
// GitHub keepalive every "web" hook receives.
const RULE_EVENT_TO_GITHUB = Object.freeze({
  "issue.labeled": ["issues"],
  "checks.failed": ["check_run", "status"],
  "review.requested": ["pull_request"],
});

export function eventsForRules(rules) {
  const set = new Set(["ping"]);
  const on = rules?.on ?? {};
  for (const ev of Object.keys(on)) {
    for (const g of RULE_EVENT_TO_GITHUB[ev] ?? []) set.add(g);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Ingest — verify, dedupe, filter (all in webhooks.mjs), then RECORD
//
// This issue does NOT act on events. The rules *engine* is the next issue; here
// a verified delivery is appended to a box-side JSONL log (satisfying "logged"
// acceptance) and nothing is dispatched. With the toggle off nothing routes —
// and no forge hooks exist to receive deliveries anyway (registration is gated
// above).
// ---------------------------------------------------------------------------

export async function forgeIngest({ hook, headers, event, payload }, io = DEFAULT_IO) {
  const rec = {
    time: new Date().toISOString(),
    repoKey: hook?.repoKey ?? null,
    event: event ?? null,
    deliveryId: headers?.["x-github-delivery"] ?? null,
    payload,
  };
  try {
    await io.append(EVENTS_LOG, JSON.stringify(rec) + "\n");
  } catch {
    // Never throw from ingest — transport errors must not fail the sender.
  }
  return rec;
}

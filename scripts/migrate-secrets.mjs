#!/usr/bin/env node
// migrate-secrets.mjs — consolidate secrets scattered across credential files on
// the box into the manta secret store (~/.manta/secrets.json), so agents can
// read them via the secret_list / secret_provide opencode tools.
//
// LEAK-SAFE BY DESIGN: this runs ON THE BOX, reads each source file locally, and
// POSTs the value straight to manta-server (127.0.0.1:8787). The VALUE never passes
// through the AI transcript — this script prints only KEY NAMES, scope, and the
// SOURCE file, never the secret itself. Canonical credential files are left
// untouched (the native CLIs still use them); this only COPIES the values.
//
// THIS STORE IS FOR INFRA / WORKFLOW SECRETS (what an agent uses to do ops work:
// deploy, push, manage cloud), NOT product runtime secrets. We migrate the infra
// credential stores (~/.credentials/, gh/aws/netrc/modal, and per-project
// `.credentials*` files) and DELIBERATELY SKIP project `.env*` files — those are
// the running app's config, not for agents.
//
// SCOPING (per the agreed mapping):
//   - shared          → dev-infra (gh/modal/heroku) + index.md "shared" creds
//                       (Cloudflare ronda+ethernal, Census, BLS, NordVPN).
//   - project:<name>  → creds tied to a bui workspace, by filename keyword
//                       (ronda→Ronda, bannerman→Bannerman, tenanture→Leasebot)
//                       and per-project repo `.credentials*` files.
//   - skipped         → AWS "polymarket" profile (no bui project; ignored).
//
// Usage (on the box):
//   node scripts/migrate-secrets.mjs           # DRY RUN — shows what it'd import
//   node scripts/migrate-secrets.mjs --apply   # actually import into the store
//
// Re-running is safe: an existing (scope, owner, key) slot is overwritten with
// the same value. Prune / rescope afterwards in the bui Secrets card.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const APPLY = process.argv.includes("--apply");
const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";
const HOME = homedir();

// bui projects (tmux workspaces) → repo dir. Edit if your layout differs.
// Bannerman's cwd is $HOME (infra, not a repo) so it has no repo scan — its
// creds live in ~/.credentials/bannerman-*.
const PROJECT_DIRS = {
  Ronda: join(HOME, "projects/ronda"),
  Leasebot: join(HOME, "projects/leasebot"),
  ethernal: join(HOME, "projects/ethernal"),
  Capo: "/mnt/HC_Volume_105783934/relocated/airtranscript",
  BUI: join(HOME, "projects/better-ui"),
};

// Raw discovered entries; classified + deduped after collection. `value` is held
// only in this process and NEVER printed.
const raw = [];
function addRaw(key, value, hint, source, scope = null, project = null) {
  if (typeof value !== "string" || !value.trim()) return;
  raw.push({ key, value: value.trim(), hint, source, scope, project });
}

// Obvious non-secret env vars worth skipping so repo .env scans aren't noisy.
const NON_SECRET = new Set(["NODE_ENV", "PORT", "HOST", "TZ", "PWD", "HOME", "PATH", "LOG_LEVEL"]);

// ---- helpers ----

function sanitizeKey(name) {
  let k = name.replace(/^\.+/, ""); // leading dots (.env → env) so it's not empty
  k = k.replace(/\.(env|json|txt|pem|key|toml|ya?ml|ini|cfg|conf|local)$/i, "");
  k = k.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  k = k.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z_]/.test(k)) k = `K_${k}`;
  return (k || "SECRET").slice(0, 64);
}

const DOTENV_LINE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=.+$/;
// dotenv if a MAJORITY of non-blank/non-comment lines are KEY=VALUE. Ratio (not
// "all") tolerates a few odd lines in a real .env; JSON / PEM / single tokens
// (almost no KEY= lines) fall through to whole-file import.
function looksLikeDotenv(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return false;
  const matched = lines.filter((l) => DOTENV_LINE.test(l)).length;
  return matched / lines.length >= 0.6;
}
function parseDotenv(text) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out.push([m[1], v]);
  }
  return out;
}

// Import one file: dotenv → one secret per KEY; otherwise whole-file content as
// one secret keyed by basename (service-account JSON, SSH keys, single tokens).
function importFile(p, name, scope = null, project = null) {
  let text;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return; // binary / unreadable
  }
  if (!text.trim()) return;
  if (looksLikeDotenv(text)) {
    for (const [k, v] of parseDotenv(text)) {
      if (NON_SECRET.has(k)) continue;
      addRaw(k, v, `${name} → ${k}`, p, scope, project);
    }
  } else {
    addRaw(sanitizeKey(name), text, `full contents of ${name}`, p, scope, project);
  }
}

// Import every (non-dotfile, non-pub/-md) file in a directory.
function importDir(dir, scope = null, project = null) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    if (/\.(pub|md|markdown)$/i.test(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) importFile(p, name, scope, project);
  }
}

// ---- credential-store / dotfile parsers (classified by source later) ----

function parseGhHosts() {
  const p = join(HOME, ".config", "gh", "hosts.yml");
  if (!existsSync(p)) return;
  let host = null;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const h = line.match(/^([A-Za-z0-9.-]+):\s*$/);
    if (h) {
      host = h[1];
      continue;
    }
    const t = line.match(/^\s+oauth_token:\s*(\S+)/);
    if (t && host) {
      const key = host === "github.com" ? "GITHUB_TOKEN" : `GITHUB_TOKEN_${sanitizeKey(host)}`;
      addRaw(key, t[1], `gh CLI token for ${host}`, p);
    }
  }
}
function parseAws() {
  const p = join(HOME, ".aws", "credentials");
  if (!existsSync(p)) return;
  let profile = "default";
  for (const rawLine of readFileSync(p, "utf-8").split("\n")) {
    const line = rawLine.trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      profile = sec[1];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const name = kv[1].toLowerCase();
    const suffix = profile === "default" ? "" : `_${sanitizeKey(profile)}`;
    if (name === "aws_access_key_id") addRaw(`AWS_ACCESS_KEY_ID${suffix}`, kv[2], `AWS key (profile ${profile})`, p);
    if (name === "aws_secret_access_key") addRaw(`AWS_SECRET_ACCESS_KEY${suffix}`, kv[2], `AWS secret (profile ${profile})`, p);
  }
}
function parseNetrc() {
  const p = join(HOME, ".netrc");
  if (!existsSync(p)) return;
  const t = readFileSync(p, "utf-8").split(/\s+/);
  let machine = null;
  let login = null;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "machine") machine = t[++i];
    else if (t[i] === "login") login = t[++i];
    else if (t[i] === "password" && machine) {
      addRaw(`NETRC_${sanitizeKey(machine)}`, t[++i], `~/.netrc password for ${machine}${login ? ` (login ${login})` : ""}`, p);
    }
  }
}
function parseModal() {
  const p = join(HOME, ".modal.toml");
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf-8");
  const s = text.match(/token_secret\s*=\s*["']?([^"'\s]+)/);
  if (s) addRaw("MODAL_TOKEN_SECRET", s[1], "Modal token secret", p);
  const id = text.match(/token_id\s*=\s*["']?([^"'\s]+)/);
  if (id) addRaw("MODAL_TOKEN_ID", id[1], "Modal token id", p);
}

// ---- per-project repo INFRA credential files ----
//
// This store is for INFRA / WORKFLOW secrets an agent uses to do ops work
// (deploy, push, manage cloud), NOT product runtime secrets. So we deliberately
// scan only `.credentials*` / `.secrets*` files (infra) and SKIP `.env*` —
// those belong to the running app, not to agents.
const REPO_CRED_RE = /^\.credentials(\..+)?$|^\.secrets?(\..+)?$/i;
const REPO_EXCLUDE_RE = /example|sample|template|\.dist$|\.bak|local-test/i;
function importProjectRepos() {
  for (const [project, dir] of Object.entries(PROJECT_DIRS)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!REPO_CRED_RE.test(name) || REPO_EXCLUDE_RE.test(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) importDir(p, "project", project); // e.g. repo .credentials/
      else if (st.isFile()) importFile(p, name, "project", project);
    }
  }
}

// ---- classification for the credential-store / dotfile sources ----
// Returns { scope, project? } or null to SKIP. Repo entries are pre-scoped.
function classify(key, source) {
  const low = basename(source).toLowerCase();
  if (source.endsWith("/.aws/credentials")) return null; // polymarket profile — ignore
  if (source.endsWith("/hosts.yml") || source.endsWith("/.modal.toml") || source.endsWith("/.netrc"))
    return { scope: "shared" }; // dev-infra, used across projects
  if (low === "bls" || low === "census" || low === "nordvpn") return { scope: "shared" };
  if (low === "ronda-cloudflare") return { scope: "shared" }; // index.md: ronda + ethernal
  if (low.startsWith("secops")) {
    if (key.startsWith("CAPO_")) return { scope: "project", project: "Capo" };
    if (key.startsWith("RONDA_")) return { scope: "project", project: "Ronda" };
    if (key.startsWith("LEASEBOT_")) return { scope: "project", project: "Leasebot" };
    return { scope: "shared" };
  }
  if (low.includes("tenanture")) return { scope: "project", project: "Leasebot" }; // tenanture == leasebot
  if (low.includes("bannerman")) return { scope: "project", project: "Bannerman" };
  if (low.includes("ronda")) return { scope: "project", project: "Ronda" };
  return { scope: "shared" }; // unknown → shared (review in UI)
}

// ---- run collection ----
for (const fn of [parseGhHosts, parseAws, parseNetrc, parseModal]) {
  try {
    fn();
  } catch (e) {
    console.error(`! ${fn.name} failed: ${e?.message ?? e}`);
  }
}
try {
  importDir(join(HOME, ".credentials")); // classified by source
} catch (e) {
  console.error(`! importDir ~/.credentials failed: ${e?.message ?? e}`);
}
try {
  importProjectRepos();
} catch (e) {
  console.error(`! importProjectRepos failed: ${e?.message ?? e}`);
}

// ---- classify + slot-dedupe ----
const final = [];
const slots = new Map();
const slotKey = (scope, project, key) => `${scope}::${scope === "project" ? project : ""}::${key}`;
for (const r of raw) {
  let { scope, project, key } = r;
  if (!scope) {
    const c = classify(r.key, r.source);
    if (!c) continue; // skipped (polymarket)
    scope = c.scope;
    project = c.project ?? null;
  }
  let sk = slotKey(scope, project, key);
  if (slots.has(sk)) {
    const existing = final[slots.get(sk)];
    if (existing.source === r.source) continue; // dup from same file
    key = `${key}_${sanitizeKey(basename(r.source))}`.slice(0, 64); // cross-source clash → suffix
    sk = slotKey(scope, project, key);
    if (slots.has(sk)) continue;
  }
  slots.set(sk, final.length);
  final.push({ key, value: r.value, hint: r.hint, source: r.source, scope, project });
}

if (final.length === 0) {
  console.log("No credentials found to migrate. Add secrets in the bui Secrets card (🔑).");
  process.exit(0);
}

// ---- report (grouped by scope; values hidden) ----
const groups = new Map();
for (const f of final) {
  const g = f.scope === "project" ? `project:${f.project}` : "shared";
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(f);
}
console.log(`Found ${final.length} secret(s) to migrate (values hidden):\n`);
for (const g of [...groups.keys()].sort()) {
  console.log(`[${g}]`);
  for (const f of groups.get(g)) {
    console.log(`  ${f.key.padEnd(34)}  ← ${f.source.replace(HOME, "~")}`);
  }
  console.log("");
}

if (!APPLY) {
  console.log("DRY RUN. Re-run with --apply to import these into the bui store.");
  console.log("(Values are read locally and POSTed straight to manta-server — they");
  console.log(" never appear in this output or any AI transcript.)");
  process.exit(0);
}

console.log("Importing…");
let ok = 0;
for (const f of final) {
  try {
    const res = await fetch(`${MANTA_SERVER}/api/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: f.key,
        value: f.value,
        scope: f.scope,
        project: f.project,
        hint: f.hint,
      }),
    });
    if (res.ok) {
      ok++;
    } else {
      console.log(`  ✗ ${f.key} (${f.scope}${f.project ? `:${f.project}` : ""}) — ${await res.text()}`);
    }
  } catch (e) {
    console.log(`  ✗ ${f.key} — ${e?.message ?? e}`);
  }
}
console.log(`\nDone. Imported ${ok}/${final.length}. Manage them in the bui Secrets card.`);

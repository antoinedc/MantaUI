// upgradeV2Prepare.mjs — everything the box needs on disk before OpenCode V2 can
// run, as ONE idempotent routine (slice C3).
//
// Three callers share it so they can never drift:
//   * scripts/install.sh      (`node upgradeV2Prepare.mjs prepare …`)
//   * scripts/self-update.sh  (same CLI)
//   * manta-server's boot hook (upgradeV2.mjs) — the "two-hop" safety net: an
//     installed box performs its FIRST update to this release with the OLD
//     self-update.sh, which knows nothing about V2, so the NEW server finishes the
//     job on boot.
//
// What it does:
//   1. password   — `~/.manta/opencode-password` (32 hex, 0600), created if absent.
//   2. binary     — the pinned V2 binary shipped in the release (vendor/opencode)
//                   → `~/.opencode/bin/opencode`, integrity-checked. A V1 binary
//                   already there is kept as `opencode-v1` (rollback target).
//   3. plugins    — docs/opencode-plugins-v2/<name>/ → ~/.config/opencode/plugins/<name>/
//   4. V1 assets  — Manta's V1 tools, V1 plugins and the opencode-claude-auth
//                   config entry are RETIRED (backed up first, restorable by
//                   rollback) and the V2 config rules are merged in.
//
// When a V1 history DB still has to be migrated, step 4 is DEFERRED (the V1
// opencode is still running and must keep its tools until the upgrade flow stops
// it) and the opencode service is pinned to the V1 binary so V2 can never start
// against a raw V1 database before the disk preflight has run.
//
// Pure decisions + injected I/O; the default I/O is the real filesystem.

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import { STATE_DIRNAME, stateHome } from "../shared/paths.mjs";
import { createOpencodeService, opencodeBinPath, passwordFilePath } from "./upgradeV2Service.mjs";

/** The V2 plugins Manta ships (directory names under docs/opencode-plugins-v2/). */
export const V2_PLUGINS = Object.freeze(["manta", "manta-claude-max", "manta-optimizer"]);
/** Plugin ids `GET /api/plugin` reports for them (upgrade `verify` checks these). */
export const V2_PLUGIN_IDS = Object.freeze(["manta", "manta.claude-max", "manta.optimizer"]);

/** The V1 tool files Manta's installer copied into ~/.config/opencode/tools/ (docs/opencode-tools/*.ts). */
export const V1_TOOL_FILES = Object.freeze([
  "cto-fact.ts", "cto-verdict.ts", "cto.ts", "delegate.ts", "forge-rules.ts", "manta-app.ts",
  "manta-auth.ts", "media.ts", "notify.ts", "peers.ts", "plan-render.ts", "plugins.ts",
  "progress.ts", "resource-snapshot.ts", "schedule.ts", "secrets.ts", "send-file.ts",
  "send-to-cto.ts", "serve-page.ts", "webhook.ts", "widget.ts",
]);
/** The V1 plugin files Manta installed into ~/.config/opencode/plugins/. */
export const V1_PLUGIN_FILES = Object.freeze(["manta-accounts.ts", "manta-optimizer.ts"]);
export const CLAUDE_AUTH_FAMILY = "opencode-claude-auth";

// ------------------------------------------------------------------ paths

export function migrationStatePath() {
  return join(stateHome(), STATE_DIRNAME, "v2-migration.json");
}
export function v1BackupDir() {
  return join(stateHome(), STATE_DIRNAME, "v1-opencode-backup");
}
export function opencodeConfigDir(home = homedir()) {
  return join(home, ".config", "opencode");
}

/** Where V1 kept its history DB (and where V2 looks by default). */
export function resolveV1DbPath({ env = process.env, home = homedir() } = {}) {
  if (env.MANTA_OPENCODE_DB) return env.MANTA_OPENCODE_DB;
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(data, "opencode", "opencode.db");
}

// --------------------------------------------------------------- pure logic

/** 32 lowercase hex chars. */
export function newPassword(bytes = randomBytes) {
  return bytes(16).toString("hex");
}

/**
 * First major of a `--version` output ("1.18.34", "2.0.30", "opencode 2.0.30"), or null.
 */
export function parseMajor(versionOutput) {
  const m = /(\d+)\.\d+\.\d+/.exec(String(versionOutput ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * Does the box still have a V1 history DB to migrate?
 *
 * The migration state file is the authority once it says anything terminal; before
 * that the evidence is a V1 DB on disk plus proof the box was running V1 (a V1
 * binary installed, a preserved `opencode-v1`, or an in-flight state file). A
 * fresh V2 box that merely has its OWN db, or an already-migrated one, never
 * matches.
 */
export function computeMigrationNeeded({ dbExists, state, installedMajor, v1BinaryKept }) {
  if (!dbExists) return false;
  const s = state?.state;
  if (s === "completed" || s === "rolled_back") return false;
  if (s === "idle" || s === "running" || s === "failed") return true;
  return installedMajor === 1 || v1BinaryKept === true;
}

/**
 * Merge the V2 rules into opencode.jsonc, surgically (comments survive):
 *   * drop every `opencode-claude-auth*` entry from `plugin` (manta-claude-max replaces it)
 *   * `permission.external_directory: "ask"` unless the user set a rule already (V2 defaults
 *     to allowing reads outside the project, V1 asked)
 *   * `instructions` gets `CLAUDE.md` (V2 only reads AGENTS.md by itself)
 * Returns { text, changed, corrupt }. Empty input → a fresh minimal config.
 */
export function mergeV2Config(existingText) {
  const raw = typeof existingText === "string" ? existingText : "";
  let text = raw.trim() === "" ? "{}\n" : raw;
  const errors = [];
  const cfg = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { text: raw, changed: false, corrupt: raw.trim() !== "" };
  }
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  const edit = (path, value) => {
    text = applyEdits(text, modify(text, path, value, fmt));
  };

  if (Array.isArray(cfg.plugin)) {
    const kept = cfg.plugin.filter((p) => !(typeof p === "string" && p.startsWith(CLAUDE_AUTH_FAMILY)));
    if (kept.length !== cfg.plugin.length) edit(["plugin"], kept.length > 0 ? kept : undefined);
  }
  if (cfg.permission === undefined) {
    edit(["permission"], { external_directory: "ask" });
  } else if (cfg.permission && typeof cfg.permission === "object" && !Array.isArray(cfg.permission)) {
    if (cfg.permission.external_directory === undefined) edit(["permission", "external_directory"], "ask");
  } // a string/other global permission is the user's own choice — leave it
  if (cfg.instructions === undefined) {
    edit(["instructions"], ["CLAUDE.md"]);
  } else if (Array.isArray(cfg.instructions) && !cfg.instructions.includes("CLAUDE.md")) {
    edit(["instructions"], [...cfg.instructions, "CLAUDE.md"]);
  }
  const out = text.endsWith("\n") ? text : `${text}\n`;
  return { text: out, changed: out !== raw, corrupt: false };
}

// --------------------------------------------------------------- default I/O

const nodeFs = { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile };

function defaultExec(cmd, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function exists(fs, p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256Of(fs, p) {
  return createHash("sha256").update(await fs.readFile(p)).digest("hex");
}

async function readJson(fs, p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- steps

/** Create `~/.manta/opencode-password` (0600) if absent/empty; re-assert 0600 otherwise. */
export async function ensurePasswordFile({ file = passwordFilePath(), fs = nodeFs, randomHex = newPassword } = {}) {
  let created = false;
  let current = "";
  try {
    current = (await fs.readFile(file, "utf8")).trim();
  } catch {
    current = "";
  }
  if (!current) {
    await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${randomHex()}\n`, { mode: 0o600 });
    created = true;
  }
  await fs.chmod(file, 0o600);
  return { file, created };
}

/**
 * Install the release's pinned V2 binary. `src` is `<home>/vendor/opencode/opencode`
 * with its `.sha256` sidecar written at pack time; a mismatch refuses the install.
 * Idempotent (identical content → no write). Returns { changed, bin }.
 */
export async function installPinnedBinary({ src, destDir, fs = nodeFs } = {}) {
  const dest = join(destDir, "opencode");
  if (!(await exists(fs, src))) return { changed: false, bin: dest, missing: true };
  const want = (await fs.readFile(`${src}.sha256`, "utf8").catch(() => "")).trim().split(/\s+/)[0];
  if (!want) throw new Error(`pinned opencode binary has no .sha256 sidecar (${src}) — refusing to install it`);
  const have = await sha256Of(fs, src);
  if (have !== want) throw new Error(`pinned opencode binary failed its integrity check (${src})`);
  if ((await exists(fs, dest)) && (await sha256Of(fs, dest)) === want) return { changed: false, bin: dest };
  await fs.mkdir(destDir, { recursive: true });
  const tmp = `${dest}.new-${process.pid}`;
  await fs.copyFile(src, tmp);
  await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, dest); // atomic; a running V1 keeps its old inode
  return { changed: true, bin: dest };
}

/** docs/opencode-plugins-v2/<name>/ → <configDir>/plugins/<name>/ (replace, atomically per plugin). */
export async function installV2Plugins({ srcDir, configDir, manifest, fs = nodeFs } = {}) {
  let changed = false;
  if (!(await exists(fs, srcDir))) return { changed, installed: [], missing: true };
  const pluginsDir = join(configDir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  const installed = [];
  for (const name of V2_PLUGINS) {
    const from = join(srcDir, name);
    if (!(await exists(fs, from))) continue;
    const to = join(pluginsDir, name);
    const tmp = `${to}.new-${process.pid}`;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.cp(from, tmp, {
      recursive: true,
      filter: (p) => !/\.test\.[cm]?[jt]sx?$/.test(p) && !p.split("/").includes("node_modules"),
    });
    if ((await exists(fs, to)) && (await sameTree(fs, tmp, to))) {
      await fs.rm(tmp, { recursive: true, force: true });
    } else {
      await fs.rm(to, { recursive: true, force: true });
      await fs.rename(tmp, to);
      changed = true;
    }
    installed.push(name);
  }
  if (manifest) {
    await fs.mkdir(dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, `${installed.join("\n")}\n`);
  }
  return { changed, installed };
}

async function listFiles(fs, root, rel = "") {
  const out = [];
  for (const ent of await fs.readdir(join(root, rel), { withFileTypes: true })) {
    const r = join(rel, ent.name);
    if (ent.isDirectory()) out.push(...(await listFiles(fs, root, r)));
    else out.push(r);
  }
  return out.sort();
}
async function sameTree(fs, a, b) {
  const [fa, fb] = await Promise.all([listFiles(fs, a), listFiles(fs, b)]);
  if (fa.join("\n") !== fb.join("\n")) return false;
  for (const f of fa) {
    if ((await fs.readFile(join(a, f))).compare(await fs.readFile(join(b, f))) !== 0) return false;
  }
  return true;
}

/**
 * Retire what V1 needed: Manta's V1 tools + V1 plugins (backed up first), and the config
 * entries. Safe to call repeatedly. Returns { removed: string[], configChanged }.
 */
export async function retireV1Assets({ configDir, backupDir = v1BackupDir(), fs = nodeFs } = {}) {
  const removed = [];
  await fs.mkdir(backupDir, { recursive: true });
  const configFile = join(configDir, "opencode.jsonc");

  // Config first (+ a one-time backup, so a rollback gets the user's own file back).
  const hadConfig = await exists(fs, configFile);
  const backupConfig = join(backupDir, "opencode.jsonc");
  if (hadConfig && !(await exists(fs, backupConfig))) await fs.copyFile(configFile, backupConfig);
  const before = hadConfig ? await fs.readFile(configFile, "utf8") : "";
  const merged = mergeV2Config(before);
  let configChanged = false;
  if (!merged.corrupt && merged.text !== before) {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFile, merged.text);
    configChanged = true;
  }

  for (const [sub, names] of [["tools", V1_TOOL_FILES], ["plugins", V1_PLUGIN_FILES]]) {
    for (const name of names) {
      const p = join(configDir, sub, name);
      if (!(await exists(fs, p))) continue;
      const bak = join(backupDir, sub, name);
      await fs.mkdir(dirname(bak), { recursive: true });
      if (!(await exists(fs, bak))) await fs.copyFile(p, bak);
      await fs.rm(p, { force: true });
      removed.push(`${sub}/${name}`);
    }
  }
  // The shell-side sync manifest tracked those V1 plugins; with them gone it must not resurrect them.
  await fs.rm(join(stateHome(), STATE_DIRNAME, "opencode-plugins.manifest"), { force: true });
  return { removed, configChanged };
}

/** Undo retireV1Assets from the backup (rollback). */
export async function restoreV1Assets({ configDir, backupDir = v1BackupDir(), fs = nodeFs } = {}) {
  const restored = [];
  const bakConfig = join(backupDir, "opencode.jsonc");
  if (await exists(fs, bakConfig)) {
    await fs.mkdir(configDir, { recursive: true });
    await fs.copyFile(bakConfig, join(configDir, "opencode.jsonc"));
    restored.push("opencode.jsonc");
  }
  for (const [sub, names] of [["tools", V1_TOOL_FILES], ["plugins", V1_PLUGIN_FILES]]) {
    for (const name of names) {
      const bak = join(backupDir, sub, name);
      if (!(await exists(fs, bak))) continue;
      await fs.mkdir(join(configDir, sub), { recursive: true });
      await fs.copyFile(bak, join(configDir, sub, name));
      restored.push(`${sub}/${name}`);
    }
  }
  return { restored };
}

/**
 * The whole routine. Never restarts anything. Returns
 *   { migrationNeeded, bin, passwordFile, passwordCreated, binaryChanged, pluginsChanged, serviceChanged, retired }
 * `bin` is the binary the opencode SERVICE must run right now: the preserved V1
 * binary while a migration is pending, else the pinned V2.
 */
export async function prepareOpencodeV2({
  mantaHome,
  home = homedir(),
  env = process.env,
  fs = nodeFs,
  exec = defaultExec,
  // `log` MUST be declared before `service`: default parameters evaluate left to right, and the
  // `service` default reads `log` — declared after it, every call that did not inject a service
  // (i.e. the real CLI, on every box) died with "Cannot access 'log' before initialization".
  log = () => {},
  service = createOpencodeService({ home, exec: (c, a) => exec(c, a).then((stdout) => ({ stdout, stderr: "" })), log }),
  readState = () => readJson(nodeFs, migrationStatePath()),
  writeState = (s) => nodeFs.writeFile(migrationStatePath(), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 }),
} = {}) {
  const binDir = join(home, ".opencode", "bin");
  const v2Bin = join(binDir, "opencode");
  const v1Bin = opencodeBinPath("v1", home);
  const configDir = opencodeConfigDir(home);

  const password = await ensurePasswordFile({ fs });

  // A checkout that does not carry the pinned binary (a dev box running from git) cannot go to V2:
  // leave it exactly as it is rather than half-migrating it.
  const vendorSrc = join(mantaHome, "vendor", "opencode", "opencode");
  if (!(await exists(fs, vendorSrc))) {
    log("[prepare] no vendor/opencode binary in this release — leaving opencode as it is");
    return {
      migrationNeeded: false, bin: v2Bin, passwordFile: password.file, passwordCreated: password.created,
      binaryChanged: false, binaryMissing: true, pluginsChanged: false, serviceChanged: false, retired: null,
    };
  }

  // Decide BEFORE the binary is replaced: afterwards "was V1" is no longer observable.
  const state = await readState();
  let installedMajor = null;
  if (await exists(fs, v2Bin)) installedMajor = parseMajor(await exec(v2Bin, ["--version"]).catch(() => ""));
  const v1BinaryKept = await exists(fs, v1Bin);
  const dbExists = await exists(fs, resolveV1DbPath({ env, home }));
  const migrationNeeded = computeMigrationNeeded({ dbExists, state, installedMajor, v1BinaryKept });

  // Keep the V1 binary (rollback target) and pin the service to it, THEN swap in V2.
  if (migrationNeeded && installedMajor === 1 && !v1BinaryKept) {
    await fs.mkdir(binDir, { recursive: true });
    await fs.copyFile(v2Bin, v1Bin);
    await fs.chmod(v1Bin, 0o755);
  }
  // Pin the service to V1 so V2 can never start on a raw V1 DB before the preflight — but never
  // while an upgrade is mid-flight (the flow itself owns the service definition then).
  let serviceChanged = false;
  if (migrationNeeded && state?.state !== "running" && (await exists(fs, v1Bin))) {
    serviceChanged = await service.configure("v1");
  }

  const bin = await installPinnedBinary({ src: vendorSrc, destDir: binDir, fs });
  const plugins = await installV2Plugins({
    srcDir: join(mantaHome, "docs", "opencode-plugins-v2"),
    configDir,
    manifest: join(stateHome(), STATE_DIRNAME, "opencode-plugins-v2.manifest"),
    fs,
  });

  let retired = null;
  if (!migrationNeeded) {
    retired = await retireV1Assets({ configDir, fs });
    // A V2-capable box with nothing to migrate (fresh install, or a V1 box without history) needs
    // its service definition brought to V2: pinned binary, password, and the DB a finished
    // copy-mode migration chose (without it the service would open an empty one).
    const done = state?.state === "completed" && state?.mode === "copy" ? state.targetDb : null;
    serviceChanged = await service.configure("v2", { db: done });
  } else if (!state) await writeState({ version: 1, state: "idle", createdAt: Date.now() });

  return {
    migrationNeeded,
    bin: migrationNeeded ? v1Bin : v2Bin,
    passwordFile: password.file,
    passwordCreated: password.created,
    binaryChanged: bin.changed,
    binaryMissing: false,
    pluginsChanged: plugins.changed,
    serviceChanged,
    retired,
  };
}

// ------------------------------------------------------------- CLI bridge
// node upgradeV2Prepare.mjs prepare --home <MANTA_HOME>   → KEY='value' lines for `eval`
// node upgradeV2Prepare.mjs db-env                         → the OPENCODE_DB the service must keep ('' = none)

const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
  if (cmd === "prepare") {
    const mantaHome = flags.home || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const r = await prepareOpencodeV2({ mantaHome, log: (m) => process.stderr.write(`${m}\n`) });
    process.stdout.write(
      [
        `MIGRATION_NEEDED=${r.migrationNeeded ? 1 : 0}`,
        `OPENCODE_BIN=${q(r.bin)}`,
        `OPENCODE_PASSWORD_FILE=${q(r.passwordFile)}`,
        `OPENCODE_BINARY_CHANGED=${r.binaryChanged || r.serviceChanged ? 1 : 0}`,
        `OPENCODE_PLUGINS_CHANGED=${r.pluginsChanged ? 1 : 0}`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (cmd === "db-env") {
    const st = await readJson(nodeFs, migrationStatePath());
    // Only a finished copy-mode migration persists a custom DB; mid-flight the service is rewritten by the flow itself.
    const db = st?.state === "completed" && st?.mode === "copy" && st?.targetDb ? st.targetDb : "";
    process.stdout.write(db);
    return 0;
  }
  process.stderr.write("usage: upgradeV2Prepare.mjs <prepare --home DIR | db-env>\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`upgradeV2Prepare: ${e?.message ?? e}\n`);
      process.exit(1);
    },
  );
}

// Re-exports used by callers that need only the path helpers.
export { opencodeBinPath, passwordFilePath };

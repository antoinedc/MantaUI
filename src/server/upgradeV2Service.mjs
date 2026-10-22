// upgradeV2Service.mjs — controls the box's opencode SERVICE for the V1 → V2
// upgrade (slice C3): switch which binary it runs (V1 kept for rollback / the
// pinned V2), set or drop the env it needs (OPENCODE_PASSWORD, OPENCODE_DB), and
// stop / restart it — on all three supervisors the installer knows
// (systemd --user unit, launchd LaunchAgent, nohup fallback).
//
// WHY THIS LIVES IN THE SERVER and not only in install.sh: an installed box runs
// the self-update.sh it ALREADY had (the "two-hop" gap), so the first update to
// this release performs the payload swap with the OLD script and the NEW server
// code is what has to finish the job. The upgrade flow needs to flip the unit
// between V1 and V2 at specific moments (V2 must never auto-migrate a raw V1
// database before the disk preflight has run), so the definition edits are done
// here, in place, exactly like release.sh's ensure_opencode_cli_version does for
// the Claude Code version claim.
//
// Pure text transforms (patchUnitText) + an injected-I/O controller
// (createOpencodeService). Nothing here touches the live box unless the real
// `exec` / fs are passed in — tests inject fakes.

import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateHome, STATE_DIRNAME } from "../shared/paths.mjs";

export const OPENCODE_UNIT = "opencode-serve.service";
export const OPENCODE_PLIST_LABEL = "com.mantaui.opencode";
export const OPENCODE_PORT = 4096;

/** `~/.opencode/bin` (the pinned V2 binary + the preserved V1 binary live here). */
export function opencodeBinDir(home = homedir()) {
  return join(home, ".opencode", "bin");
}
export function opencodeBinPath(variant, home = homedir()) {
  return join(opencodeBinDir(home), variant === "v1" ? "opencode-v1" : "opencode");
}

/** `~/.manta/opencode-password` — K1's single source for the fixed password. */
export function passwordFilePath() {
  return join(stateHome(), STATE_DIRNAME, "opencode-password");
}

/**
 * K1's password reader — LAZY on purpose. The password file may be created AFTER this process
 * started (the first boot of a release creates it in the very routine that starts the upgrade),
 * so nothing may snapshot "no password" for the life of the process: every call reads the file,
 * an empty/missing file is an error (never cached as ""), and `MANTA_OPENCODE_PASSWORD` wins
 * (tests). Exported so every part of manta-server that talks to OpenCode shares ONE reader
 * (slice C1's `opencodeAuthHeader()` should call this instead of caching at import time).
 */
export async function readOpencodePassword({ env = process.env, file = passwordFilePath(), read = (p) => readFile(p, "utf8") } = {}) {
  const fromEnv = typeof env.MANTA_OPENCODE_PASSWORD === "string" ? env.MANTA_OPENCODE_PASSWORD.trim() : "";
  if (fromEnv) return fromEnv;
  let text = "";
  try {
    text = (await read(file)).trim();
  } catch (e) {
    throw new Error(`OpenCode password file is not readable (${file}): ${e?.code ?? e?.message ?? e}`);
  }
  if (!text) throw new Error(`OpenCode password file is empty (${file})`);
  return text;
}

// ---------------------------------------------------------------- systemd text

const ENV_LINE = (key) => new RegExp(`^Environment=(?:"${key}=.*"|${key}=.*)$`);

/** First token of `ExecStart=`, i.e. the opencode binary the unit runs. */
export function unitExecBin(text) {
  const m = /^ExecStart=(\S+)/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** Value of `Environment=KEY=…` (unquoted form install.sh writes), or null. */
export function unitEnvValue(text, key) {
  for (const line of String(text ?? "").split("\n")) {
    if (ENV_LINE(key).test(line)) return line.replace(/^Environment="?/, "").replace(/"$/, "").slice(key.length + 1);
  }
  return null;
}

/**
 * Patch a systemd unit's text: set the binary and add / replace / drop
 * `Environment=` lines inside [Service]. Idempotent; text without a [Service]
 * section is returned unchanged (nothing safe to anchor on).
 *   env[KEY] = string → set;  env[KEY] = null → remove the line.
 */
export function patchUnitText(text, { bin, env = {} } = {}) {
  let out = String(text ?? "");
  if (!/^\[Service\]$/m.test(out)) return out;
  if (bin) out = out.replace(/^ExecStart=\S+/m, `ExecStart=${bin}`);
  for (const [key, value] of Object.entries(env)) {
    const lines = out.split("\n");
    const idx = lines.findIndex((l) => ENV_LINE(key).test(l));
    if (value === null || value === undefined || value === "") {
      if (idx >= 0) lines.splice(idx, 1);
    } else {
      // systemd splits an unquoted Environment= on whitespace — quote when it matters.
      const line = /\s/.test(value) ? `Environment="${key}=${value}"` : `Environment=${key}=${value}`;
      if (idx >= 0) lines[idx] = line;
      else lines.splice(lines.findIndex((l) => l === "[Service]") + 1, 0, line);
    }
    out = lines.join("\n");
  }
  return out;
}

// -------------------------------------------------------------------- the rest

/** Which supervisor runs opencode on this box. */
export function detectSupervisor({ platform = process.platform, unitExists = false, plistExists = false } = {}) {
  if (platform === "darwin") return plistExists ? "launchd" : "nohup";
  return unitExists ? "systemd" : "nohup";
}

/** The env a given variant of the service must carry. `null` = must be absent. */
export function serviceEnvFor(variant, { password, db }) {
  if (variant === "v1") {
    // V1 must not see the V2 password (it would start demanding it) nor a V2 db.
    return { OPENCODE_PASSWORD: null, OPENCODE_DB: null };
  }
  return { OPENCODE_PASSWORD: password, OPENCODE_DB: db || null };
}

const defaultExec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * @param {object} [deps]  all injectable; defaults are the real thing.
 */
export function createOpencodeService({
  platform = process.platform,
  home = homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  exec = defaultExec,
  read = (p) => readFile(p, "utf8"),
  write = (p, t, mode) => writeFile(p, t, { mode }),
  exists = (p) => existsSync(p),
  readPassword = () => readOpencodePassword({ env: {} }),
  spawnDetached = null, // nohup mode: (bin, args, env) => void
  killNohup = null, // nohup mode: () => Promise<void>
  port = OPENCODE_PORT, // overridable ONLY so a rehearsal/test can never bind (or kill) the real :4096
  log = () => {},
} = {}) {
  const unitPath = join(home, ".config", "systemd", "user", OPENCODE_UNIT);
  const plistPath = join(home, "Library", "LaunchAgents", `${OPENCODE_PLIST_LABEL}.plist`);
  const supervisor = detectSupervisor({ platform, unitExists: exists(unitPath), plistExists: exists(plistPath) });
  const plistBuddy = "/usr/libexec/PlistBuddy";
  const pb = (cmd) => exec(plistBuddy, ["-c", cmd, plistPath]);

  async function configureSystemd(variant, { db }) {
    const password = variant === "v2" ? await readPassword() : null;
    const current = await read(unitPath);
    const patched = patchUnitText(current, {
      bin: opencodeBinPath(variant, home),
      env: { ...serviceEnvFor(variant, { password, db }), OPENCODE_DISABLE_AUTOUPDATE: variant === "v2" ? "true" : null },
    });
    const changed = patched !== current;
    if (changed) {
      // 0600: the unit carries OPENCODE_PASSWORD.
      await write(unitPath, patched, 0o600);
      await chmod(unitPath, 0o600).catch(() => {});
      await exec("systemctl", ["--user", "daemon-reload"]);
    }
    return changed;
  }

  async function configureLaunchd(variant, { db }) {
    const password = variant === "v2" ? await readPassword() : null;
    let changed = false;
    const get = async (k) => (await pb(`Print ${k}`).then((r) => String(r.stdout ?? "").trim(), () => null));
    const bin = opencodeBinPath(variant, home);
    if ((await get(":ProgramArguments:0")) !== bin) {
      await pb(`Set :ProgramArguments:0 ${bin}`);
      changed = true;
    }
    const env = { ...serviceEnvFor(variant, { password, db }), OPENCODE_DISABLE_AUTOUPDATE: variant === "v2" ? "true" : null };
    for (const [key, value] of Object.entries(env)) {
      const k = `:EnvironmentVariables:${key}`;
      const have = await get(k);
      if (value === null || value === undefined || value === "") {
        if (have !== null && have !== "") {
          await pb(`Delete ${k}`).catch(() => {}); // absent already is fine
          changed = true;
        }
      } else if (have !== value) {
        if (!(await pb(`Set ${k} ${value}`).then(() => true, () => false))) await pb(`Add ${k} string ${value}`);
        changed = true;
      }
    }
    await chmod(plistPath, 0o600).catch(() => {});
    return changed;
  }

  return {
    supervisor,
    unitPath,
    plistPath,

    /**
     * Point the service at V1 or V2 (and set/drop its env) WITHOUT restarting it. Returns whether
     * the definition changed (so a caller can tell if a restart is owed). nohup has no
     * definition: it is remembered and applied by the next start().
     */
    async configure(variant, { db = null } = {}) {
      log(`[upgrade] service → ${variant}${db ? ` db=${db}` : ""} (${supervisor})`);
      if (supervisor === "systemd") return configureSystemd(variant, { db });
      if (supervisor === "launchd") return configureLaunchd(variant, { db });
      this._nohup = { variant, db };
      return false;
    },

    /** Cheap liveness probe, for callers that must not bounce a running V2. */
    async isRunning() {
      if (supervisor === "systemd") {
        const { stdout } = await exec("systemctl", ["--user", "is-active", "opencode-serve"]);
        return stdout.trim() === "active";
      }
      if (supervisor === "launchd") {
        const r = await exec("launchctl", ["print", `gui/${uid}/${OPENCODE_PLIST_LABEL}`]).catch(() => null);
        return r ? /state = running|pid = \d/.test(r.stdout) : false;
      }
      // nohup has no cheap probe; a start() restart there is cheap anyway
      return false;
    },

    async stop() {
      if (supervisor === "systemd") return void (await exec("systemctl", ["--user", "stop", "opencode-serve"]));
      if (supervisor === "launchd") {
        return void (await exec("launchctl", ["bootout", `gui/${uid}/${OPENCODE_PLIST_LABEL}`]).catch(() => {}));
      }
      if (killNohup) await killNohup();
    },

    /** (Re)start with the definition as currently configured. (On nohup: stop whatever is there, then spawn.) */
    async start() {
      if (supervisor === "systemd") return void (await exec("systemctl", ["--user", "restart", "opencode-serve"]));
      if (supervisor === "launchd") {
        // bootout+bootstrap, never kickstart -k: kickstart restarts from launchd's STALE copy
        // of the definition, which would silently ignore the edit configure() just made.
        await exec("launchctl", ["bootout", `gui/${uid}/${OPENCODE_PLIST_LABEL}`]).catch(() => {});
        return void (await exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath]));
      }
      if (!spawnDetached) throw new Error("no supervisor found for opencode and no nohup launcher provided");
      // start() means RESTART everywhere: a second start (the cutover) must not leave two servers
      // fighting over the port.
      if (killNohup) await killNohup();
      const cfg = this._nohup ?? { variant: "v2", db: null };
      const password = cfg.variant === "v2" ? await readPassword() : null;
      const env = {};
      for (const [k, v] of Object.entries({
        ...serviceEnvFor(cfg.variant, { password, db: cfg.db }),
        OPENCODE_DISABLE_AUTOUPDATE: cfg.variant === "v2" ? "true" : null,
      })) {
        if (v) env[k] = v;
      }
      spawnDetached(opencodeBinPath(cfg.variant, home), ["serve", "--port", String(port), "--hostname", "127.0.0.1"], env);
    },
  };
}

// SSH ControlMaster transport for the unified network layer (BET-46.3).
//
// Implements the stage-2 `Transport` interface (open / close / ping) on top of
// the SAME shared SSH ControlMaster that pty.ts and opencode.ts already use
// (ControlPath=/tmp/bui-cm-%C, ControlPersist=10m). A `ConnectionManager` (see
// src/shared/net/connectionManager.ts) drives this transport through the
// connect / health-check / stall→heal lifecycle; this file is the thin,
// SSH-specific glue that ConnectionManager stays agnostic of.
//
//   open()  → ensure a live master exists. `ssh -O check`; if it reports no
//             live master, (re)establish one with a trivial `ssh … true`
//             (ControlMaster=auto boots the socket as a side effect, exactly
//             like runSshOnce does elsewhere).
//   ping()  → cheap liveness probe: `ssh -O check`. Resolves iff a live master
//             answers, rejects otherwise — the manager's health loop treats a
//             rejection as a stall.
//   close() → `ssh -O exit` on the control path — graceful master shutdown.
//
// The heal decision logic for ORPHANED sockets (a prior run's master still
// holding the -L forward port) lives in ./forwardHeal.ts and is exercised by
// the forward path in opencode.ts; `evictOrphanForwardHolder` here wires the
// pure decision to the shell so both the transport and opencode share ONE
// implementation.
//
// Everything that touches the shell goes through an injectable `SshRunner` so
// the transport unit-tests without spawning a real ssh (no SSH in CI).

import { spawn as cpSpawn } from "node:child_process";
import { join as pathJoin } from "node:path";
import type { Transport } from "../../shared/net/connectionManager.js";
import type { AppConfig } from "../../shared/types.js";
import { decideEviction, parseLsofListeners } from "./forwardHeal.js";

// Must match pty.ts / opencode.ts CONTROL_PATH exactly so we share the ONE
// ControlMaster the whole app multiplexes over. `/tmp` (not tmpdir()) because
// macOS tmpdir() overflows the sun_path limit.
export const CONTROL_PATH = pathJoin("/tmp", "bui-cm-%C");

export function controlArgs(config: AppConfig): string[] {
  const args = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=10m",
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  return args;
}

export function sshTarget(config: AppConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host;
}

export type SpawnResult = { code: number | null; stdout: string; stderr: string };

// Injectable shell surface. The real implementation spawns `ssh` / `lsof` /
// `ps`; tests substitute a fake that returns canned results, so no process is
// ever spawned in CI.
export interface SshRunner {
  /**
   * Spawn `ssh <args>` and resolve with its exit code + captured stdout/stderr.
   * Must NOT reject on a non-zero exit — the caller inspects `code`. Reserve
   * rejection for spawn-level failures (binary missing, etc.).
   */
  runSsh(args: string[]): Promise<SpawnResult>;
  /** Spawn an arbitrary command (`lsof`, `ps`, …) and resolve its stdout. */
  capture(cmd: string, args: string[]): Promise<string>;
}

// Default runner: real child_process spawns. Mirrors the capture helpers that
// previously lived inline in opencode.ts.
export const defaultSshRunner: SshRunner = {
  runSsh(args: string[]): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const p = cpSpawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (b) => (stdout += b.toString()));
      p.stderr.on("data", (b) => (stderr += b.toString()));
      p.on("error", reject);
      p.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  },
  capture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const p = cpSpawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (b) => (out += b.toString()));
      p.on("error", () => resolve(""));
      p.on("exit", () => resolve(out));
    });
  },
};

/**
 * Ask ssh for its *effective* config and read back the expanded ControlPath
 * (the `%C` token resolved to a concrete /tmp/bui-cm-<hash>). This is the
 * socket the live master listens on; an orphan is any OTHER bui socket.
 */
export async function resolveLiveSocket(
  config: AppConfig,
  runner: SshRunner = defaultSshRunner,
): Promise<string | null> {
  const { stdout } = await runner
    .runSsh([...controlArgs(config), "-G", sshTarget(config)])
    .catch(() => ({ code: null, stdout: "", stderr: "" }));
  const line = stdout
    .split("\n")
    .find((l) => l.toLowerCase().startsWith("controlpath "));
  return line ? line.slice("controlpath ".length).trim() : null;
}

export type EvictOutcome =
  | { evicted: true }
  | { evicted: false }
  | { foreign: true; pid: number; command: string };

/**
 * Evict a stale ControlMaster from a previous app run that is still holding
 * `localPort` (kept alive by ControlPersist). Pure decision logic lives in
 * ./forwardHeal.ts (`parseLsofListeners` + `decideEviction`); this wires it to
 * the shell. Returns whether an eviction happened (so the caller can retry the
 * forward), or reports a `foreign` holder the user must resolve manually.
 */
export async function evictOrphanForwardHolder(
  config: AppConfig,
  localPort: number,
  runner: SshRunner = defaultSshRunner,
): Promise<EvictOutcome> {
  const lsofOut = await runner.capture("lsof", [
    "-nP",
    `-iTCP:${localPort}`,
    "-sTCP:LISTEN",
    "-F",
    "pcn",
  ]);
  const holders = parseLsofListeners(lsofOut);
  if (holders.length === 0) return { evicted: false };

  // Full command line per pid so decideEviction can read each ssh's
  // `-o ControlPath=...` and match it against the live socket.
  const psByPid = new Map<number, string>();
  for (const h of holders) {
    const ps = await runner.capture("ps", ["-o", "command=", "-p", String(h.pid)]);
    psByPid.set(h.pid, ps.trim());
  }

  const liveSocket = await resolveLiveSocket(config, runner);
  if (!liveSocket) return { evicted: false };

  const decision = decideEviction(holders, psByPid, liveSocket);
  if (decision.action === "evict") {
    // `ssh -O exit` on the ORPHAN's own socket (not our controlArgs path):
    // graceful master shutdown, which closes its listeners and frees the port.
    // Target the socket explicitly so we never touch the live master.
    await runner
      .runSsh([
        "-o",
        `ControlPath=${decision.socketPath}`,
        "-O",
        "exit",
        sshTarget(config),
      ])
      .catch(() => ({ code: null, stdout: "", stderr: "" }));
    return { evicted: true };
  }
  if (decision.action === "foreign") {
    return { foreign: true, pid: decision.pid, command: decision.command };
  }
  return { evicted: false };
}

/**
 * SSH ControlMaster transport. One per box connection; shares the app-wide
 * ControlMaster socket. Driven by a ConnectionManager.
 */
export class SshTransport implements Transport {
  private readonly config: AppConfig;
  private readonly runner: SshRunner;

  constructor(config: AppConfig, runner: SshRunner = defaultSshRunner) {
    this.config = config;
    this.runner = runner;
  }

  /**
   * Ensure a live ControlMaster exists. If `ssh -O check` fails (no live
   * master, or the socket went stale after sleep/wifi-change/sshd-restart),
   * (re)establish one with a trivial remote command — ControlMaster=auto boots
   * the socket as a side effect, exactly like runSshOnce does elsewhere.
   */
  async open(): Promise<void> {
    if (!this.config.host) throw new Error("No host configured");
    const alive = await this.checkMaster();
    if (alive) return;
    const { code, stderr } = await this.runner.runSsh([
      ...controlArgs(this.config),
      sshTarget(this.config),
      "true",
    ]);
    if (code !== 0) {
      throw new Error(`ssh master boot exited ${code}: ${stderr.trim()}`);
    }
  }

  /** Cheap liveness probe: `ssh -O check`. Rejects when no live master. */
  async ping(): Promise<void> {
    const alive = await this.checkMaster();
    if (!alive) throw new Error("ssh ControlMaster check failed");
  }

  /** `ssh -O exit` — graceful master shutdown. Best-effort; never throws. */
  async close(): Promise<void> {
    await this.runner
      .runSsh([...controlArgs(this.config), "-O", "exit", sshTarget(this.config)])
      .catch(() => ({ code: null, stdout: "", stderr: "" }));
  }

  /** `ssh -O check` → true iff the mux reports a live master. */
  private async checkMaster(): Promise<boolean> {
    const { code } = await this.runner
      .runSsh([...controlArgs(this.config), "-O", "check", sshTarget(this.config)])
      .catch(() => ({ code: null, stdout: "", stderr: "" }));
    return code === 0;
  }
}

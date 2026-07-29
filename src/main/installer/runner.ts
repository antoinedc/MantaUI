// runner.ts — thin I/O wrapper around the system `ssh` binary.
//
// This module is the SINGLE place in the codebase that spawns `ssh`. Every
// other file in the project reaches the box over HTTP (BET-82 / BET-198); the
// install-time SSH connection lives here and dies the moment pairing succeeds.
// The architectural rule from BET-355 is non-negotiable: SSH is installer-only.
// If something in the running app needs to reach the box, it goes over the
// paired HTTP transport — never over SSH.
//
// Why the system `ssh` binary and not a library:
//   - Inherits the user's config, agent, and known-hosts handling for free.
//   - No native module → doesn't break the Windows build (electron-builder
//     sets `npmRebuild: false` and the desktop imports only pure-JS).
//   - `ssh -G <alias>` is the single source of truth for resolving a host
//     alias to its effective connection settings (Includes / Match / defaults).
//
// What's exposed:
//   - execRemote(alias, command, opts)      → one-shot, returns exit code +
//                                              stdout/stderr strings
//   - streamRemote(alias, command, opts)    → streaming; caller supplies a
//                                              sink that receives every chunk
//                                              as it arrives, plus a kill
//                                              handle for cancel
//   - probeSshG(alias)                     → resolve alias → {hostname, user,
//                                              port, identityFiles} via
//                                              `ssh -G <alias>`
//
// `spawn` is injectable so tests can stub it without touching the network. The
// production path uses `child_process.spawn` directly (no library).

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { parseSshG, type ResolvedSshConnection } from "./sshResolved.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess;

// The `ssh` binary path; settable for tests, but default `ssh` is correct on
// every supported platform (macOS, Linux, Windows 10 1809+).
export const SSH_BIN = process.env.MANTA_SSH_BIN ?? "ssh";

// Where install.sh is hosted. The install.sh itself is versioned through the
// release manifest (BET-205 WP5), but install.sh is referenced by stable URL
// (it downloads the versioned tarball at runtime). The desktop shells out to
// exactly this URL so the code path on the box is identical to what the user
// would type by hand.
export const DEFAULT_INSTALL_SH_URL = "https://mantaui.com/install.sh";

// Shared option shape for both the one-shot and streaming variants.
export type RemoteOptions = {
  /** Force a remote PTY (-tt). Defaults to false — preflight probes do not
   *  need one, and `-tt` can corrupt piped stdout on some ssh builds. */
  forceTty?: boolean;
  /** Connect-timeout (-o ConnectTimeout=). Defaults to 10s. */
  connectTimeoutSec?: number;
  /** Inject for tests; defaults to child_process.spawn. */
  spawn?: SpawnFn;
};

// execRemote — run one remote command and return its outcome.
//
// Returns { code, stdout, stderr, signal }. Does NOT throw on a non-zero exit
// — the caller decides what a non-zero means (sudo -n true → code 0 means
// passwordless sudo is available; otherwise it doesn't).
//
// `timeoutMs` (default 30s) bounds the whole call. SSH itself can hang on a
// half-open socket; we mirror the waitForHealth semantics (BET-353) so a
// stalled probe can't stall the preflight.
export type ExecRemoteOptions = RemoteOptions & {
  /** Total call budget. Defaults to 30s. */
  timeoutMs?: number;
};

export type ExecRemoteResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export async function execRemote(
  alias: string,
  command: string,
  options: ExecRemoteOptions = {},
): Promise<ExecRemoteResult> {
  if (typeof alias !== "string" || alias.trim() === "") {
    throw new Error("execRemote: alias is required");
  }
  if (typeof command !== "string" || command === "") {
    throw new Error("execRemote: command is required");
  }
  const spawn = options.spawn ?? nodeSpawn;
  const args: string[] = buildArgs(alias, command, options);
  const child = spawn(SSH_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  if (child.stdout) child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  if (child.stderr) child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (c: number | null, s: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      resolve({ code: c, signal: s });
    };
    timer = setTimeout(() => {
      // Stamp a marker on stderr BEFORE killing — the test (and any human
      // caller) reads this to distinguish a timeout from a clean non-zero
      // exit. Push happens before kill so the chunk order is deterministic.
      stderrChunks.push(Buffer.from(`\n[timed out after ${timeoutMs}ms]`));
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      finish(null, "SIGTERM");
    }, timeoutMs);
    child.on("exit", (c, s) => finish(c, s));
    child.on("error", (err) => {
      stderrChunks.push(Buffer.from(`\n[spawn error: ${err.message}]`));
      finish(-1, null);
    });
  });
  return {
    code,
    signal,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

// streamRemote — like execRemote, but the caller receives each chunk as it
// arrives (and gets a kill handle for cancel).
//
// Used by the install runner: the renderer wants every byte streamed, not
// buffered — the user watches the install live.
export type StreamRemoteOptions = RemoteOptions & {
  onStdout: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type RemoteStreamHandle = {
  /** Resolves when the process exits; rejects on a spawn-time failure. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Send SIGTERM to the in-flight process. Safe to call multiple times. */
  kill: () => void;
};

export function streamRemote(
  alias: string,
  command: string,
  options: StreamRemoteOptions,
): RemoteStreamHandle {
  if (typeof alias !== "string" || alias.trim() === "") {
    throw new Error("streamRemote: alias is required");
  }
  if (typeof command !== "string" || command === "") {
    throw new Error("streamRemote: command is required");
  }
  const spawn = options.spawn ?? nodeSpawn;
  const args = buildArgs(alias, command, options);
  const child = spawn(SSH_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdout) {
    child.stdout.on("data", (c: Buffer) => options.onStdout(c.toString("utf8")));
  }
  if (options.onStderr && child.stderr) {
    child.stderr.on("data", (c: Buffer) =>
      options.onStderr?.(c.toString("utf8")),
    );
  }
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
      child.on("error", (err) => reject(err));
    },
  );
  return {
    done,
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    },
  };
}

// probeSshG — resolve an alias to its effective connection settings by
// shelling out to `ssh -G <alias>`. Single source of truth for the effective
// settings — OpenSSH itself handles Includes / Match / defaults.
//
// `ssh -G` does NOT open a connection; it just prints what the connection
// WOULD look like. A non-zero exit usually means the alias is unparseable
// or `ssh` isn't on PATH. We return an all-nulls ResolvedSshConnection in
// that case so the caller's failure mode is uniform.
export async function probeSshG(
  alias: string,
  options: RemoteOptions = {},
): Promise<ResolvedSshConnection> {
  if (typeof alias !== "string" || alias.trim() === "") {
    throw new Error("probeSshG: alias is required");
  }
  const spawn = options.spawn ?? nodeSpawn;
  const args = ["-G", alias.trim()];
  return new Promise<ResolvedSshConnection>((resolve) => {
    const child = spawn(SSH_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    if (child.stdout) child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => resolve(parseSshG("")));
    child.on("exit", (code) => {
      if (code !== 0) return resolve(parseSshG(""));
      resolve(parseSshG(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

// buildArgs — the shared `-o …` arg layout for `ssh <alias> <command>`.
//
// Centralised so every spawn in this module is identical and a future reader
// can SEE the safety controls in one place (BatchMode=yes is the load-bearing
// one — it forces ssh to NEVER prompt, so a half-configured box fails the
// preflight cleanly instead of hanging the renderer on a passphrase prompt).
function buildArgs(alias: string, command: string, opts: RemoteOptions): string[] {
  return [
    "-o",
    `ConnectTimeout=${opts.connectTimeoutSec ?? 10}`,
    "-o",
    "BatchMode=yes", // never prompt; non-zero exit on key auth failure
    ...(opts.forceTty ? ["-tt"] : []),
    alias.trim(),
    command,
  ];
}

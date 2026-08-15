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
import {
  isEmptySshTarget,
  sshTargetDestination,
  sshTargetExtraArgs,
  type SshTarget,
} from "../../shared/sshTarget.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess;

// The `ssh` binary path; settable for tests, but default `ssh` is correct on
// every supported platform (macOS, Linux, Windows 10 1809+).
export const SSH_BIN = process.env.MANTA_SSH_BIN ?? "ssh";

// Shared option shape for both the one-shot and streaming variants.
export type RemoteOptions = {
  /** Force a remote PTY (-tt). Defaults to false — preflight probes do not
   *  need one, and `-tt` can corrupt piped stdout on some ssh builds. */
  forceTty?: boolean;
  /** Connect-timeout (-o ConnectTimeout=). Defaults to 10s. */
  connectTimeoutSec?: number;
  /** Inject for tests; defaults to child_process.spawn. */
  spawn?: SpawnFn;
  /** Extra environment variables merged into the ssh child's env (BET-360).
   *  Used to set SSH_ASKPASS / SSH_ASKPASS_REQUIRE / MANTA_ASKPASS_FILE for
   *  the passphrase-protected-key flow. When present, the child inherits
   *  process.env with these overlaid — a partial env does NOT erase the
   *  rest of the parent environment. */
  env?: Record<string, string>;
  /** When true, omit `BatchMode=yes` so ssh can prompt via SSH_ASKPASS
   *  (BET-360). Defaults to false — BatchMode=yes is the safe default that
   *  turns an auth failure into a clean non-zero exit instead of hanging on
   *  a passphrase prompt the user can't see. Only the askpass retry path
   *  (preflight returned auth-failed, user entered a passphrase) sets this. */
  allowPrompt?: boolean;
  /** When set, the ssh child's stdin is opened as a pipe and this string
   *  followed by `\n` is written and ended after spawn (BET-979). Used to
   *  deliver the sudo password to the box over a SEPARATE one-shot ssh call,
   *  so the password never appears in the ssh argv (invisible to `ps` on the
   *  box). When absent, stdio[0] stays `"ignore"` — byte-identical to today.
   *  Only meaningful for execRemote (streamRemote never sets it). */
  stdin?: string;
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
  alias: SshTarget,
  command: string,
  options: ExecRemoteOptions = {},
): Promise<ExecRemoteResult> {
  if (isEmptySshTarget(alias)) {
    throw new Error("execRemote: alias is required");
  }
  if (typeof command !== "string" || command === "") {
    throw new Error("execRemote: command is required");
  }
  const spawn = options.spawn ?? nodeSpawn;
  const args: string[] = buildArgs(alias, command, options);
  const child = spawn(SSH_BIN, args, buildSpawnOptions(options));
  // BET-979: deliver the sudo password (or any secret) via stdin, never in
  // argv. `\n` is appended because ssh forwards stdin to the remote
  // `cat > ~/.manta-sudo-pass`, and `cat` needs the terminating newline.
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.write(options.stdin + "\n");
    child.stdin.end();
  }
  return collectChild(child, options.timeoutMs ?? 30_000);
}

// execLocal — run one LOCAL command (no ssh wrapping) and return its outcome.
//
// Used by the Windows client-side preflight probes (BET-362): `ssh-add -l`
// inspects the local OpenSSH agent, which is a property of the desktop
// machine, not the remote box. Same SpawnFn injection + timeout shape as
// execRemote so tests stub it identically. This is the ONE place a non-ssh
// binary is spawned in this module; it stays here so all spawning remains
// centralized (runner.ts is the spawn layer for the installer).
export async function execLocal(
  command: string,
  args: string[],
  options: { spawn?: SpawnFn; timeoutMs?: number } = {},
): Promise<ExecRemoteResult> {
  if (typeof command !== "string" || command === "") {
    throw new Error("execLocal: command is required");
  }
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  return collectChild(child, options.timeoutMs ?? 30_000);
}

// collectChild — shared stdout/stderr collection + timeout + exit/error
// handling for a spawned ChildProcess. Both execRemote (ssh-wrapped) and
// execLocal (bare local command) route through here so the collection logic
// lives in ONE place (the duplication gate would otherwise flag the copy).
//
// Does NOT throw on non-zero exit — the caller classifies the meaning. A
// timeout stamps a marker on stderr BEFORE killing so a caller can tell a
// timeout from a clean non-zero exit.
async function collectChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<ExecRemoteResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  if (child.stdout) child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  if (child.stderr) child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
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
  alias: SshTarget,
  command: string,
  options: StreamRemoteOptions,
): RemoteStreamHandle {
  if (isEmptySshTarget(alias)) {
    throw new Error("streamRemote: alias is required");
  }
  if (typeof command !== "string" || command === "") {
    throw new Error("streamRemote: command is required");
  }
  const spawn = options.spawn ?? nodeSpawn;
  const args = buildArgs(alias, command, options);
  const child = spawn(SSH_BIN, args, buildSpawnOptions(options));
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
//
// A custom target (BET-384) contributes `-p` / `-i` via sshTargetExtraArgs —
// this is the ONE place that turns a resolved SshTarget into argv, so an
// alias and a custom host produce an identical argv shape apart from those
// two flags and the destination itself.
//
// The `--` before the destination (review cycle 1 nit, defence in depth):
// a custom target's Host-or-IP field is user-typed with no validation
// against a leading `-`, and without a terminator ssh(1) reads a
// destination like `-oProxyCommand=…` as another option rather than a
// (bogus) hostname — verified empirically: `ssh -o … -oFoo=x true` fails
// with "Bad configuration option: foobarbaz" (parsed as a flag), while
// `ssh -o … -- -oFoo=x true` fails with "hostname contains invalid
// characters" (correctly read as the destination). Not a live
// vulnerability today (spawn runs without `shell: true`, so there's no
// shell to inject into), but `--` closes the shape at zero cost and
// covers both the alias and custom-target branches from this one site.
function buildArgs(alias: SshTarget, command: string, opts: RemoteOptions): string[] {
  return [
    "-o",
    `ConnectTimeout=${opts.connectTimeoutSec ?? 10}`,
    // BatchMode=yes forces ssh to NEVER prompt — a half-configured box fails
    // the preflight cleanly instead of hanging. The ONE exception is the
    // askpass retry path (BET-360): when the key is passphrase-protected and
    // not in ssh-agent, BatchMode would suppress the very SSH_ASKPASS prompt
    // we need, so `allowPrompt` drops it for that retry only.
    ...(opts.allowPrompt ? [] : ["-o", "BatchMode=yes"]),
    ...sshTargetExtraArgs(alias),
    ...(opts.forceTty ? ["-tt"] : []),
    "--",
    sshTargetDestination(alias),
    command,
  ];
}

// buildSpawnOptions — shared spawn options for every ssh child in this module.
// Merges the askpass env (if any) over process.env so the child inherits the
// full parent environment plus SSH_ASKPASS / SSH_ASKPASS_REQUIRE / etc.
// Without the spread, Node's spawn replaces the env entirely when `env` is set
// (e.g. PATH would be lost) — we always overlay, never replace.
function buildSpawnOptions(opts: RemoteOptions): Parameters<typeof nodeSpawn>[2] {
  // BET-979: with stdin, open a pipe so execRemote can write the secret to
  // the child; without it, stdio[0] stays `"ignore"` (byte-identical).
  const base: Parameters<typeof nodeSpawn>[2] = {
    stdio: opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  };
  if (opts.env) {
    base.env = { ...process.env, ...opts.env };
  }
  return base;
}

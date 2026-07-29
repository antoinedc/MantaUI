// installer.ts — the orchestrator that the renderer's "install" button drives.
//
// Architecture (BET-355 non-negotiable): this is the ONLY file in the codebase
// that drives an ssh-anything. The renderer talks to it over the IPC channels
// in src/shared/types.ts (sshInstallList / sshInstallPreflight / sshInstallStart
// / sshInstallCancel / sshInstallDiagnostics). The transport after pairing
// success is HTTP, same as every other box call — ssh dies when pairing lands.
//
// The orchestrator composes the pure helpers:
//   - sshConfig.ts       — list aliases from ~/.ssh/config
//   - sshResolved.ts     — parse `ssh -G <alias>` output
//   - preflight.ts       — classify the probe results
//   - stageMapper.ts     — fold the install log into UI stages
//   - diagnostics.ts     — redact credentials for the bug-report blob
//   - runner.ts          — thin I/O wrapper around `ssh`
//
// Plus the existing claim path in src/main/auth.ts — the ONLY writer of box
// credentials (constraint #4: "One config writer"). claimPairing(...) does the
// POST + persist atomically and returns the boxId/boxToken we mirror into
// the run result.
//
// Injectable deps (spawn, fetch) let the unit tests cover every branch
// without touching the network. Production wires the defaults.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  execRemote,
  streamRemote,
  type ExecRemoteResult,
  type SpawnFn,
} from "./runner.js";
import { parseSshConfig, type SshHostEntry } from "./sshConfig.js";
import { isEmptySshTarget, type SshTarget } from "../../shared/sshTarget.js";
import { isValidBoxToken } from "../../shared/transport.mjs";
import {
  resolveChannel,
  channelConfig,
} from "../../shared/channel.mjs";
import {
  classifyPreflight,
  type PreflightProbes,
  type PreflightResult,
  type Reachability,
} from "./preflight.js";
import { parseFingerprint, isHostKeyVerificationFailure, type HostFingerprint } from "./fingerprint.js";
import {
  foldChunk,
  buildStageSnapshot,
  type InstallStageId,
} from "./stageMapper.js";
import { claimPairing } from "../auth.js";
import type { ClaimOutcome } from "../../shared/claim.mjs";
import type { AppConfig } from "../../shared/types.js";

export type { SpawnFn } from "./runner.js";

// Build-channel plumbing (BET-370). Same baked global as src/main/index.ts
// reads — the `define` injection lives in electron.vite.config.ts and the
// ambient declaration in src/main/buildDefines.d.ts. The install command
// the orchestrator runs is channel-specific (install.sh URL + release host),
// so it must resolve the channel here too. `resolveChannel` is the one rule;
// everything below is a `channelConfig(CHANNEL).…` lookup.
//
// Computed lazily (via `resolveChannelConfig()`) rather than at module load:
// the orchestrator's unit tests stub `spawn` and never load Electron, so a
// top-level `app.isPackaged` read would crash before any test runs. The
// `app` lookup is a runtime `require("electron")` that succeeds in
// production (Electron is the host process) and yields `undefined` in the
// vitest environment; in that case we resolve as `isPackaged=false` which
// falls through to the dev channel — a no-op for tests that override
// `installShUrl` directly.
const BAKED_CHANNEL =
  typeof __MANTA_CHANNEL__ === "string" ? __MANTA_CHANNEL__ : "prod";

function resolveChannelConfig() {
  let isPackaged = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { app?: { isPackaged?: boolean } };
    isPackaged = electron.app?.isPackaged === true;
  } catch {
    // require("electron") threw — Electron is not the host. Treat as dev.
  }
  return channelConfig(resolveChannel(isPackaged, BAKED_CHANNEL));
}

// Default location of the user's SSH config. ~/.ssh/config on macOS / Linux;
// the same path on Windows 10 1809+ (OpenSSH ships in the box). The
// `MANTA_SSH_CONFIG` env override exists for tests.
export const DEFAULT_SSH_CONFIG_PATH = join(homedir(), ".ssh", "config");

// Remote commands used by the preflight probes. Each is one short command
// intended to be safe to run with BatchMode=yes (no prompt). The login-shell
// wrapper (`bash -lc`) is required because the install addendum documents
// that non-login SSH sessions don't source the rc files that put `~/bin` on
// PATH — and we never want a probe silently failing because the user's
// PATH-restructuring lives in .bashrc.
const PROBE_OS_CMD = "bash -lc 'uname -s; uname -m; uname -r'";
const PROBE_REACHABILITY_CMD =
  "bash -lc 'command -v true >/dev/null 2>&1 && echo ok || echo no-true'";
const PROBE_SUDO_CMD = "bash -lc 'sudo -n true 2>/dev/null; echo $?'";
const PROBE_TAILSCALE_CMD =
  "bash -lc 'command -v tailscale >/dev/null 2>&1 || exit 1; tailscale status --json 2>/dev/null'";
const PROBE_CLOCK_CMD = "bash -lc 'date -u +%s'";
const PROBE_AUTH_FILE_CMD =
  "bash -lc 'test -f ~/.manta/auth.json && echo INSTALLED || echo FRESH'";

// The one-line install command. `installShUrl` and `releaseHost` come from
// the current build channel (CHANNEL_CONFIG) — the orchestrator only knows
// about SSH; the channel lives in src/shared/channel.mjs and is injected
// here via the module-level CHANNEL constant.
//
// MANTA_RELEASE_HOST is passed unconditionally on every channel. For prod
// the value is identical to install.sh's own default, so there is no
// behaviour change; for staging the box fetches the staging manifest +
// tarball, which is the entire point of the channel split. The single
// command shape keeps the wire-format tests trivial (BET-370 §Tests).
function buildInstallCommand(installShUrl: string, releaseHost: string): string {
  return `bash -lc 'curl -fsSL ${installShUrl} | MANTA_RELEASE_HOST=${releaseHost} bash'`;
}

// ===========================================================================
// listSshHosts — read ~/.ssh/config and return the alias list for the picker.
// Pure: reads file, returns array. Caller wires the path through (default
// DEFAULT_SSH_CONFIG_PATH) so tests can point at a fixture.
// ===========================================================================

export function listSshHosts(sshConfigPath: string = DEFAULT_SSH_CONFIG_PATH): SshHostEntry[] {
  if (typeof sshConfigPath !== "string" || sshConfigPath === "") return [];
  if (!existsSync(sshConfigPath)) return [];
  let text: string;
  try {
    text = readFileSync(sshConfigPath, "utf8");
  } catch {
    return [];
  }
  return parseSshConfig(text);
}

// ===========================================================================
// preflightBox — run every probe over SSH + classify the verdict.
// ===========================================================================

export type PreflightDeps = {
  spawn?: SpawnFn;
};

export async function preflightBox(
  alias: SshTarget,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  if (isEmptySshTarget(alias)) {
    throw new Error("preflightBox: alias is required");
  }
  const spawn = deps.spawn;
  // Run the five probes in parallel — they're independent and each bounded
  // by execRemote's timeoutMs. We collect the structured results and pass
  // them to classifyPreflight.
  const [reach, osRes, sudoRes, tsRes, clockRes, authFileRes] = await Promise.all([
    probeReachability(alias, spawn),
    probeOs(alias, spawn),
    probeSudo(alias, spawn),
    probeTailscale(alias, spawn),
    probeClock(alias, spawn),
    probeAuthFile(alias, spawn),
  ]);
  const probes: PreflightProbes = {
    reachability: reach.reachability,
    hostFingerprint: reach.fingerprint,
    os: osRes,
    passwordlessSudo: sudoRes,
    tailscale: tsRes,
    clockSkewSeconds: clockRes,
    alreadyInstalled: authFileRes,
  };
  return classifyPreflight(probes);
}

// ---------- individual probes ----------

// probeReachability returns BOTH the reachability verdict and, when ssh
// offered a host-key fingerprint on a never-seen host, that fingerprint.
// The fingerprint is what installerStart hands to the renderer's "Trust
// this host" prompt (BET-361); without it the trust UI has nothing to show.
type ReachabilityProbe = {
  reachability: Reachability;
  fingerprint: HostFingerprint | null;
};

async function probeReachability(alias: SshTarget, spawn?: SpawnFn): Promise<ReachabilityProbe> {
  // BatchMode=yes turns "no auth" into exit code 255 / stderr "Permission
  // denied (publickey)" — not a hang on a passphrase prompt.
  const r = await execRemote(alias, PROBE_REACHABILITY_CMD, {
    spawn,
    timeoutMs: 15_000,
  });
  if (r.code === 0 && r.stdout.trim() === "ok") {
    return { reachability: "ok", fingerprint: null };
  }
  // Never-seen host: ssh prints the fingerprint then fails with "Host key
  // verification failed." Detect the fingerprint and surface it so the
  // installer can pause for a trust decision instead of mislabeling this
  // as a generic unreachable / auth-failed (BET-361).
  const fp = parseFingerprint(r.stderr);
  if (fp.found) {
    return { reachability: "unknown-host", fingerprint: fp.fingerprint };
  }
  // The two well-known BatchMode=yes failure modes:
  //   exit 255 + "Permission denied (publickey)" → auth-failed
  //   exit 255 + "Connection refused" / "No route to host" / "Could not
  //   resolve hostname" → unreachable
  if (r.code === 255 || r.code === null) {
    if (isHostKeyVerificationFailure(r.stderr)) {
      // Host-key refusal without a parseable fingerprint (rare ssh build):
      // still unknown-host, but with no fingerprint to show — the trust UI
      // cannot verify a key against nothing, so treat as unreachable and
      // let the standard failure guidance surface.
      return { reachability: "unreachable", fingerprint: null };
    }
    const stderr = r.stderr;
    if (/Permission denied/i.test(stderr) || /publickey/i.test(stderr)) {
      return { reachability: "auth-failed", fingerprint: null };
    }
    return { reachability: "unreachable", fingerprint: null };
  }
  // Any other exit → unreachable (network glitch mid-probe, ssh missing on
  // the box, etc.)
  return { reachability: "unreachable", fingerprint: null };
}

async function probeOs(alias: SshTarget, spawn?: SpawnFn): Promise<PreflightProbes["os"]> {
  const r = await execRemote(alias, PROBE_OS_CMD, { spawn, timeoutMs: 10_000 });
  if (r.code !== 0) {
    return { id: "unknown", arch: "unknown", release: null };
  }
  const [kernel, archRaw, release] = r.stdout.split(/\r?\n/).map((s) => s.trim());
  return {
    id: kernel === "Darwin" ? "darwin" : kernel === "Linux" ? "linux" : "unknown",
    arch: archRaw === "x86_64" ? "x64" : archRaw === "arm64" || archRaw === "aarch64" ? "arm64" : "unknown",
    release: release || null,
  };
}

async function probeSudo(alias: SshTarget, spawn?: SpawnFn): Promise<boolean> {
  const r = await execRemote(alias, PROBE_SUDO_CMD, { spawn, timeoutMs: 10_000 });
  // `sudo -n true` exit 0 + no password prompt → passwordless sudo.
  // Anything else (exit != 0, or "password" in stderr) → not available.
  if (r.code === 0) return !/password/i.test(r.stderr);
  return false;
}

async function probeTailscale(alias: SshTarget, spawn?: SpawnFn): Promise<PreflightProbes["tailscale"]> {
  const r = await execRemote(alias, PROBE_TAILSCALE_CMD, { spawn, timeoutMs: 10_000 });
  if (r.code !== 0 || r.stdout.trim() === "") {
    return { running: false, ipv4: null };
  }
  const parsed = parseTailscaleJson(r.stdout);
  return parsed ?? { running: false, ipv4: null };
}

async function probeClock(alias: SshTarget, spawn?: SpawnFn): Promise<number> {
  const local = Math.floor(Date.now() / 1000);
  const r = await execRemote(alias, PROBE_CLOCK_CMD, { spawn, timeoutMs: 10_000 });
  if (r.code !== 0) return 0;
  const remote = Number(r.stdout.trim());
  if (!Number.isFinite(remote)) return 0;
  return local - remote;
}

async function probeAuthFile(alias: SshTarget, spawn?: SpawnFn): Promise<boolean> {
  const r = await execRemote(alias, PROBE_AUTH_FILE_CMD, { spawn, timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.trim() === "INSTALLED";
}

// parseTailscaleJson — minimal `tailscale status --json` extractor. We only
// need BackendState ("Running" required) + the first IPv4 from
// Self.TailscaleIPs. Anything else is ignored. The server-side
// install-lib.mjs `parseTailscaleStatus` does the same job; this is the
// desktop-side twin that runs without depending on install-lib (the box may
// not have install-lib yet during preflight).
function parseTailscaleJson(text: string): PreflightProbes["tailscale"] | null {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.BackendState !== "Running") return null;
  const ips = parsed?.Self?.TailscaleIPs;
  if (!Array.isArray(ips)) return null;
  for (const candidate of ips) {
    if (typeof candidate === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(candidate)) {
      return { running: true, ipv4: candidate };
    }
  }
  return null;
}

// ===========================================================================
// runInstall — stream scripts/install.sh over SSH, fold the log into stages.
// ===========================================================================

export type InstallDeps = {
  spawn?: SpawnFn;
  installShUrl?: string;
};

export type InstallSink = {
  onLine?: (line: string) => void;
  onStage?: (stage: InstallStageId) => void;
};

export type InstallHandle = {
  /** Resolves with the install's exit code + signal. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM the in-flight install. Idempotent. */
  cancel: () => void;
};

export function runInstall(
  alias: SshTarget,
  sink: InstallSink,
  deps: InstallDeps = {},
): InstallHandle {
  if (isEmptySshTarget(alias)) {
    throw new Error("runInstall: alias is required");
  }
  // Local name `cfg` (not `channelConfig`) so it doesn't shadow the imported
  // `channelConfig` function for the rest of this module — a future reader
  // scanning the call sites should be able to tell "is this a record or a
  // function?" at a glance (N1 from the reviewer).
  const cfg = resolveChannelConfig();
  const installShUrl = deps.installShUrl ?? cfg.installShUrl;
  // We force a remote PTY (-tt) so install.sh's color codes survive (the
  // POC addendum documents this: install.sh's log/ok/warn helpers emit
  // CSI color sequences, and we want them to land in stdout so the stage
  // mapper's prefix-matching still works after we strip them).
  //
  // TERM=xterm-256color is inherited from this process; nothing to set here.
  const handle = streamRemote(alias, buildInstallCommand(installShUrl, cfg.releaseHost), {
    forceTty: true,
    spawn: deps.spawn,
    onStdout: (chunk) => pumpChunk(chunk, "stdout", sink),
    onStderr: (chunk) => pumpChunk(chunk, "stderr", sink),
  });
  let cancelled = false;
  return {
    done: handle.done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      handle.kill();
    },
  };
}

// Module-level fold state. We keep ONE in-flight install per process —
// constraint #5 says "two installers writing the same files at once is
// not" allowed. The IPC layer's lock prevents two renderer invocations,
// but the module-level state here is the belt to that suspenders.
let currentStage: InstallStageId = "preflight";
let pending = "";

// pumpChunk — feed a new chunk into the fold and emit per-line + stage
// transition events. Strips ANSI (already done by stripAnsi per-line in
// foldChunk) and dispatches the line text + the new stage.
function pumpChunk(chunk: string, _stream: "stdout" | "stderr", sink: InstallSink): void {
  // Fold across newlines: the chunk may end mid-line; carry the partial
  // tail forward so we never split a single log line into two emissions.
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? "";
  if (lines.length === 0) return;
  const text = lines.join("\n") + "\n";
  const before = currentStage;
  const out = foldChunk(text, currentStage);
  currentStage = out.currentStage;
  for (const ln of out.lines) {
    sink.onLine?.(ln.text);
  }
  if (currentStage !== before) {
    sink.onStage?.(currentStage);
  }
  void buildStageSnapshot; // re-exported via types below; surface the helper for tests
}

// stageSnapshot — exposed for tests (the UI reads it from the renderer side
// after this module reports a stage transition).
export function stageSnapshot(): ReturnType<typeof buildStageSnapshot> {
  return buildStageSnapshot(currentStage);
}

// ===========================================================================
// mintAndClaim — loopback-mint a pairing code over SSH, claim it via the box's
// public URL, and persist credentials through the existing claim path.
// ===========================================================================

export type MintAndClaimDeps = {
  spawn?: SpawnFn;
  fetchImpl?: typeof fetch;
  /** Persistence callback (main's `commit`). REQUIRED — the installer must
   *  not invent a second config writer (constraint #4). */
  persist: (patch: Partial<AppConfig>) => void;
  /** Optional override for the box's claim URL — defaults to the serverUrl
   *  parsed out of `manta pair` output. */
  claimUrlOverride?: string;
};

/**
 * Mint a pairing code over the existing SSH connection, claim it via the
 * box's reachable URL, and persist credentials. Returns the classified
 * ClaimOutcome from src/main/auth.ts (same shape as the manual claim path).
 *
 * The SSH-minted code is preferred over scraping from the install log
 * (BET-355 issue §5: "Do not scrape the code out of the install log —
 * that is fragile"). Running `manta pair` over SSH is exactly what a user
 * would do after a manual install, and it returns a clean
 * {pairing_code, box_id, serverUrl} block the desktop parses.
 */
export async function mintAndClaim(
  alias: SshTarget,
  deps: MintAndClaimDeps,
): Promise<ClaimOutcome> {
  if (isEmptySshTarget(alias)) {
    throw new Error("mintAndClaim: alias is required");
  }
  if (typeof deps.persist !== "function") {
    throw new Error("mintAndClaim: persist callback is required");
  }
  const spawn = deps.spawn;
  const fetched = await execRemote(alias, "bash -lc 'manta pair'", {
    spawn,
    timeoutMs: 30_000,
  });
  if (fetched.code !== 0) {
    return {
      ok: false,
      kind: "network",
      message: `manta pair exited ${fetched.code} on the box`,
    };
  }
  const parsed = parseMintOutput(fetched);
  if (!parsed.ok) {
    return parsed.outcome;
  }
  const claimUrl =
    typeof deps.claimUrlOverride === "string" && deps.claimUrlOverride !== ""
      ? deps.claimUrlOverride
      : parsed.serverUrl;
  if (!isValidBoxToken(parsed.boxId)) {
    return {
      ok: false,
      kind: "invalid_response",
      message: "box did not return a valid 32-hex box_id",
    };
  }
  // Reuse the existing claim path — single source of truth for box
  // credentials (constraint #4).
  return claimPairing(
    { serverUrl: claimUrl, boxId: parsed.boxId, code: parsed.code },
    deps.persist,
    deps.fetchImpl,
  );
}

type MintParseOk = {
  ok: true;
  code: string;
  boxId: string;
  serverUrl: string;
};
type MintParseFail = {
  ok: false;
  outcome: ClaimOutcome;
};

function parseMintOutput(r: ExecRemoteResult): MintParseOk | MintParseFail {
  // The formatPairingOutput block has stable labels:
  //   "  Pairing code:  <6 digits>"
  //   "  Box ID:        <32 hex>"
  //   "  Server URL:    <url>"   (only on tailscale path; public path
  //                                derives https://<boxId>.boxes.mantaui.com)
  const codeMatch = /Pairing code:\s+(\d{6})/.exec(r.stdout);
  if (!codeMatch) {
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: "invalid_response",
        message: "could not parse a 6-digit pairing code from manta pair output",
      },
    };
  }
  const boxMatch = /Box ID:\s+([0-9a-f]{32})/i.exec(r.stdout);
  if (!boxMatch) {
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: "invalid_response",
        message: "could not parse a box_id from manta pair output",
      },
    };
  }
  const urlMatch = /Server URL:\s+(\S+)/.exec(r.stdout);
  return {
    ok: true,
    code: codeMatch[1],
    boxId: boxMatch[1].toLowerCase(),
    serverUrl: urlMatch ? urlMatch[1] : "",
  };
}

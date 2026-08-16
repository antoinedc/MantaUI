// knownHosts.ts — persist a trusted host key into ~/.ssh/known_hosts.
//
// The fingerprint the user saw (fingerprint.ts) is a SHA256 HASH of the
// host's public key, not the key itself — so it cannot be written directly
// into known_hosts. To get the actual key we run `ssh-keyscan`, compute
// each returned key's SHA256 fingerprint, and keep ONLY the key whose
// fingerprint matches the one the user just trusted. That match is the
// security-critical step: it guarantees the key we persist is provably the
// one whose fingerprint was shown, closing the MITM gap that a blind
// `ssh-keyscan >> known_hosts` (or `StrictHostKeyChecking=accept-new`)
// would leave open.
//
// After the line lands, BatchMode=yes connections accept the host on the
// next connect — so the preflight re-run and every later pairing flow
// (manual PairStep, mobile) skip the prompt entirely.
//
// I/O is injectable: `spawn` (for ssh-keyscan and `ssh -G` alias
// resolution) and the known_hosts path default to the real system values
// but are overridable in tests. The atomic write (temp file + rename,
// mode 0600) preserves existing entries and never leaves a half-written
// file.

import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { probeSshG } from "./runner.js";
import {
  sshTargetDestination,
  type SshTarget,
} from "../../shared/sshTarget.js";
import type { SpawnFn } from "./runner.js";
import type { HostFingerprint } from "./fingerprint.js";

export type { SpawnFn } from "./runner.js";

export const DEFAULT_KNOWN_HOSTS_PATH = join(homedir(), ".ssh", "known_hosts");

export type TrustHostInput = {
  /** The host-picker target the install is running against. */
  target: SshTarget;
  /** The fingerprint the user just trusted (from parseFingerprint). */
  fingerprint: HostFingerprint;
  /** Override for tests; defaults to ~/.ssh/known_hosts. */
  knownHostsPath?: string;
};

export type TrustHostResult =
  | { ok: true; line: string }
  | {
      ok: false;
      reason: "resolve-failed" | "keyscan-failed" | "fingerprint-mismatch" | "write-failed";
      message: string;
    };

export type TrustHostDeps = {
  spawn?: SpawnFn;
};

// ---------------------------------------------------------------------------
// resolveKnownHostsKey — turn an SshTarget into the (hostname, port) ssh
// uses to look up the host key. A custom target carries both fields; an
// alias is resolved through `ssh -G <alias>` (the single source of truth
// for the effective connection settings, after Includes / Match).
// ---------------------------------------------------------------------------

export type ResolvedHostKey = {
  hostname: string;
  port: number;
};

export async function resolveKnownHostsKey(
  target: SshTarget,
  deps: TrustHostDeps = {},
): Promise<ResolvedHostKey> {
  if (typeof target === "string") {
    const resolved = await probeSshG(target, { spawn: deps.spawn });
    return {
      hostname: resolved.hostname ?? target,
      port: resolved.port ?? 22,
    };
  }
  return {
    hostname: target.host,
    port: target.port ?? 22,
  };
}

// ---------------------------------------------------------------------------
// scanHostKeys — run `ssh-keyscan` and return every (algo, key) pair it
// emits. Bounded by a timeout so a hung scan can't stall the trust step.
// ---------------------------------------------------------------------------

export type ScannedHostKey = { algo: string; keyBase64: string };

const KEYSCAN_BIN = process.env.MANTA_SSH_KEYSCAN_BIN ?? "ssh-keyscan";
const KEYSCAN_TIMEOUT_MS = 20_000;

export function scanHostKeys(
  hostname: string,
  port: number,
  deps: TrustHostDeps = {},
): Promise<ScannedHostKey[]> {
  const spawn = deps.spawn ?? nodeSpawn;
  const args = [
    "-t",
    "ed25519,rsa,ecdsa",
    ...(port !== 22 ? ["-p", String(port)] : []),
    "--",
    hostname,
  ];
  return new Promise<ScannedHostKey[]>((resolve) => {
    const child = spawn(KEYSCAN_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (out: ScannedHostKey[]) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(out);
    };
    if (child.stdout) child.stdout.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      finish([]);
    }, KEYSCAN_TIMEOUT_MS);
    child.on("exit", () => finish(parseKeyScanOutput(Buffer.concat(chunks).toString("utf8"))));
    child.on("error", () => finish([]));
  });
}

/**
 * Parse `ssh-keyscan` stdout into `{ algo, keyBase64 }` pairs. Comment
 * lines (leading `#`) and any line without a recognized algo token are
 * dropped. The host field ssh-keyscan emits is intentionally ignored —
 * the caller rebuilds the known_hosts host field from the resolved
 * (hostname, port) so the `[host]:port` bracketing is always correct
 * regardless of how ssh-keyscan chose to print it.
 */
export function parseKeyScanOutput(stdout: string): ScannedHostKey[] {
  if (typeof stdout !== "string" || stdout === "") return [];
  const out: ScannedHostKey[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    // parts[0] = host field (ignored); parts[1] = algo; parts[2] = key.
    const algo = parts[1];
    const keyBase64 = parts[2];
    if (!/^(ssh-|ecdsa-)/.test(algo)) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(keyBase64)) continue;
    out.push({ algo, keyBase64 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// computeFingerprint — SHA256 fingerprint of a base64-encoded host key, in
// the `SHA256:<base64>` form OpenSSH prints. Used to match a scanned key
// against the fingerprint the user trusted.
// ---------------------------------------------------------------------------

export function computeFingerprint(keyBase64: string): string {
  const keyBytes = Buffer.from(keyBase64, "base64");
  const hash = createHash("sha256").update(keyBytes).digest("base64");
  return `SHA256:${hash}`;
}

/** Compare two `SHA256:<base64>` fingerprints, ignoring base64 padding
 *  (`=`) which OpenSSH emits inconsistently across versions. */
export function fingerprintsMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.replace(/=+$/g, "") === b.replace(/=+$/g, "");
}

// ---------------------------------------------------------------------------
// hostKeyAlgoLabel / probeOfferedFingerprint — the probing half of the trust
// flow. See installer.ts probeReachability for why the fingerprint has to be
// FETCHED (ssh-keyscan) instead of scraped off an ssh failure.
// ---------------------------------------------------------------------------

/**
 * OpenSSH's own algorithm token (`ssh-ed25519`) → the display name the
 * fingerprint card shows (`ED25519`), matching what parseFingerprint
 * normalises to. Pure.
 */
export function hostKeyAlgoLabel(algo: string): string {
  const a = String(algo).toLowerCase();
  if (a.includes("ed25519")) return "ED25519";
  if (a.includes("ecdsa")) return "ECDSA";
  if (a.includes("rsa")) return "RSA";
  if (a.includes("dss") || a.includes("dsa")) return "DSA";
  return algo.toUpperCase();
}

/**
 * The fingerprint a host is currently offering, fetched with ssh-keyscan.
 *
 * WHY THIS EXISTS: a non-interactive `ssh` prints only "Host key verification
 * failed." on a never-seen host — the fingerprint block parseFingerprint looks
 * for is emitted ONLY on an interactive terminal, which a desktop app never
 * has (verified against OpenSSH 9.6). So the fingerprint has to be fetched,
 * not scraped. This is NOT a weaker trust model: the fingerprint shown to the
 * user is unauthenticated either way, and the real guarantee is unchanged —
 * the user compares it out of band, and trustHost re-scans and refuses to
 * write a key whose hash does not match what was shown.
 *
 * Returns null when the target cannot be resolved or offers no usable key;
 * the caller then falls back to the ordinary "unreachable" verdict.
 */
export async function probeOfferedFingerprint(
  target: SshTarget,
  deps: TrustHostDeps = {},
): Promise<HostFingerprint | null> {
  let resolved: ResolvedHostKey;
  try {
    resolved = await resolveKnownHostsKey(target, deps);
  } catch {
    return null;
  }
  if (!resolved.hostname || resolved.hostname.trim() === "") return null;
  const keys = await scanHostKeys(resolved.hostname, resolved.port, deps);
  if (keys.length === 0) return null;
  // Prefer the algorithm OpenSSH itself prefers, so the key we show is the
  // key a later connection will actually be offered.
  const preferred =
    keys.find((k) => k.algo === "ssh-ed25519") ??
    keys.find((k) => k.algo.startsWith("ecdsa-")) ??
    keys.find((k) => k.algo === "ssh-rsa") ??
    keys[0];
  return {
    algo: hostKeyAlgoLabel(preferred.algo),
    sha256: computeFingerprint(preferred.keyBase64),
  };
}

// ---------------------------------------------------------------------------
// formatKnownHostsLine — the single known_hosts entry. Non-default ports
// use the bracketed `[host]:port` form ssh looks up; port 22 is bare.
// ---------------------------------------------------------------------------

export function formatKnownHostsLine(
  hostname: string,
  port: number,
  algo: string,
  keyBase64: string,
): string {
  const hostField = port !== 22 ? `[${hostname}]:${port}` : hostname;
  return `${hostField} ${algo} ${keyBase64}`;
}

// ---------------------------------------------------------------------------
// appendKnownHostsLine — atomic, idempotent append. Reads the existing
// file (if any), skips when the exact line is already present (so re-trust
// is a no-op), and writes the full content through a temp file + rename
// with mode 0600. The ~/.ssh directory is created if missing.
// ---------------------------------------------------------------------------

export function appendKnownHostsLine(
  path: string,
  line: string,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.includes(line)) return;
  lines.push(line);
  const content = lines.join("\n") + "\n";
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      // rename across filesystems can fail; fall back to a direct write.
      writeFileSync(path, content, { mode: 0o600 });
    } catch {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// trustHost — the orchestrator. Resolve the host, scan its keys, find the
// one whose fingerprint matches what the user trusted, write its
// known_hosts line. Returns a structured result the installer handler
// turns into either a resumed install or a preflight-failed event.
// ---------------------------------------------------------------------------

export async function trustHost(
  input: TrustHostInput,
  deps: TrustHostDeps = {},
): Promise<TrustHostResult> {
  const knownHostsPath = input.knownHostsPath ?? DEFAULT_KNOWN_HOSTS_PATH;
  let resolved: ResolvedHostKey;
  try {
    resolved = await resolveKnownHostsKey(input.target, deps);
  } catch (err) {
    return {
      ok: false,
      reason: "resolve-failed",
      message: `Could not resolve the host's address: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!resolved.hostname || resolved.hostname.trim() === "") {
    return {
      ok: false,
      reason: "resolve-failed",
      message: "Could not resolve the host's address from the selected target.",
    };
  }

  const keys = await scanHostKeys(resolved.hostname, resolved.port, deps);
  if (keys.length === 0) {
    return {
      ok: false,
      reason: "keyscan-failed",
      message: `ssh-keyscan returned no keys for ${sshTargetDestination(input.target)}.`,
    };
  }

  const trusted = keys.find((k) =>
    fingerprintsMatch(computeFingerprint(k.keyBase64), input.fingerprint.sha256),
  );
  if (!trusted) {
    return {
      ok: false,
      reason: "fingerprint-mismatch",
      message:
        "The key the host presented does not match the fingerprint you were shown. Do not trust this host — it may be a different machine.",
    };
  }

  const line = formatKnownHostsLine(
    resolved.hostname,
    resolved.port,
    trusted.algo,
    trusted.keyBase64,
  );
  try {
    appendKnownHostsLine(knownHostsPath, line);
  } catch (err) {
    return {
      ok: false,
      reason: "write-failed",
      message: `Could not write to ~/.ssh/known_hosts: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, line };
}

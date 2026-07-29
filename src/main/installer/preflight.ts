// preflight.ts — classify the result of the SSH-driven preflight into the
// decision the installer uses to start the install.
//
// WHY PURE: every preflight decision (OS/arch support, sudo presence, tailscale
// detection, clock skew, install-already-present) is a tiny classification that
// has to be TESTABLE without spawning ssh — and must STAY in lock-step with
// `scripts/install.sh`'s `SKIP_PUBLIC_TLS` predicate (line 1160:
//     if [ "$INGRESS_MODE" = "tailscale" ] || [ "$IS_MACOS" = "1" ]; then
//         SKIP_PUBLIC_TLS=1
//     fi
// ). The installer calls the same predicates so the preflight display shows
// the user EXACTLY the path the install will take — there must be one source
// of truth for "which install path applies", per the issue's constraint #3.
//
// Inputs come from runner.ts probes over SSH (silent reachability, OS/arch,
// sudo -n true, tailscale status, clock). The decision is:
//   - decideIngressMode(...)   → which install branch the script will run
//   - classifyPreflight(...)    → top-level "proceed / fail" verdict +
//                                 structured `failures[]` for the UI to render
//                                 as plain-language cause + one suggested
//                                 action per failure
//
// Pure: takes the raw probe results, returns structured objects. Tested in
// preflight.test.ts.

import type { HostFingerprint } from "./fingerprint.js";

export type OsId = "linux" | "darwin" | "unknown";
export type Arch = "x64" | "arm64" | "unknown";

export type OsInfo = {
  id: OsId;
  arch: Arch;
  /** human-readable kernel release, e.g. "6.5.0-44-generic" — for diagnostics */
  release: string | null;
};

export type Reachability = "ok" | "auth-failed" | "unreachable" | "unknown-host";

export type TailscaleState = {
  /** `command -v tailscale` succeeded AND `tailscale status --json` had BackendState=Running. */
  running: boolean;
  /** First IPv4 from `tailscale status --json` Self.TailscaleIPs, or null. */
  ipv4: string | null;
};

// Windows-only client-side probes (BET-362). Unlike every other probe these
// inspect the LOCAL machine running the desktop app, not the remote box —
// the OpenSSH Agent service and PuTTY-format keys are Windows-client quirks
// that surface as an SSH auth failure with no actionable hint. They are
// `not-windows` on every non-Win32 host so the Unix flow is untouched.
export type WindowsAgentState =
  /** Not a Windows host — probe skipped, never produces a failure. */
  | "not-windows"
  /** `ssh-add -l` exited 0 with at least one identity listed. */
  | "ok"
  /** Agent reachable but lists no identities (exit 1). */
  | "no-identities"
  /** Agent not running / not accessible (exit 2 or spawn failure). */
  | "no-agent";

export type KeyFormatState =
  /** Not a Windows host — probe skipped, never produces a failure. */
  | "not-windows"
  /** No default ~/.ssh/id_* key is in PuTTY (.ppk) format. */
  | "ok"
  /** At least one default ~/.ssh/id_* key has the `PuTTY-User-Key-File-2:` header. */
  | "putty";

export type PreflightProbes = {
  reachability: Reachability;
  /** The host-key fingerprint ssh offered on a never-seen host, when
   *  reachability is "unknown-host". Null in every other case. Populated by
   *  probeReachability from the ssh stderr block (fingerprint.ts). */
  hostFingerprint: HostFingerprint | null;
  os: OsInfo;
  /** `sudo -n true` exited 0 over the SSH connection. */
  passwordlessSudo: boolean;
  /** `tailscale status --json` parsed cleanly with BackendState=Running. */
  tailscale: TailscaleState;
  /** Local clock − remote clock, in seconds (rounded). Negative = remote ahead. */
  clockSkewSeconds: number;
  /** `~/.manta/auth.json` already exists on the box. */
  alreadyInstalled: boolean;
  /** Local OpenSSH agent state (Windows-only; `not-windows` elsewhere). */
  windowsAgent: WindowsAgentState;
  /** Local default key format (Windows-only; `not-windows` elsewhere). */
  keyFormat: KeyFormatState;
};

// ---------- Ingress mode (mirrors install.sh:1160 + 1031) ----------

export type IngressMode =
  /** sudo is available, no tailscale → Caddy + Let's Encrypt + DNS registration. */
  | "public-tls"
  /** sudo is NOT available, no tailscale → bring-your-own proxy instructions. */
  | "no-root"
  /** Tailscale is running → skip Caddy + DNS, the box binds the tailnet IP. */
  | "tailscale"
  /** macOS box without Tailscale → loopback-only, the renderer will reach it
   *  via Tailscale (or not at all off-network). Same shape as install.sh's
   *  macOS path: no Caddy, no apt, no public DNS. */
  | "macos-loopback";

/**
 * Resolve which install path applies — single source of truth, mirrors the
 * predicate in scripts/install.sh (line 1160) verbatim:
 *
 *   if [ "$INGRESS_MODE" = "tailscale" ] || [ "$IS_MACOS" = "1" ]; then
 *     SKIP_PUBLIC_TLS=1
 *   fi
 *
 * `INGRESS_MODE` itself is decided upstream (tailscale detection OR explicit
 * MANTA_INGRESS override) — we collapse the four candidate modes into the
 * two install.sh really branches on (public-tls / skip) PLUS the
 * tailnet-vs-loopback distinction the user needs to see in the preflight
 * panel.
 */
export function decideIngressMode(probes: PreflightProbes): IngressMode {
  if (probes.tailscale.running) return "tailscale";
  if (probes.os.id === "darwin") return "macos-loopback";
  if (probes.passwordlessSudo) return "public-tls";
  return "no-root";
}

// ---------- OS / arch support matrix (mirrors install.sh:104-123) ----------

/** True when the (OS, arch) is on the installer's supported list. */
export function isSupportedTarget(os: OsInfo): boolean {
  if (os.id === "linux" && (os.arch === "x64" || os.arch === "arm64")) return true;
  if (os.id === "darwin" && os.arch === "arm64") return true;
  return false;
}

/**
 * Short human label for the (OS, arch) pair — used in the preflight panel.
 * Returns null when the pair is unsupported (caller renders the failure with
 * the actionable install.sh-style hint instead).
 */
export function targetLabel(os: OsInfo): string | null {
  if (os.id === "linux") {
    if (os.arch === "x64") return "Linux x86_64";
    if (os.arch === "arm64") return "Linux aarch64";
    return null;
  }
  if (os.id === "darwin") {
    if (os.arch === "arm64") return "macOS Apple Silicon";
    return null;
  }
  return null;
}

// ---------- Top-level verdict ----------

export type PreflightFailure = {
  /** Plain-language cause, suitable for a one-line UI error. */
  cause: string;
  /** Exactly one concrete action the user can take. */
  action: string;
};

export type PreflightResult = {
  /** True when the install can start (no failures). */
  ok: boolean;
  /** Resolved install path (which branch of the script will run). */
  ingressMode: IngressMode;
  /** Echo of the probes, for the UI to render in the disclosure panel. */
  probes: PreflightProbes;
  /** Structured failures the UI renders one-per-line with the cause + action. */
  failures: PreflightFailure[];
  /** When the host is unknown and ssh offered a fingerprint, this carries it
   *  so installerStart can pause for a trust decision instead of hard-failing.
   *  Null for every other verdict (ok, unreachable, auth-failed, etc.). */
  unknownHost: HostFingerprint | null;
};

// Clock skew: a wrong box clock silently breaks Let's Encrypt issuance and
// OAuth flows outright — there is no "proceed anyway" that actually works,
// so past a 60s threshold this is a hard failure, not a warning (BET-383).
// NTP typically keeps things inside a few seconds — 60s is a "definitely
// broken" cutoff.
const CLOCK_SKEW_FAIL_SECONDS = 60;

/**
 * Classify a set of probe results into the preflight verdict the UI renders
 * and the installer branches on. Pure — no I/O. Tests pass fabricated probe
 * objects (see preflight.test.ts) to assert on every branch.
 *
 * Rules:
 *   - unreachable / auth-failed → fail (one structured failure)
 *   - unsupported OS/arch       → fail (one structured failure)
 *   - clock skew > 60s          → fail (breaks cert issuance + OAuth outright)
 *   - already installed         → not a failure — installer is idempotent
 *                                  and re-runnable, so this is a no-op signal,
 *                                  echoed in `probes` for diagnostics only
 *   - Windows client quirks     → on a Windows host, when auth already failed,
 *                                  a PuTTY-format key / disabled agent / empty
 *                                  agent each add a structured failure with the
 *                                  Windows-specific fix (BET-362). Never fire
 *                                  when auth succeeded — a working setup must
 *                                  not be blocked by an unused .ppk file.
 *   - everything else            → ok
 */
export function classifyPreflight(probes: PreflightProbes): PreflightResult {
  const failures: PreflightFailure[] = [];

  // Unknown host: ssh printed a fingerprint and bailed (BatchMode=yes
  // suppresses the interactive yes/no). This is NOT a hard failure — the
  // installer pauses for a trust decision (BET-361) — so we short-circuit
  // with a single guidance failure and surface the fingerprint. The OS /
  // clock / sudo checks are meaningless until the host can be reached, so
  // they are skipped here (they would otherwise pile on "unsupported
  // unknown/unknown" noise the user cannot act on before trusting).
  if (probes.reachability === "unknown-host") {
    return {
      ok: false,
      ingressMode: decideIngressMode(probes),
      probes,
      failures: [
        {
          cause: "This host's identity is not yet trusted.",
          action:
            "Review the host key fingerprint and choose Trust to continue, or pick a different host.",
        },
      ],
      unknownHost: probes.hostFingerprint,
    };
  }

  if (probes.reachability === "unreachable") {
    failures.push({
      cause: "Could not connect to the host over SSH.",
      action:
        "Check the alias resolves, the box is reachable, and SSH is running on the expected port.",
    });
  } else if (probes.reachability === "auth-failed") {
    failures.push({
      cause: "SSH key authentication was rejected.",
      action:
        "Make sure your key is loaded (ssh-add) and listed in the box's ~/.ssh/authorized_keys.",
    });
  }

  if (!isSupportedTarget(probes.os)) {
    const label = targetLabel(probes.os);
    if (label === null) {
      const why =
        probes.os.id === "darwin"
          ? "Intel Macs are not supported as a MantaUI box."
          : probes.os.id === "linux"
          ? `Linux ${probes.os.arch} is not on the supported list (the installer ships x86_64 and aarch64).`
          : "The installer does not support this operating system.";
      failures.push({
        cause: `Unsupported target: ${probes.os.id}/${probes.os.arch}.`,
        action: why,
      });
    }
  }

  const skew = Math.abs(probes.clockSkewSeconds);
  if (skew > CLOCK_SKEW_FAIL_SECONDS) {
    failures.push({
      cause: `Box clock is off by ${skew}s.`,
      action:
        "Certificate issuance and OAuth will fail. Sync the box's time, then try again.",
    });
  }

  // alreadyInstalled is NOT a failure or a warning — install.sh is
  // idempotent and already says so in its own log. The probe is still
  // echoed in `probes` for diagnostics.

  // Windows client-side checks (BET-362). Both the disabled OpenSSH Agent
  // service and a PuTTY-format key manifest as the auth-failed reachability
  // above, with no hint of the real cause. We only surface them when auth
  // actually failed: a working Windows setup (unencrypted OpenSSH key, or a
  // key the agent already holds) reaches `ok` and must NOT be blocked by a
  // stray .ppk file sitting unused in ~/.ssh. Gating on auth-failed keeps
  // every Windows check a hard failure (BET-383: no soft-warning channel)
  // without aborting an install that would have succeeded.
  if (probes.reachability === "auth-failed") {
    if (probes.keyFormat === "putty") {
      failures.push({
        cause: "PuTTY-format key detected.",
        action:
          "Convert the key with PuTTYgen (Conversions → Export OpenSSH key), then `ssh-add` it — OpenSSH cannot read .ppk files.",
      });
    }
    if (probes.windowsAgent === "no-agent") {
      failures.push({
        cause: "The OpenSSH Authentication Agent service is not running.",
        action:
          "Enable the OpenSSH Authentication Agent service: services.msc → OpenSSH Authentication Agent → Startup type: Automatic, then `ssh-add` your key.",
      });
    } else if (probes.windowsAgent === "no-identities") {
      failures.push({
        cause: "No SSH identities are loaded in the agent.",
        action: "Run `ssh-add <path-to-key>` to load your key into the OpenSSH agent.",
      });
    }
  }

  return {
    ok: failures.length === 0,
    ingressMode: decideIngressMode(probes),
    probes,
    failures,
    unknownHost: null,
  };
}

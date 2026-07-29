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

export type OsId = "linux" | "darwin" | "unknown";
export type Arch = "x64" | "arm64" | "unknown";

export type OsInfo = {
  id: OsId;
  arch: Arch;
  /** human-readable kernel release, e.g. "6.5.0-44-generic" — for diagnostics */
  release: string | null;
};

export type Reachability = "ok" | "auth-failed" | "unreachable";

export type TailscaleState = {
  /** `command -v tailscale` succeeded AND `tailscale status --json` had BackendState=Running. */
  running: boolean;
  /** First IPv4 from `tailscale status --json` Self.TailscaleIPs, or null. */
  ipv4: string | null;
};

export type PreflightProbes = {
  reachability: Reachability;
  os: OsInfo;
  /** `sudo -n true` exited 0 over the SSH connection. */
  passwordlessSudo: boolean;
  /** `tailscale status --json` parsed cleanly with BackendState=Running. */
  tailscale: TailscaleState;
  /** Local clock − remote clock, in seconds (rounded). Negative = remote ahead. */
  clockSkewSeconds: number;
  /** `~/.manta/auth.json` already exists on the box. */
  alreadyInstalled: boolean;
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

export type PreflightWarning = {
  /** Plain-language warning text (no action required — proceed anyway). */
  message: string;
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
  /** Soft warnings — install proceeds, but the UI shows them prominently. */
  warnings: PreflightWarning[];
};

// Clock skew: a wrong box clock silently breaks Let's Encrypt issuance and
// OAuth flows. Warn past a 60s threshold (NTP typically keeps things inside
// a few seconds — 60s is a "definitely broken" cutoff).
const CLOCK_SKEW_WARN_SECONDS = 60;

/**
 * Classify a set of probe results into the preflight verdict the UI renders
 * and the installer branches on. Pure — no I/O. Tests pass fabricated probe
 * objects (see preflight.test.ts) to assert on every branch.
 *
 * Rules:
 *   - unreachable / auth-failed → fail (one structured failure)
 *   - unsupported OS/arch       → fail (one structured failure)
 *   - clock skew > 60s           → warn, proceed
 *   - already installed         → warn (not a failure — installer is
 *                                  idempotent and re-runnable; the UI shows a
 *                                  "this looks like a re-install" hint)
 *   - everything else            → ok
 */
export function classifyPreflight(probes: PreflightProbes): PreflightResult {
  const failures: PreflightFailure[] = [];
  const warnings: PreflightWarning[] = [];

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
  if (skew > CLOCK_SKEW_WARN_SECONDS) {
    warnings.push({
      message: `Box clock is off by ${skew}s — this can break certificate issuance and OAuth. Sync the box's time before continuing.`,
    });
  }

  if (probes.alreadyInstalled) {
    warnings.push({
      message:
        "An existing install was detected — the installer will re-run idempotently and preserve the box identity.",
    });
  }

  return {
    ok: failures.length === 0,
    ingressMode: decideIngressMode(probes),
    probes,
    failures,
    warnings,
  };
}

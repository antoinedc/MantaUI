// preflight.test.ts — classifyPreflight / decideIngressMode / isSupportedTarget
// unit tests. Pure: tests pass fabricated probe objects and assert on the
// verdict + ingress-mode + failures[].

import { describe, it, expect } from "vitest";
import {
  classifyPreflight,
  decideIngressMode,
  isSupportedTarget,
  targetLabel,
  type PreflightProbes,
} from "./preflight.js";
import type { HostFingerprint } from "./fingerprint.js";

const SAMPLE_FP: HostFingerprint = {
  algo: "ED25519",
  sha256: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
};

const OK_OS_LINUX_X64 = {
  id: "linux" as const,
  arch: "x64" as const,
  release: "6.5.0",
};
const OK_OS_LINUX_ARM64 = {
  id: "linux" as const,
  arch: "arm64" as const,
  release: "6.5.0",
};
const OK_OS_DARWIN_ARM64 = {
  id: "darwin" as const,
  arch: "arm64" as const,
  release: "23.0.0",
};

function makeProbes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    reachability: "ok",
    hostFingerprint: null,
    os: OK_OS_LINUX_X64,
    sudoAccess: "nopasswd",
    tailscale: { running: false, ipv4: null },
    clockSkewSeconds: 0,
    alreadyInstalled: false,
    windowsAgent: "not-windows",
    keyFormat: "not-windows",
    ...overrides,
  };
}

describe("isSupportedTarget / targetLabel", () => {
  it("accepts Linux x64 / arm64 + macOS arm64", () => {
    expect(isSupportedTarget(OK_OS_LINUX_X64)).toBe(true);
    expect(isSupportedTarget(OK_OS_LINUX_ARM64)).toBe(true);
    expect(isSupportedTarget(OK_OS_DARWIN_ARM64)).toBe(true);
  });

  it("rejects Linux x86 (32-bit) / armv7 / unknown arch", () => {
    expect(isSupportedTarget({ id: "linux", arch: "unknown", release: null })).toBe(false);
    expect(isSupportedTarget({ id: "linux", arch: "x64", release: null })).toBe(true);
  });

  it("rejects macOS x86_64 (Intel Mac — install.sh:117 explicit refusal)", () => {
    expect(
      isSupportedTarget({ id: "darwin", arch: "x64", release: "23.0.0" }),
    ).toBe(false);
  });

  it("rejects unknown OS (FreeBSD, etc.)", () => {
    expect(isSupportedTarget({ id: "unknown", arch: "x64", release: null })).toBe(false);
  });

  it("targetLabel matches the supported (OS, arch) pairs", () => {
    expect(targetLabel(OK_OS_LINUX_X64)).toBe("Linux x86_64");
    expect(targetLabel(OK_OS_LINUX_ARM64)).toBe("Linux aarch64");
    expect(targetLabel(OK_OS_DARWIN_ARM64)).toBe("macOS Apple Silicon");
  });

  it("targetLabel returns null for unsupported pairs", () => {
    expect(targetLabel({ id: "darwin", arch: "x64", release: null })).toBeNull();
    expect(targetLabel({ id: "unknown", arch: "x64", release: null })).toBeNull();
  });
});

describe("decideIngressMode — mirrors install.sh:1160 predicate", () => {
  it("tailscale running → 'tailscale'", () => {
    expect(
      decideIngressMode(
        makeProbes({ tailscale: { running: true, ipv4: "100.64.1.2" } }),
      ),
    ).toBe("tailscale");
  });

  it("macOS without tailscale → 'macos-loopback' (install.sh:1160 second clause)", () => {
    expect(decideIngressMode(makeProbes({ os: OK_OS_DARWIN_ARM64 }))).toBe(
      "macos-loopback",
    );
  });

  it("Linux + passwordless sudo + no tailscale → 'public-tls' (Caddy + Let's Encrypt)", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_LINUX_X64,
          sudoAccess: "nopasswd",
          tailscale: { running: false, ipv4: null },
        }),
      ),
    ).toBe("public-tls");
  });

  it("Linux + password-sudo + no tailscale → 'public-tls' (the desktop asks for the password — BET-979)", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_LINUX_X64,
          sudoAccess: "password",
          tailscale: { running: false, ipv4: null },
        }),
      ),
    ).toBe("public-tls");
  });

  it("Linux + real root (uid 0) + no tailscale → 'public-tls'", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_LINUX_X64,
          sudoAccess: "root",
          tailscale: { running: false, ipv4: null },
        }),
      ),
    ).toBe("public-tls");
  });

  it("Linux + NO usable root (sudoAccess none) + no tailscale → 'no-root'", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_LINUX_X64,
          sudoAccess: "none",
        }),
      ),
    ).toBe("no-root");
  });

  it("tailscale on macOS still resolves to 'tailscale' (tailscale wins over macOS)", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_DARWIN_ARM64,
          tailscale: { running: true, ipv4: "100.64.1.2" },
        }),
      ),
    ).toBe("tailscale");
  });

  it("sudo on macOS is irrelevant — macos-loopback wins (install.sh gates on IS_MACOS, not sudo)", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_DARWIN_ARM64,
          sudoAccess: "nopasswd",
        }),
      ),
    ).toBe("macos-loopback");
  });
});

describe("classifyPreflight", () => {
  it("happy-path Linux box with sudo → ok + public-tls", () => {
    const r = classifyPreflight(makeProbes());
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("public-tls");
    expect(r.failures).toEqual([]);
  });

  it("happy-path macOS arm64 → ok + macos-loopback", () => {
    const r = classifyPreflight(
      makeProbes({ os: OK_OS_DARWIN_ARM64, sudoAccess: "none" }),
    );
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("macos-loopback");
  });

  it("happy-path tailscale → ok + tailscale", () => {
    const r = classifyPreflight(
      makeProbes({
        tailscale: { running: true, ipv4: "100.64.1.2" },
        sudoAccess: "none",
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("tailscale");
  });

  it("unreachable → fail with a single structured failure + action", () => {
    const r = classifyPreflight(
      makeProbes({ reachability: "unreachable" }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].cause).toMatch(/Could not connect/);
    expect(r.failures[0].action).toMatch(/Check the alias/);
  });

  it("auth-failed → fail with a key/auth-specific action", () => {
    const r = classifyPreflight(
      makeProbes({ reachability: "auth-failed" }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0].action).toMatch(/ssh-add|authorized_keys/);
  });

  it("unsupported OS/arch (Intel Mac) → fail with the install.sh-style refusal text", () => {
    const r = classifyPreflight(
      makeProbes({
        os: { id: "darwin", arch: "x64", release: "23.0.0" },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0].cause).toMatch(/darwin\/x64/);
    expect(r.failures[0].action).toMatch(/Intel Macs are not supported/);
  });

  it("unsupported Linux arch → fail with the install.sh-style refusal text", () => {
    const r = classifyPreflight(
      makeProbes({
        os: { id: "linux", arch: "unknown", release: null },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0].action).toMatch(/x86_64 and aarch64/);
  });

  it("clock skew > 60s → hard failure, not a warning (BET-383: breaks cert issuance outright)", () => {
    const r = classifyPreflight(
      makeProbes({ clockSkewSeconds: 90 }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].cause).toMatch(/clock is off by 90s/);
    expect(r.failures[0].action).toMatch(/Certificate issuance and OAuth will fail/);
  });

  it("clock skew exactly at the threshold (60s) → ok, no failure", () => {
    const r = classifyPreflight(makeProbes({ clockSkewSeconds: -60 }));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("clock skew negative (remote ahead of local) also fails at the same threshold", () => {
    const r = classifyPreflight(makeProbes({ clockSkewSeconds: -200 }));
    expect(r.ok).toBe(false);
    expect(r.failures[0].cause).toMatch(/off by 200s/);
  });

  it("alreadyInstalled is not a failure — installer is idempotent, install.sh already says so", () => {
    const r = classifyPreflight(makeProbes({ alreadyInstalled: true }));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    // Still echoed in probes for diagnostics.
    expect(r.probes.alreadyInstalled).toBe(true);
  });

  it("unreachable + clock skew → both surface as failures", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "unreachable",
        clockSkewSeconds: 120,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(2);
  });

  it("echoes the probes back so the UI can render the disclosure panel", () => {
    const probes = makeProbes({ alreadyInstalled: true });
    const r = classifyPreflight(probes);
    expect(r.probes).toEqual(probes);
  });
});

// BET-361: unknown-host reachability short-circuits into a trust-pause
// signal, not a hard failure list. The OS/clock checks are meaningless
// until the host can be reached and would otherwise pile on "unsupported
// unknown/unknown" noise the user cannot act on before trusting.
describe("classifyPreflight — unknown host (BET-361)", () => {
  it("surfaces the fingerprint and a single guidance failure, no OS noise", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "unknown-host",
        hostFingerprint: SAMPLE_FP,
        os: { id: "unknown", arch: "unknown", release: null },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.unknownHost).toEqual(SAMPLE_FP);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].cause).toMatch(/not yet trusted/);
    // The unknown/unknown OS must NOT add a second failure here.
    expect(r.failures.some((f) => /Unsupported target/.test(f.cause))).toBe(false);
  });

  it("still short-circuits when no fingerprint was parsed (degraded)", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "unknown-host",
        hostFingerprint: null,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.unknownHost).toBeNull();
    expect(r.failures).toHaveLength(1);
  });

  it("a normal (reachable) verdict leaves unknownHost null", () => {
    const r = classifyPreflight(makeProbes());
    expect(r.unknownHost).toBeNull();
  });
});

// ===========================================================================
// Windows client-side checks (BET-362)
// ===========================================================================

describe("classifyPreflight — Windows client probes (BET-362)", () => {
  it("non-Windows probes never produce a failure, even on auth-failed", () => {
    const r = classifyPreflight(
      makeProbes({ reachability: "auth-failed" }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].cause).toMatch(/SSH key authentication was rejected/);
    expect(r.failures[0].action).toMatch(/ssh-add|authorized_keys/);
  });

  it("PuTTY-format key + auth-failed → 'PuTTY-format key detected' failure", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "auth-failed",
        keyFormat: "putty",
        windowsAgent: "ok",
      }),
    );
    expect(r.ok).toBe(false);
    const causes = r.failures.map((f) => f.cause);
    expect(causes).toContain("PuTTY-format key detected.");
    const putty = r.failures.find((f) => f.cause.includes("PuTTY"));
    expect(putty?.action).toMatch(/PuTTYgen.*Export OpenSSH/i);
    expect(putty?.action).toMatch(/ssh-add/);
  });

  it("disabled SSH Agent (no-agent) + auth-failed → services.msc hint", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "auth-failed",
        windowsAgent: "no-agent",
        keyFormat: "ok",
      }),
    );
    expect(r.ok).toBe(false);
    const agent = r.failures.find((f) =>
      f.cause.includes("Authentication Agent service is not running"),
    );
    expect(agent).toBeDefined();
    expect(agent?.action).toMatch(/services\.msc.*OpenSSH Authentication Agent.*Automatic/s);
  });

  it("agent running but empty (no-identities) + auth-failed → ssh-add hint", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "auth-failed",
        windowsAgent: "no-identities",
        keyFormat: "ok",
      }),
    );
    expect(r.ok).toBe(false);
    const idents = r.failures.find((f) =>
      f.cause.includes("No SSH identities are loaded"),
    );
    expect(idents).toBeDefined();
    expect(idents?.action).toMatch(/ssh-add/);
  });

  it("does NOT fire Windows failures when auth succeeded (working setup)", () => {
    // A .ppk file sitting unused in ~/.ssh must not block an install that
    // authenticates fine via another key — gating on auth-failed is the
    // load-bearing rule.
    const r = classifyPreflight(
      makeProbes({
        reachability: "ok",
        keyFormat: "putty",
        windowsAgent: "no-agent",
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("surfaces all applicable Windows failures at once (putty + no-agent)", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "auth-failed",
        keyFormat: "putty",
        windowsAgent: "no-agent",
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(3); // generic auth + putty + no-agent
    const causes = r.failures.map((f) => f.cause);
    expect(causes.some((c) => /SSH key authentication was rejected/.test(c))).toBe(true);
    expect(causes.some((c) => c.includes("PuTTY-format key detected"))).toBe(true);
    expect(
      causes.some((c) => c.includes("Authentication Agent service is not running")),
    ).toBe(true);
  });

  it("Windows probes are echoed in diagnostics even when auth succeeds", () => {
    const probes = makeProbes({
      reachability: "ok",
      windowsAgent: "no-agent",
      keyFormat: "putty",
    });
    const r = classifyPreflight(probes);
    expect(r.ok).toBe(true);
    expect(r.probes.windowsAgent).toBe("no-agent");
    expect(r.probes.keyFormat).toBe("putty");
  });
});

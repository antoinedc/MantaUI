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
    os: OK_OS_LINUX_X64,
    passwordlessSudo: true,
    tailscale: { running: false, ipv4: null },
    clockSkewSeconds: 0,
    alreadyInstalled: false,
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
          passwordlessSudo: true,
          tailscale: { running: false, ipv4: null },
        }),
      ),
    ).toBe("public-tls");
  });

  it("Linux + NO passwordless sudo + no tailscale → 'no-root'", () => {
    expect(
      decideIngressMode(
        makeProbes({
          os: OK_OS_LINUX_X64,
          passwordlessSudo: false,
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
          passwordlessSudo: true,
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
    expect(r.warnings).toEqual([]);
  });

  it("happy-path macOS arm64 → ok + macos-loopback", () => {
    const r = classifyPreflight(
      makeProbes({ os: OK_OS_DARWIN_ARM64, passwordlessSudo: false }),
    );
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("macos-loopback");
  });

  it("happy-path tailscale → ok + tailscale", () => {
    const r = classifyPreflight(
      makeProbes({
        tailscale: { running: true, ipv4: "100.64.1.2" },
        passwordlessSudo: false,
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

  it("clock skew > 60s → warning + still ok", () => {
    const r = classifyPreflight(
      makeProbes({ clockSkewSeconds: 90 }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toMatch(/clock is off by 90s/);
  });

  it("clock skew exactly at the threshold (60s) → ok with no warning", () => {
    const r = classifyPreflight(makeProbes({ clockSkewSeconds: -60 }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("clock skew negative (remote ahead of local) also warns at the same threshold", () => {
    const r = classifyPreflight(makeProbes({ clockSkewSeconds: -200 }));
    expect(r.ok).toBe(true);
    expect(r.warnings[0].message).toMatch(/off by 200s/);
  });

  it("alreadyInstalled → warning + still ok", () => {
    const r = classifyPreflight(makeProbes({ alreadyInstalled: true }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toMatch(/existing install/i);
  });

  it("failures and warnings can coexist (unreachable + clock skew)", () => {
    const r = classifyPreflight(
      makeProbes({
        reachability: "unreachable",
        clockSkewSeconds: 120,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });

  it("echoes the probes back so the UI can render the disclosure panel", () => {
    const probes = makeProbes({ alreadyInstalled: true });
    const r = classifyPreflight(probes);
    expect(r.probes).toEqual(probes);
  });
});

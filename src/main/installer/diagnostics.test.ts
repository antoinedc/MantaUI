// diagnostics.test.ts — redactLine / buildDiagnostics unit tests.
// Pure: takes strings, returns strings. No I/O.

import { describe, it, expect } from "vitest";
import { redactLine, buildDiagnostics } from "./diagnostics.js";
import {
  classifyPreflight,
  type PreflightProbes,
} from "./preflight.js";

function makeProbes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    reachability: "ok",
    os: { id: "linux", arch: "x64", release: "6.5.0" },
    passwordlessSudo: true,
    tailscale: { running: false, ipv4: null },
    clockSkewSeconds: 0,
    alreadyInstalled: false,
    ...overrides,
  };
}

describe("redactLine", () => {
  it("returns empty string on empty / non-string input", () => {
    expect(redactLine("")).toBe("");
    // @ts-expect-error – deliberate: defensive runtime check
    expect(redactLine(null)).toBe("");
    // @ts-expect-error – deliberate: defensive runtime check
    expect(redactLine(undefined)).toBe("");
  });

  it("redacts 32-hex box_id / box_token tokens", () => {
    expect(redactLine("box_id=0123456789abcdef0123456789abcdef")).toBe(
      "box_id=[REDACTED:32hex]",
    );
    expect(
      redactLine("box_token FEDCBA9876543210FEDCBA9876543210 leaked"),
    ).toBe("box_token [REDACTED:32hex] leaked");
  });

  it("redacts uppercase 32-hex (case-insensitive)", () => {
    expect(redactLine("token ABCDEF0123456789ABCDEF0123456789 here")).toBe(
      "token [REDACTED:32hex] here",
    );
  });

  it("redacts 6-digit pairing codes", () => {
    expect(redactLine("Pairing code: 847291")).toBe(
      "Pairing code: [REDACTED:pairing-code]",
    );
  });

  it("does NOT redact 7-digit numbers (only matches 6-digit standalone tokens)", () => {
    expect(redactLine("8472910")).toBe("8472910");
  });

  it("redacts SSH identity file paths", () => {
    expect(redactLine("IdentityFile /Users/dev/.ssh/id_ed25519")).toBe(
      "IdentityFile [REDACTED:ssh-key-path]",
    );
    expect(redactLine("identityfile /home/dev/.ssh/id_rsa")).toBe(
      "identityfile [REDACTED:ssh-key-path]",
    );
  });

  it("redacts host fingerprints (SHA256:base64…)", () => {
    expect(
      redactLine(
        "known_hosts: SHA256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      ),
    ).toBe("known_hosts: [REDACTED:host-fingerprint]");
  });

  it("redacts Authorization: Bearer tokens", () => {
    expect(
      redactLine("Authorization: Bearer 0123456789abcdef0123456789abcdef"),
    ).toBe("Authorization: Bearer [REDACTED:bearer-token]");
  });

  it("leaves benign diagnostic lines alone", () => {
    expect(redactLine("opencode-serve is healthy.")).toBe(
      "opencode-serve is healthy.",
    );
    expect(redactLine("Installing Caddy (official apt repo)…")).toBe(
      "Installing Caddy (official apt repo)…",
    );
  });
});

describe("buildDiagnostics", () => {
  it("emits a stable, paste-friendly shape", () => {
    const pf = classifyPreflight(
      makeProbes({
        alreadyInstalled: true,
        clockSkewSeconds: 90,
      }),
    );
    const blob = buildDiagnostics({
      preflight: pf,
      stage: "service",
      logTail: [
        "▸ Installing systemd --user unit…",
        "✓ opencode-serve is healthy.",
        "Pairing code: 847291",
      ],
      alias: "dev",
    });
    expect(blob).toContain("## MantaUI installer diagnostics");
    expect(blob).toContain("alias: dev");
    expect(blob).toContain("stage: service");
    expect(blob).toContain("ok: true");
    expect(blob).toContain("ingressMode: public-tls");
    expect(blob).toContain("alreadyInstalled=true");
    expect(blob).toContain("[REDACTED:pairing-code]");
    expect(blob).toContain("## Install log (tail)");
  });

  it("renders the empty-log branch without 'undefined'", () => {
    const pf = classifyPreflight(makeProbes());
    const blob = buildDiagnostics({
      preflight: pf,
      stage: "preflight",
      logTail: [],
      alias: undefined,
    });
    expect(blob).toContain("alias: n/a");
    expect(blob).toContain("(empty)");
  });

  it("preserves a failed preflight with structured failures", () => {
    const pf = classifyPreflight(
      makeProbes({ reachability: "auth-failed" }),
    );
    const blob = buildDiagnostics({
      preflight: pf,
      stage: "preflight",
      logTail: ["failed at the gate"],
    });
    expect(blob).toContain("ok: false");
    expect(blob).toContain("failures:");
    expect(blob).toContain("cause:");
    expect(blob).toContain("action:");
  });
});

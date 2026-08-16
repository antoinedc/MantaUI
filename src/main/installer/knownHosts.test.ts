// knownHosts.test.ts — parseKeyScanOutput / computeFingerprint /
// fingerprintsMatch / formatKnownHostsLine / appendKnownHostsLine /
// scanHostKeys / resolveKnownHostsKey / hostKeyAlgoLabel /
// probeOfferedFingerprint / trustHost.
//
// No real ssh-keyscan, no real network: spawn is stubbed with the shared
// makeFakeChild helper, and appendKnownHostsLine writes to a tmp path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseKeyScanOutput,
  computeFingerprint,
  fingerprintsMatch,
  formatKnownHostsLine,
  appendKnownHostsLine,
  scanHostKeys,
  resolveKnownHostsKey,
  hostKeyAlgoLabel,
  probeOfferedFingerprint,
  trustHost,
} from "./knownHosts.js";
import { makeFakeChild } from "./_testFixtures.js";
import type { SpawnFn } from "./runner.js";
import type { HostFingerprint } from "./fingerprint.js";

// A throwaway "host key" — any base64 blob works because computeFingerprint
// just hashes the decoded bytes; the match logic is what's under test.
const KEY_ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIEhbgP+4g5Fw2vQj9aQk7mZp";
const KEY_RSA = "AAAAB3NzaC1yc2EAAAADAQABAAABAQCx1234fakeRsaKey==";

let tmpDir: string;
let knownHostsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "manta-knownhosts-"));
  knownHostsPath = join(tmpDir, "known_hosts");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseKeyScanOutput", () => {
  it("parses ed25519 + rsa lines, dropping comments and the host field", () => {
    const stdout = [
      "# 203.0.113.5:22 SSH-2.0-OpenSSH_9.0",
      "203.0.113.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhbgP+4g5Fw2vQj9aQk7mZp",
      "203.0.113.5 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCx1234fakeRsaKey==",
      "# comment line",
      "",
    ].join("\n");
    const keys = parseKeyScanOutput(stdout);
    expect(keys).toEqual([
      { algo: "ssh-ed25519", keyBase64: "AAAAC3NzaC1lZDI1NTE5AAAAIEhbgP+4g5Fw2vQj9aQk7mZp" },
      { algo: "ssh-rsa", keyBase64: "AAAAB3NzaC1yc2EAAAADAQABAAABAQCx1234fakeRsaKey==" },
    ]);
  });

  it("drops lines whose algo token is not a key type", () => {
    const stdout = "host some-junk AAAA==\nhost ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhbgP+4g5Fw2vQj9aQk7mZp";
    expect(parseKeyScanOutput(stdout)).toEqual([
      { algo: "ssh-ed25519", keyBase64: "AAAAC3NzaC1lZDI1NTE5AAAAIEhbgP+4g5Fw2vQj9aQk7mZp" },
    ]);
  });

  it("returns [] for empty / non-string input", () => {
    expect(parseKeyScanOutput("")).toEqual([]);
  });
});

describe("computeFingerprint / fingerprintsMatch", () => {
  it("produces a SHA256: token", () => {
    expect(computeFingerprint(KEY_ED25519)).toMatch(/^SHA256:[A-Za-z0-9+/=]+$/);
  });

  it("matches regardless of trailing base64 padding", () => {
    const fp = computeFingerprint(KEY_ED25519);
    // Same fingerprint with padding stripped should still match.
    const stripped = fp.replace(/=+$/g, "");
    expect(fingerprintsMatch(fp, stripped)).toBe(true);
    expect(fingerprintsMatch(stripped, fp)).toBe(true);
  });

  it("does not match a different key's fingerprint", () => {
    expect(
      fingerprintsMatch(computeFingerprint(KEY_ED25519), computeFingerprint(KEY_RSA)),
    ).toBe(false);
  });
});

describe("formatKnownHostsLine", () => {
  it("uses the bare hostname for port 22", () => {
    expect(formatKnownHostsLine("box.example.com", 22, "ssh-ed25519", KEY_ED25519))
      .toBe(`box.example.com ssh-ed25519 ${KEY_ED25519}`);
  });

  it("uses the [host]:port form for non-default ports", () => {
    expect(formatKnownHostsLine("box.example.com", 2222, "ssh-ed25519", KEY_ED25519))
      .toBe(`[box.example.com]:2222 ssh-ed25519 ${KEY_ED25519}`);
  });
});

describe("appendKnownHostsLine", () => {
  it("creates the file (and ~/.ssh dir) when missing, mode 0600", () => {
    const nested = join(tmpDir, "sub", "known_hosts");
    appendKnownHostsLine(nested, `box ssh-ed25519 ${KEY_ED25519}`);
    expect(existsSync(nested)).toBe(true);
    expect((statSync(nested).mode & 0o777)).toBe(0o600);
    expect(readFileSync(nested, "utf8")).toBe(`box ssh-ed25519 ${KEY_ED25519}\n`);
  });

  it("preserves existing entries on a second append", () => {
    appendKnownHostsLine(knownHostsPath, `boxA ssh-ed25519 ${KEY_ED25519}`);
    appendKnownHostsLine(knownHostsPath, `boxB ssh-rsa ${KEY_RSA}`);
    const content = readFileSync(knownHostsPath, "utf8");
    expect(content).toContain(`boxA ssh-ed25519 ${KEY_ED25519}`);
    expect(content).toContain(`boxB ssh-rsa ${KEY_RSA}`);
  });

  it("is idempotent — an identical line is not duplicated", () => {
    const line = `box ssh-ed25519 ${KEY_ED25519}`;
    appendKnownHostsLine(knownHostsPath, line);
    appendKnownHostsLine(knownHostsPath, line);
    const content = readFileSync(knownHostsPath, "utf8");
    expect(content.split("\n").filter((l) => l === line)).toHaveLength(1);
  });
});

describe("scanHostKeys", () => {
  it("spawns ssh-keyscan with -t and -p for a non-default port, parses the keys", async () => {
    const captured: { command: string; args: string[] } = { command: "", args: [] };
    const fake = makeFakeChild();
    const spawn: SpawnFn = (command, args) => {
      captured.command = command;
      captured.args = args;
      return fake.child as any;
    };
    setImmediate(() => {
      fake.pushStdout(`box.example.com ssh-ed25519 ${KEY_ED25519}\n`);
      fake.fireExit(0);
    });
    const keys = await scanHostKeys("box.example.com", 2222, { spawn });
    expect(captured.args).toContain("-p");
    expect(captured.args).toContain("2222");
    expect(captured.args).toContain("-t");
    expect(keys).toEqual([{ algo: "ssh-ed25519", keyBase64: KEY_ED25519 }]);
  });

  it("omits -p for the default port", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const spawn: SpawnFn = (_c, args) => {
      captured.args = args;
      return fake.child as any;
    };
    setImmediate(() => {
      fake.pushStdout(`box ssh-ed25519 ${KEY_ED25519}\n`);
      fake.fireExit(0);
    });
    await scanHostKeys("box", 22, { spawn });
    expect(captured.args).not.toContain("-p");
  });

  it("returns [] when ssh-keyscan exits with no output", async () => {
    const fake = makeFakeChild();
    setImmediate(() => fake.fireExit(1));
    const keys = await scanHostKeys("box", 22, { spawn: () => fake.child as any });
    expect(keys).toEqual([]);
  });
});

describe("resolveKnownHostsKey", () => {
  it("reads host + port directly from a custom target", async () => {
    const r = await resolveKnownHostsKey({
      kind: "custom",
      host: "box.example.com",
      port: 2222,
    });
    expect(r).toEqual({ hostname: "box.example.com", port: 2222 });
  });

  it("defaults a custom target's port to 22", async () => {
    const r = await resolveKnownHostsKey({ kind: "custom", host: "box.example.com" });
    expect(r.port).toBe(22);
  });

  it("resolves an alias through `ssh -G`", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => {
      fake.pushStdout("hostname 203.0.113.5\nport 2222\nuser root\n");
      fake.fireExit(0);
    });
    const r = await resolveKnownHostsKey("dev", { spawn });
    expect(r).toEqual({ hostname: "203.0.113.5", port: 2222 });
  });

  it("falls back to the alias string + port 22 when ssh -G yields no hostname", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => fake.fireExit(1));
    const r = await resolveKnownHostsKey("dev", { spawn });
    expect(r).toEqual({ hostname: "dev", port: 22 });
  });
});

describe("hostKeyAlgoLabel", () => {
  it("maps OpenSSH algo tokens to the display names parseFingerprint normalises to", () => {
    expect(hostKeyAlgoLabel("ssh-ed25519")).toBe("ED25519");
    expect(hostKeyAlgoLabel("ecdsa-sha2-nistp256")).toBe("ECDSA");
    expect(hostKeyAlgoLabel("ssh-rsa")).toBe("RSA");
    expect(hostKeyAlgoLabel("ssh-dss")).toBe("DSA");
  });

  it("passes through an algo that matches no known family, upper-cased", () => {
    expect(hostKeyAlgoLabel("ssh-xmss")).toBe("SSH-XMSS");
    expect(hostKeyAlgoLabel("")).toBe("");
  });
});

describe("probeOfferedFingerprint", () => {
  it("returns the SHA256: fingerprint of the ed25519 key when both ed25519 + rsa are offered", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => {
      fake.pushStdout(
        `box.example.com ssh-ed25519 ${KEY_ED25519}\nbox.example.com ssh-rsa ${KEY_RSA}\n`,
      );
      fake.fireExit(0);
    });
    const fp = await probeOfferedFingerprint(
      { kind: "custom", host: "box.example.com" },
      { spawn },
    );
    expect(fp).toEqual({ algo: "ED25519", sha256: computeFingerprint(KEY_ED25519) });
    expect(fp?.sha256).toMatch(/^SHA256:/);
  });

  it("returns null when ssh-keyscan offers no usable key", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => fake.fireExit(1));
    const fp = await probeOfferedFingerprint(
      { kind: "custom", host: "box.example.com" },
      { spawn },
    );
    expect(fp).toBeNull();
  });
});

describe("trustHost", () => {
  const trustedFp: HostFingerprint = {
    algo: "ED25519",
    sha256: computeFingerprint(KEY_ED25519),
  };

  it("writes the matching key's line to known_hosts and returns ok", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => {
      fake.pushStdout(
        `box.example.com ssh-rsa ${KEY_RSA}\nbox.example.com ssh-ed25519 ${KEY_ED25519}\n`,
      );
      fake.fireExit(0);
    });
    const r = await trustHost(
      { target: { kind: "custom", host: "box.example.com" }, fingerprint: trustedFp, knownHostsPath },
      { spawn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line).toBe(`box.example.com ssh-ed25519 ${KEY_ED25519}`);
    expect(readFileSync(knownHostsPath, "utf8")).toContain(r.line);
  });

  it("uses [host]:port for a non-default port", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => {
      fake.pushStdout(`box ssh-ed25519 ${KEY_ED25519}\n`);
      fake.fireExit(0);
    });
    const r = await trustHost(
      {
        target: { kind: "custom", host: "box.example.com", port: 2222 },
        fingerprint: trustedFp,
        knownHostsPath,
      },
      { spawn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line).toBe(`[box.example.com]:2222 ssh-ed25519 ${KEY_ED25519}`);
  });

  it("fails with fingerprint-mismatch when no scanned key matches", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => {
      fake.pushStdout(`box ssh-rsa ${KEY_RSA}\n`);
      fake.fireExit(0);
    });
    const r = await trustHost(
      { target: { kind: "custom", host: "box.example.com" }, fingerprint: trustedFp, knownHostsPath },
      { spawn },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("fingerprint-mismatch");
    expect(existsSync(knownHostsPath)).toBe(false);
  });

  it("fails with keyscan-failed when ssh-keyscan returns no keys", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => fake.child as any;
    setImmediate(() => fake.fireExit(1));
    const r = await trustHost(
      { target: { kind: "custom", host: "box.example.com" }, fingerprint: trustedFp, knownHostsPath },
      { spawn },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("keyscan-failed");
  });
});

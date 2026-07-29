// installer.test.ts — listSshHosts / preflightBox / runInstall / mintAndClaim
// orchestrator tests. All I/O is stubbed (spawn + fetch); no real SSH.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSshHosts,
  preflightBox,
  runInstall,
  mintAndClaim,
  DEFAULT_SSH_CONFIG_PATH,
  type SpawnFn,
} from "./installer.js";
import type { ClaimOutcome } from "../../shared/claim.mjs";
import type { AppConfig } from "../../shared/types.js";
import {
  makeProbeSpawn,
  makeFakeChild,
  happyLinuxProbes,
  capturingSpawn,
  PROBE_KEYS,
} from "./_testFixtures.js";

// ===========================================================================
// listSshHosts
// ===========================================================================

describe("listSshHosts", () => {
  it("returns [] when the path is empty / non-string / missing", () => {
    // @ts-expect-error – deliberate: defensive runtime check
    expect(listSshHosts(null)).toEqual([]);
    expect(listSshHosts("")).toEqual([]);
    expect(listSshHosts("/does/not/exist/.ssh/config")).toEqual([]);
  });

  it("parses a real-shaped config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "manta-ssh-"));
    try {
      const cfgPath = join(dir, "config");
      writeFileSync(
        cfgPath,
        [
          "# personal boxes",
          "Host dev",
          "    HostName 10.0.0.5",
          "    User dev",
          "",
          "Host staging prod",
          "    HostName 10.0.0.6",
        ].join("\n"),
      );
      expect(listSshHosts(cfgPath)).toEqual([
        { alias: "dev", patterns: ["dev"] },
        { alias: "staging", patterns: ["staging", "prod"] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes the default path constant so production wires it consistently", () => {
    expect(typeof DEFAULT_SSH_CONFIG_PATH).toBe("string");
    expect(DEFAULT_SSH_CONFIG_PATH.endsWith(".ssh/config")).toBe(true);
  });
});

// ===========================================================================
// preflightBox
// ===========================================================================

describe("preflightBox", () => {
  it("rejects an empty alias", async () => {
    await expect(preflightBox("", { spawn: makeProbeSpawn({}) })).rejects.toThrow(
      /alias is required/,
    );
  });

  it("classifies a happy-path Linux box with sudo → public-tls", async () => {
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(happyLinuxProbes()) });
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("public-tls");
    expect(r.failures).toEqual([]);
  });

  it("classifies unreachable → fail with a single structured failure", async () => {
    const responses = happyLinuxProbes();
    responses[PROBE_KEYS.REACHABILITY] = {
      code: 255,
      stderr: "ssh: connect to host 10.0.0.5 port 22: No route to host",
    };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ok).toBe(false);
    expect(r.failures[0].cause).toMatch(/Could not connect/);
  });

  it("classifies auth-failed when BatchMode=yes returns Permission denied", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.REACHABILITY]: {
        code: 255,
        stderr: "Permission denied (publickey).",
      },
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.failures[0].action).toMatch(/ssh-add|authorized_keys/);
  });

  it("classifies a never-seen host as unknown-host and surfaces the fingerprint (BET-361)", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.REACHABILITY]: {
        code: 255,
        stderr: [
          "The authenticity of host 'box (203.0.113.5)' can't be established.",
          "ED25519 key fingerprint is SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=.",
          "Host key verification failed.",
        ].join("\n"),
      },
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ok).toBe(false);
    expect(r.probes.reachability).toBe("unknown-host");
    expect(r.probes.hostFingerprint).toEqual({
      algo: "ED25519",
      sha256: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
    });
    expect(r.unknownHost).toEqual({
      algo: "ED25519",
      sha256: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
    });
    // Short-circuited — no OS/unsupported noise on top of the trust prompt.
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].cause).toMatch(/not yet trusted/);
  });

  it("classifies tailscale-running → ingressMode=tailscale (wins over macOS)", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.OS]: { code: 0, stdout: "Darwin\narm64\n23.0.0\n" },
      [PROBE_KEYS.SUDO]: { code: 1, stdout: "" },
      [PROBE_KEYS.TAILSCALE]: {
        code: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"] },
        }),
      },
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("tailscale");
    expect(r.probes.tailscale.ipv4).toBe("100.64.1.2");
  });

  it("classifies macOS arm64 + no tailscale + no sudo → macos-loopback", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.OS]: { code: 0, stdout: "Darwin\narm64\n23.0.0\n" },
      [PROBE_KEYS.SUDO]: { code: 1, stdout: "" },
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ingressMode).toBe("macos-loopback");
  });

  it("captures clock skew from the diff between local + remote", async () => {
    // remote time is 120s behind local
    const responses = happyLinuxProbes({
      [PROBE_KEYS.CLOCK]: {
        code: 0,
        stdout: `${Math.floor(Date.now() / 1000) - 120}\n`,
      },
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.probes.clockSkewSeconds).toBeGreaterThanOrEqual(119);
    expect(r.probes.clockSkewSeconds).toBeLessThanOrEqual(121);
    // BET-383: clock skew past the threshold is a hard failure, not a
    // warning — it breaks certificate issuance and OAuth outright.
    expect(r.ok).toBe(false);
    expect(r.failures[0].cause).toMatch(/clock is off by/);
  });

  it("captures alreadyInstalled when ~/.manta/auth.json is present (not a failure)", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.AUTH_FILE]: { code: 0, stdout: "INSTALLED\n" },
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.probes.alreadyInstalled).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

// ===========================================================================
// runInstall
// ===========================================================================

describe("runInstall", () => {
  it("rejects an empty alias", () => {
    expect(() =>
      runInstall("", {}, { spawn: makeProbeSpawn({}) }),
    ).toThrow(/alias is required/);
  });

  it("runs `bash -lc 'curl -fsSL <url> | MANTA_RELEASE_HOST=<host> bash'` over SSH with -tt", async () => {
    const fake = makeFakeChild();
    const { spawn, captured } = capturingSpawn(fake);
    const handle = runInstall("dev", {}, { spawn });
    setImmediate(() => fake.fireExit(0));
    await handle.done;
    expect(captured.args).toContain("-tt");
    expect(captured.args).toContain("dev");
    // Channel-aware install command (BET-370): the install.sh URL + release
    // host flow from the channel config (test env falls through to dev,
    // whose installShUrl + releaseHost match the prod defaults per the
    // BET-370 spec table — staging-specific values are pinned in
    // src/shared/channel.test.ts and don't need to be re-asserted here).
    expect(captured.args[captured.args.length - 1]).toMatch(
      /curl -fsSL https:\/\/mantaui\.com\/install\.sh/,
    );
    expect(captured.args[captured.args.length - 1]).toMatch(
      /MANTA_RELEASE_HOST=https:\/\/mantaui\.com/,
    );
    expect(captured.args[captured.args.length - 1]).toMatch(/\sbash'$/);
  });

  // BET-370 channel assertions: the installShUrl test seam overrides the
  // URL only — releaseHost stays channel-derived. The two come from the
  // same channel record in production; here we just verify that the
  // orchestrator threads installShUrl verbatim into the curl invocation.
  it("honours deps.installShUrl while still passing the channel's release host", async () => {
    const fake = makeFakeChild();
    const { spawn, captured } = capturingSpawn(fake);
    const handle = runInstall(
      "dev",
      {},
      {
        spawn,
        installShUrl: "https://mantaui.com/staging/install.sh",
      },
    );
    setImmediate(() => fake.fireExit(0));
    await handle.done;
    const cmd = captured.args[captured.args.length - 1];
    expect(cmd).toContain("curl -fsSL https://mantaui.com/staging/install.sh");
    // releaseHost still flows from the channel (test env = dev = prod
    // default), not from the installShUrl override — the channel is the
    // single source of truth per the spec.
    expect(cmd).toContain("MANTA_RELEASE_HOST=https://mantaui.com");
  });

  it("invokes onLine + onStage as the log advances through milestones", async () => {
    const fake = makeFakeChild();
    const lines: string[] = [];
    const stages: string[] = [];
    const handle = runInstall(
      "dev",
      {
        onLine: (l) => lines.push(l),
        onStage: (s) => stages.push(s),
      },
      { spawn: () => fake.child as any },
    );
    setImmediate(() => {
      fake.pushStdout(
        [
          "\x1b[36m▸\x1b[0m Checking prerequisites (curl, tar, …)\n",
          "\x1b[36m▸\x1b[0m Fetching manifest from https://mantaui.com/…\n",
          "\x1b[36m▸\x1b[0m Downloading release…\n",
          "\x1b[36m▸\x1b[0m Extracting to /tmp/…/pkg…\n",
          "\x1b[36m▸\x1b[0m Installing systemd --user unit…\n",
          "\x1b[32m✓\x1b[0m opencode-serve is healthy.\n",
          "\x1b[36m▸\x1b[0m Pairing code: 847291\n",
          "Your box serves its own public hostname — https://…\n",
        ].join(""),
      );
      fake.fireExit(0);
    });
    await handle.done;
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(stages[stages.length - 1]).toBe("done");
  });

  it("carries a partial line across chunks (no line-split on a small buffer)", async () => {
    const fake = makeFakeChild();
    const lines: string[] = [];
    const handle = runInstall(
      "dev",
      { onLine: (l) => lines.push(l) },
      { spawn: () => fake.child as any },
    );
    setImmediate(() => {
      // Split a single landmark line across two chunks.
      fake.pushStdout("\x1b[36m▸\x1b[0m Chec");
      fake.pushStdout("king prerequisites (curl, tar, …)\n");
      fake.fireExit(0);
    });
    await handle.done;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Checking prerequisites/);
  });

  it("cancel() is idempotent and safe to call before / after the process exits", async () => {
    const fake = makeFakeChild();
    const handle = runInstall("dev", {}, { spawn: () => fake.child as any });
    handle.cancel();
    handle.cancel();
    handle.cancel();
    expect(fake.killCount()).toBe(1);
    setImmediate(() => fake.fireExit(null, "SIGTERM"));
    const r = await handle.done;
    expect(r.signal).toBe("SIGTERM");
  });
});

// ===========================================================================
// mintAndClaim
// ===========================================================================

describe("mintAndClaim", () => {
  it("rejects an empty alias", async () => {
    await expect(mintAndClaim("", { persist: () => {} })).rejects.toThrow(
      /alias is required/,
    );
  });

  it("rejects a missing persist callback (constraint #4: one config writer)", async () => {
    await expect(
      mintAndClaim("dev", {
        persist: undefined as unknown as (p: Partial<AppConfig>) => void,
      }),
    ).rejects.toThrow(/persist callback is required/);
  });

  it("mints a code over SSH + claims it via the existing claim path", async () => {
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const HEX32b = "fedcba9876543210fedcba9876543210";
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout(
          [
            "  ✓ Manta server is running — connect your devices:",
            "",
            "  Pairing code:  847291",
            `  Box ID:        ${HEX32}`,
            "  Server URL:    https://box.example",
            "  Expires:       5 minutes",
          ].join("\n"),
        );
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      // Verify the claim URL was the one parsed from the pair block.
      expect(url).toBe("https://box.example/auth/claim");
      return {
        status: 200,
        json: async () => ({ ok: true, box_token: HEX32b, box_id: HEX32 }),
      };
    }) as unknown as typeof fetch;
    const persisted: Array<Partial<AppConfig>> = [];
    const out = await mintAndClaim("dev", {
      spawn,
      fetchImpl,
      persist: (patch) => persisted.push(patch),
    });
    expect(out).toEqual({ ok: true, boxToken: HEX32b, boxId: HEX32 });
    expect(persisted).toEqual([
      {
        serverUrl: "https://box.example",
        boxId: HEX32,
        boxToken: HEX32b,
      },
    ]);
  });

  it("falls back to boxDirectUrl(boxId) when no Server URL line is printed (public path)", async () => {
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const HEX32b = "fedcba9876543210fedcba9876543210";
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout(
          [
            "  Pairing code:  847291",
            `  Box ID:        ${HEX32}`,
            // no Server URL → public path → claim at <boxId>.boxes.mantaui.com
          ].join("\n"),
        );
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      // boxDirectUrl returns https://<boxId>.boxes.mantaui.com — the
      // canonical URL the desktop persists for direct mode.
      expect(url).toMatch(
        new RegExp(`^https://${HEX32}\\.boxes\\.mantaui\\.com/auth/claim$`),
      );
      return {
        status: 200,
        json: async () => ({ ok: true, box_token: HEX32b, box_id: HEX32 }),
      };
    }) as unknown as typeof fetch;
    const persisted: Array<Partial<AppConfig>> = [];
    await mintAndClaim("dev", {
      spawn,
      fetchImpl,
      persist: (patch) => persisted.push(patch),
    });
    expect(persisted[0].serverUrl).toBe(`https://${HEX32}.boxes.mantaui.com`);
  });

  it("honours claimUrlOverride when supplied (e.g. Tailscale listener)", async () => {
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout(
          ["  Pairing code:  847291", `  Box ID:        ${HEX32}`].join("\n"),
        );
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://100.64.1.2:8787/auth/claim");
      return {
        status: 200,
        json: async () => ({ ok: true, box_token: HEX32, box_id: HEX32 }),
      };
    }) as unknown as typeof fetch;
    await mintAndClaim("dev", {
      spawn,
      fetchImpl,
      claimUrlOverride: "http://100.64.1.2:8787",
      persist: () => {},
    });
  });

  it("returns a failure outcome when `manta pair` exits non-zero on the box", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => fake.fireExit(1));
      return fake.child as any;
    };
    const out = (await mintAndClaim("dev", {
      spawn,
      persist: () => {},
    })) as Extract<ClaimOutcome, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("network");
  });

  it("returns an invalid_response when the box's pair output is unparseable", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout("not a pairing block at all\n");
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const out = (await mintAndClaim("dev", {
      spawn,
      persist: () => {},
    })) as Extract<ClaimOutcome, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("invalid_response");
  });
});

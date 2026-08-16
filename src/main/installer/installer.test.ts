// installer.test.ts — listSshHosts / preflightBox / runInstall / mintAndClaim
// orchestrator tests. All I/O is stubbed (spawn + fetch); no real SSH.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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
import type { PreflightResult } from "./preflight.js";
import type { ClaimOutcome } from "../../shared/claim.mjs";
import type { AppConfig } from "../../shared/types.js";
import {
  makeProbeSpawn,
  makeFakeChild,
  happyLinuxProbes,
  capturingSpawn,
  PROBE_KEYS,
  type ProbeResponse,
} from "./_testFixtures.js";
import { computeFingerprint } from "./knownHosts.js";

// The key ssh-keyscan "offers" for the host in the BET-1008 keyscan tests.
const SCAN_KEY = "AAAB3NzaC1lZDI1NTE5AAAAIBET1008ScanKey==";

// Build the preflight response set where the reachability probe refuses on a
// host key with the ONE-LINE non-interactive ssh output, and ssh-keyscan (for
// the resolved destination "dev") answers with `keyscanResponse`. Routes the
// spawn stub to the refusal and to the keyscan in one place so the two
// BET-1008 verdict tests share no duplicated setup. Respons is keyed on the
// destination ("dev") — both `ssh -G dev` and `ssh-keyscan … -- dev` match it
// (makeProbeSpawn matches the last arg); ssh -G just ignores the keyscan output.
async function preflightKeyscanVerdict(
  keyscanResponse: ProbeResponse,
): Promise<PreflightResult> {
  const responses = happyLinuxProbes();
  responses[PROBE_KEYS.REACHABILITY] = {
    code: 255,
    stderr: "Host key verification failed.\n",
  };
  responses["dev"] = keyscanResponse;
  return preflightBox("dev", { spawn: makeProbeSpawn(responses) });
}

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

  it("classifies a never-seen host as unknown-host via ssh-keyscan when ssh prints only the one-line refusal (BET-1008)", async () => {
    // A non-interactive ssh prints ONLY "Host key verification failed." on an
    // unknown host (no fingerprint block — that only ever appears on a TTY).
    // The fingerprint must come from ssh-keyscan, so the spawn stub routes
    // the reachability probe to the refusal and the keyscan to a known key.
    const r = await preflightKeyscanVerdict({
      code: 0,
      stdout: `dev ssh-ed25519 ${SCAN_KEY}\n`,
    });
    expect(r.ok).toBe(false);
    expect(r.probes.reachability).toBe("unknown-host");
    expect(r.probes.hostFingerprint).toEqual({
      algo: "ED25519",
      sha256: computeFingerprint(SCAN_KEY),
    });
    expect(r.unknownHost).toEqual(r.probes.hostFingerprint);
  });

  it("falls back to unreachable when ssh refuses on the host key but ssh-keyscan offers nothing (BET-1008)", async () => {
    const r = await preflightKeyscanVerdict({ code: 1, stdout: "", stderr: "" });
    expect(r.ok).toBe(false);
    expect(r.probes.reachability).toBe("unreachable");
    expect(r.probes.hostFingerprint).toBeNull();
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
// preflightBox — sudo probe parsing (BET-979 D3)
// ==========================================================================
// The sudo probe returns ONE word (root | nopasswd | password | none) and is
// mapped onto PreflightProbes.sudoAccess. Any unparseable output → "none"
// (fail closed).

describe("preflightBox — sudo probe parses all four states (BET-979)", () => {
  it("maps 'root' → sudoAccess root (public-tls)", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(
        happyLinuxProbes({ [PROBE_KEYS.SUDO]: { code: 0, stdout: "root\n" } }),
      ),
    });
    expect(r.probes.sudoAccess).toBe("root");
    expect(r.ingressMode).toBe("public-tls");
  });

  it("maps 'nopasswd' → sudoAccess nopasswd (public-tls)", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(
        happyLinuxProbes({ [PROBE_KEYS.SUDO]: { code: 0, stdout: "nopasswd\n" } }),
      ),
    });
    expect(r.probes.sudoAccess).toBe("nopasswd");
    expect(r.ingressMode).toBe("public-tls");
  });

  it("maps 'password' → sudoAccess password (public-tls — desktop will ask)", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(
        happyLinuxProbes({ [PROBE_KEYS.SUDO]: { code: 0, stdout: "password\n" } }),
      ),
    });
    expect(r.probes.sudoAccess).toBe("password");
    expect(r.ingressMode).toBe("public-tls");
  });

  it("maps 'none' → sudoAccess none (no-root)", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(
        happyLinuxProbes({ [PROBE_KEYS.SUDO]: { code: 0, stdout: "none\n" } }),
      ),
    });
    expect(r.probes.sudoAccess).toBe("none");
    expect(r.ingressMode).toBe("no-root");
  });

  it("maps unknown/unparseable output → none (fail closed)", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(
        happyLinuxProbes({ [PROBE_KEYS.SUDO]: { code: 0, stdout: "??\n" } }),
      ),
    });
    expect(r.probes.sudoAccess).toBe("none");
    expect(r.ingressMode).toBe("no-root");
  });

  it("maps a non-zero sudo exit (empty stdout) → none (fail closed)", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(
        happyLinuxProbes({ [PROBE_KEYS.SUDO]: { code: 1, stdout: "" } }),
      ),
    });
    expect(r.probes.sudoAccess).toBe("none");
    expect(r.ingressMode).toBe("no-root");
  });
});

// ===========================================================================
// preflightBox — Windows client-side probes (BET-362)
// ===========================================================================

// A SpawnFn that handles the LOCAL `ssh-add -l` call (command === "ssh-add")
// with a fixed response and delegates every other (ssh) call to the remote
// probe stub. The agent response is keyed by exit code: 0 = identities
// listed, 1 = no identities, 2 = agent not running.
function windowsSpawn(
  agentResponse: { code: number; stdout?: string; stderr?: string },
  remoteResponses: Record<string, ProbeResponse>,
): SpawnFn {
  const remoteSpawn = makeProbeSpawn(remoteResponses);
  return (command, args, options) => {
    if (command === "ssh-add") {
      const fake = makeFakeChild();
      setImmediate(() => {
        if (agentResponse.stdout) fake.pushStdout(agentResponse.stdout);
        if (agentResponse.stderr) fake.pushStderr(agentResponse.stderr);
        fake.fireExit(agentResponse.code);
      });
      return fake.child as any;
    }
    return remoteSpawn(command, args, options);
  };
}

describe("preflightBox — Windows probes", () => {
  it("skips the Windows probes on a non-Windows platform", async () => {
    const r = await preflightBox("dev", {
      spawn: makeProbeSpawn(happyLinuxProbes()),
      platform: "linux",
    });
    expect(r.probes.windowsAgent).toBe("not-windows");
    expect(r.probes.keyFormat).toBe("not-windows");
    expect(r.ok).toBe(true);
  });

  it("detects a PuTTY-format default key and fails when auth failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manta-ssh-"));
    try {
      mkdirSync(join(dir, ".ssh"), { recursive: true });
      writeFileSync(join(dir, ".ssh", "id_rsa"), "PuTTY-User-Key-File-2: ssh-rsa\n...");
      const responses = happyLinuxProbes({
        [PROBE_KEYS.REACHABILITY]: {
          code: 255,
          stderr: "Permission denied (publickey).",
        },
      });
      const r = await preflightBox("dev", {
        spawn: windowsSpawn({ code: 0, stdout: "ssh-rsa ... agent\n" }, responses),
        platform: "win32",
        homeDir: dir,
      });
      expect(r.probes.keyFormat).toBe("putty");
      expect(r.ok).toBe(false);
      expect(
        r.failures.some((f) => f.cause.includes("PuTTY-format key detected")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a disabled SSH Agent (exit 2) and surfaces the services.msc hint", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.REACHABILITY]: {
        code: 255,
        stderr: "Permission denied (publickey).",
      },
    });
    const r = await preflightBox("dev", {
      spawn: windowsSpawn(
        { code: 2, stderr: "Could not open a connection to your authentication agent" },
        responses,
      ),
      platform: "win32",
    });
    expect(r.probes.windowsAgent).toBe("no-agent");
    expect(r.ok).toBe(false);
    expect(
      r.failures.some((f) => f.action.includes("services.msc")),
    ).toBe(true);
  });

  it("detects an empty agent (exit 1) and surfaces the ssh-add hint", async () => {
    const responses = happyLinuxProbes({
      [PROBE_KEYS.REACHABILITY]: {
        code: 255,
        stderr: "Permission denied (publickey).",
      },
    });
    const r = await preflightBox("dev", {
      spawn: windowsSpawn({ code: 1, stderr: "The agent has no identities." }, responses),
      platform: "win32",
    });
    expect(r.probes.windowsAgent).toBe("no-identities");
    expect(r.ok).toBe(false);
    expect(
      r.failures.some((f) => f.cause.includes("No SSH identities are loaded")),
    ).toBe(true);
  });

  it("does NOT fail when auth succeeded, even with a stray .ppk key present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manta-ssh-"));
    try {
      // A .ppk file AND a working OpenSSH key — auth succeeds, so the
      // PuTTY file must not block the install.
      mkdirSync(join(dir, ".ssh"), { recursive: true });
      writeFileSync(join(dir, ".ssh", "id_rsa"), "PuTTY-User-Key-File-2: ssh-rsa\n...");
      writeFileSync(join(dir, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n...");
      const r = await preflightBox("dev", {
        spawn: windowsSpawn({ code: 0, stdout: "256 SHA256:... (ED25519)\n" }, happyLinuxProbes()),
        platform: "win32",
        homeDir: dir,
      });
      expect(r.probes.keyFormat).toBe("putty");
      expect(r.probes.windowsAgent).toBe("ok");
      expect(r.ok).toBe(true);
      expect(r.failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing ~/.ssh dir as key-format ok (no default key to misread)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manta-ssh-empty-"));
    try {
      const r = await preflightBox("dev", {
        spawn: windowsSpawn({ code: 2, stderr: "no agent" }, happyLinuxProbes()),
        platform: "win32",
        homeDir: dir,
      });
      expect(r.probes.keyFormat).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies an OpenSSH-format default key as ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manta-ssh-openssh-"));
    try {
      mkdirSync(join(dir, ".ssh"), { recursive: true });
      writeFileSync(
        join(dir, ".ssh", "id_ed25519"),
        "-----BEGIN OPENSSH PRIVATE KEY-----\nblah\n-----END OPENSSH PRIVATE KEY-----\n",
      );
      const r = await preflightBox("dev", {
        spawn: windowsSpawn({ code: 0, stdout: "256 SHA256:... (ED25519)\n" }, happyLinuxProbes()),
        platform: "win32",
        homeDir: dir,
      });
      expect(r.probes.keyFormat).toBe("ok");
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    // BET-386: MANTA_CHANNEL rides the same curl-pipe invocation as
    // MANTA_RELEASE_HOST so install.sh's pairing block emits the right
    // pair-link scheme. Test env falls through to dev (see the BET-370
    // comment above) — channelConfig("dev").id is "dev".
    expect(captured.args[captured.args.length - 1]).toMatch(/MANTA_CHANNEL=dev/);
    // BET-979 D4: the desktop sets MANTA_NONINTERACTIVE=1 so install.sh
    // never falls into the interactive-tty sudo strategy.
    expect(captured.args[captured.args.length - 1]).toMatch(/MANTA_NONINTERACTIVE=1/);
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
    // BET-386: same story for MANTA_CHANNEL — it's the channel id, not
    // derived from the installShUrl override.
    expect(cmd).toContain("MANTA_CHANNEL=dev");
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

  it("reads the pairing sidecar + claims it via the existing claim path", async () => {
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const HEX32b = "fedcba9876543210fedcba9876543210";
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout(
          JSON.stringify({
            pairing_code: "847291",
            box_id: HEX32,
            expiresAt: 1750000000000,
            serverUrl: "https://box.example",
          }),
        );
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      // The claim URL must be the serverUrl read from the sidecar.
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

  it("falls back to boxDirectUrl(boxId) when the sidecar has no serverUrl (public path)", async () => {
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const HEX32b = "fedcba9876543210fedcba9876543210";
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        // no serverUrl → public path → claim at <boxId>.boxes.mantaui.com
        fake.pushStdout(
          JSON.stringify({ pairing_code: "847291", box_id: HEX32 }),
        );
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const fetchImpl = vi.fn(async (url: string) => {
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
          JSON.stringify({ pairing_code: "847291", box_id: HEX32 }),
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

  it("returns a network failure when reading the sidecar exits non-zero on the box", async () => {
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

  it("returns a network failure when the sidecar is unparseable JSON", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout("not json at all\n");
        fake.fireExit(0);
      });
      return fake.child as any;
    };
    const out = (await mintAndClaim("dev", {
      spawn,
      persist: () => {},
    })) as Extract<ClaimOutcome, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("network");
  });

  it("returns an invalid_response when the sidecar has no valid code / box_id", async () => {
    const fake = makeFakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        fake.pushStdout(
          JSON.stringify({ pairing_code: "12", box_id: "short" }),
        );
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

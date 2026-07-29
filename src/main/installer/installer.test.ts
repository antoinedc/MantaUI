// installer.test.ts — listSshHosts / preflightBox / runInstall / mintAndClaim
// orchestrator tests. All I/O is stubbed (spawn + fetch); no real SSH.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
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

// ---------------------------------------------------------------------------
// spawn stub — inspects args to figure out which probe is being run, returns
// the matching fake response. Tests configure the response map per scenario.
// ---------------------------------------------------------------------------

type ProbeResponse = { code: number | null; stdout?: string; stderr?: string };

function makeProbeSpawn(responses: Record<string, ProbeResponse>): SpawnFn {
  return (_command, args) => {
    // args layout: ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", alias, command]
    const cmd = args[args.length - 1];
    const found = Object.keys(responses).find((k) => cmd.includes(k));
    const r =
      found !== undefined
        ? responses[found]
        : { code: 1, stdout: "", stderr: "unknown probe" };
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    setImmediate(() => {
      if (r.stdout) stdout.push(Buffer.from(r.stdout));
      if (r.stderr) stderr.push(Buffer.from(r.stderr));
      emitter.emit("exit", r.code, null);
    });
    return fake as any;
  };
}

// Identify probes by a substring unique to each command. The lookup key is
// the substring the spawn stub pattern-matches against the command line.
const PROBE_KEYS = {
  REACHABILITY: "command -v true",
  OS: "uname -s;",
  SUDO: "sudo -n true",
  TAILSCALE: "tailscale status --json",
  CLOCK: "date -u +%s",
  AUTH_FILE: "~/.manta/auth.json",
} as const;

function emptyProbes(): Record<string, ProbeResponse> {
  return Object.fromEntries(
    Object.values(PROBE_KEYS).map((k) => [k, { code: 1, stdout: "", stderr: "" }]),
  );
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
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = { code: 0, stdout: "ok" };
    responses[PROBE_KEYS.OS] = { code: 0, stdout: "Linux\nx86_64\n6.5.0\n" };
    responses[PROBE_KEYS.SUDO] = { code: 0, stdout: "0\n" };
    responses[PROBE_KEYS.TAILSCALE] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.CLOCK] = { code: 0, stdout: `${Math.floor(Date.now() / 1000)}\n` };
    responses[PROBE_KEYS.AUTH_FILE] = { code: 0, stdout: "FRESH\n" };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("public-tls");
    expect(r.failures).toEqual([]);
  });

  it("classifies unreachable → fail with a single structured failure", async () => {
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = {
      code: 255,
      stderr: "ssh: connect to host 10.0.0.5 port 22: No route to host",
    };
    responses[PROBE_KEYS.OS] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.SUDO] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.TAILSCALE] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.CLOCK] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.AUTH_FILE] = { code: 1, stdout: "" };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ok).toBe(false);
    expect(r.failures[0].cause).toMatch(/Could not connect/);
  });

  it("classifies auth-failed when BatchMode=yes returns Permission denied", async () => {
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = {
      code: 255,
      stderr: "Permission denied (publickey).",
    };
    Object.keys(responses).forEach((k) => {
      if (k === PROBE_KEYS.REACHABILITY) return;
      responses[k] = { code: 1, stdout: "" };
    });
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.failures[0].action).toMatch(/ssh-add|authorized_keys/);
  });

  it("classifies tailscale-running → ingressMode=tailscale (wins over macOS)", async () => {
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = { code: 0, stdout: "ok" };
    responses[PROBE_KEYS.OS] = { code: 0, stdout: "Darwin\narm64\n23.0.0\n" };
    responses[PROBE_KEYS.SUDO] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.TAILSCALE] = {
      code: 0,
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: { TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"] },
      }),
    };
    responses[PROBE_KEYS.CLOCK] = { code: 0, stdout: `${Math.floor(Date.now() / 1000)}\n` };
    responses[PROBE_KEYS.AUTH_FILE] = { code: 0, stdout: "FRESH\n" };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ok).toBe(true);
    expect(r.ingressMode).toBe("tailscale");
    expect(r.probes.tailscale.ipv4).toBe("100.64.1.2");
  });

  it("classifies macOS arm64 + no tailscale + no sudo → macos-loopback", async () => {
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = { code: 0, stdout: "ok" };
    responses[PROBE_KEYS.OS] = { code: 0, stdout: "Darwin\narm64\n23.0.0\n" };
    responses[PROBE_KEYS.SUDO] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.TAILSCALE] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.CLOCK] = { code: 0, stdout: `${Math.floor(Date.now() / 1000)}\n` };
    responses[PROBE_KEYS.AUTH_FILE] = { code: 0, stdout: "FRESH\n" };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.ingressMode).toBe("macos-loopback");
  });

  it("captures clock skew from the diff between local + remote", async () => {
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = { code: 0, stdout: "ok" };
    responses[PROBE_KEYS.OS] = { code: 0, stdout: "Linux\nx86_64\n6.5.0\n" };
    responses[PROBE_KEYS.SUDO] = { code: 0, stdout: "0\n" };
    responses[PROBE_KEYS.TAILSCALE] = { code: 1, stdout: "" };
    // remote time is 120s behind local
    responses[PROBE_KEYS.CLOCK] = {
      code: 0,
      stdout: `${Math.floor(Date.now() / 1000) - 120}\n`,
    };
    responses[PROBE_KEYS.AUTH_FILE] = { code: 0, stdout: "FRESH\n" };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.probes.clockSkewSeconds).toBeGreaterThanOrEqual(119);
    expect(r.probes.clockSkewSeconds).toBeLessThanOrEqual(121);
    expect(r.warnings[0].message).toMatch(/clock is off by/);
  });

  it("captures alreadyInstalled when ~/.manta/auth.json is present", async () => {
    const responses = emptyProbes();
    responses[PROBE_KEYS.REACHABILITY] = { code: 0, stdout: "ok" };
    responses[PROBE_KEYS.OS] = { code: 0, stdout: "Linux\nx86_64\n6.5.0\n" };
    responses[PROBE_KEYS.SUDO] = { code: 0, stdout: "0\n" };
    responses[PROBE_KEYS.TAILSCALE] = { code: 1, stdout: "" };
    responses[PROBE_KEYS.CLOCK] = { code: 0, stdout: `${Math.floor(Date.now() / 1000)}\n` };
    responses[PROBE_KEYS.AUTH_FILE] = { code: 0, stdout: "INSTALLED\n" };
    const r = await preflightBox("dev", { spawn: makeProbeSpawn(responses) });
    expect(r.probes.alreadyInstalled).toBe(true);
    expect(r.warnings[0].message).toMatch(/existing install/i);
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

  it("runs `bash -lc 'curl -fsSL <url> | bash'` over SSH with -tt", async () => {
    const captured: { command: string; args: string[] } = { command: "", args: [] };
    const fake: any = {
      stdio: ["ignore", new Readable({ read() {} }), new Readable({ read() {} })],
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      on: new EventEmitter().on.bind(new EventEmitter()),
      once: new EventEmitter().once.bind(new EventEmitter()),
      emit: new EventEmitter().emit.bind(new EventEmitter()),
      kill: vi.fn(),
    };
    // Pull stdout/stderr references onto the fake so pushes work.
    fake.stdout = fake.stdio[1];
    fake.stderr = fake.stdio[2];
    const emitter = new EventEmitter();
    fake.on = emitter.on.bind(emitter);
    fake.once = emitter.once.bind(emitter);
    fake.emit = emitter.emit.bind(emitter);
    const spawn: SpawnFn = (command, args) => {
      captured.command = command;
      captured.args = args;
      return fake;
    };
    const handle = runInstall("dev", {}, { spawn });
    setImmediate(() => emitter.emit("exit", 0, null));
    await handle.done;
    expect(captured.args).toContain("-tt");
    expect(captured.args).toContain("dev");
    expect(captured.args[captured.args.length - 1]).toMatch(
      /curl -fsSL .* \| bash/,
    );
  });

  it("invokes onLine + onStage as the log advances through milestones", async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const lines: string[] = [];
    const stages: string[] = [];
    const handle = runInstall(
      "dev",
      {
        onLine: (l) => lines.push(l),
        onStage: (s) => stages.push(s),
      },
      { spawn: () => fake },
    );
    setImmediate(() => {
      stdout.push(
        Buffer.from(
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
        ),
      );
      emitter.emit("exit", 0, null);
    });
    await handle.done;
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(stages[stages.length - 1]).toBe("done");
  });

  it("carries a partial line across chunks (no line-split on a small buffer)", async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const lines: string[] = [];
    const handle = runInstall(
      "dev",
      { onLine: (l) => lines.push(l) },
      { spawn: () => fake },
    );
    setImmediate(() => {
      // Split a single landmark line across two chunks.
      stdout.push(Buffer.from("\x1b[36m▸\x1b[0m Chec"));
      stdout.push(Buffer.from("king prerequisites (curl, tar, …)\n"));
      emitter.emit("exit", 0, null);
    });
    await handle.done;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Checking prerequisites/);
  });

  it("cancel() is idempotent and safe to call before / after the process exits", async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const handle = runInstall("dev", {}, { spawn: () => fake });
    handle.cancel();
    handle.cancel();
    handle.cancel();
    expect((fake.kill as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    setImmediate(() => emitter.emit("exit", null, "SIGTERM"));
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
      mintAndClaim("dev", { persist: undefined as unknown as (p: Partial<AppConfig>) => void }),
    ).rejects.toThrow(/persist callback is required/);
  });

  it("mints a code over SSH + claims it via the existing claim path", async () => {
    // Stub spawn returns the canonical formatPairingOutput block.
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const HEX32b = "fedcba9876543210fedcba9876543210";
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        stdout.push(
          Buffer.from(
            [
              "  ✓ Manta server is running — connect your devices:",
              "",
              "  Pairing code:  847291",
              `  Box ID:        ${HEX32}`,
              "  Server URL:    https://box.example",
              "  Expires:       5 minutes",
            ].join("\n"),
          ),
        );
        emitter.emit("exit", 0, null);
      });
      return fake;
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
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const HEX32b = "fedcba9876543210fedcba9876543210";
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        stdout.push(
          Buffer.from(
            [
              "  Pairing code:  847291",
              `  Box ID:        ${HEX32}`,
              // no Server URL → public path → claim at <boxId>.boxes.mantaui.com
            ].join("\n"),
          ),
        );
        emitter.emit("exit", 0, null);
      });
      return fake;
    };
    const fetchImpl = vi.fn(async (url: string) => {
      // boxDirectUrl returns https://<boxId>.boxes.mantaui.com — the
      // canonical URL the desktop persists for direct mode.
      expect(url).toMatch(new RegExp(`^https://${HEX32}\\.boxes\\.mantaui\\.com/auth/claim$`));
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
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const HEX32 = "0123456789abcdef0123456789abcdef";
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        stdout.push(
          Buffer.from(
            [
              "  Pairing code:  847291",
              `  Box ID:        ${HEX32}`,
            ].join("\n"),
          ),
        );
        emitter.emit("exit", 0, null);
      });
      return fake;
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
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const spawn: SpawnFn = () => {
      setImmediate(() => emitter.emit("exit", 1, null));
      return fake;
    };
    const out = (await mintAndClaim("dev", {
      spawn,
      persist: () => {},
    })) as Extract<ClaimOutcome, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("network");
  });

  it("returns an invalid_response when the box's pair output is unparseable", async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    const spawn: SpawnFn = () => {
      setImmediate(() => {
        stdout.push(Buffer.from("not a pairing block at all\n"));
        emitter.emit("exit", 0, null);
      });
      return fake;
    };
    const out = (await mintAndClaim("dev", {
      spawn,
      persist: () => {},
    })) as Extract<ClaimOutcome, { ok: false }>;
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("invalid_response");
  });
});

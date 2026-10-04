// resourceSnapshot.test.mjs — pure / injected-I/O tests for the read-only
// resource snapshot (spec: docs/superpowers/specs/2026-10-04-resource-budget-tool.md).
// One test (non-disclosure) deliberately drives the REAL `ps` against a real
// child process; everything else injects its I/O.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  THRESHOLDS,
  SUGGESTED_FRACTION,
  parseMeminfo,
  parsePsOutput,
  parseSize,
  parseDockerStats,
  classifyStatus,
  suggestJobMemoryBytes,
  resolveDirectory,
  withTimeout,
  collectSnapshot,
  resourceSnapshot,
  isSafeCgroupPath,
  parseCgroupBytes,
  computeCgroupMemory,
  OPENCODE_UNIT,
} from "./resourceSnapshot.mjs";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

const PS_OUT = [
  "    1  1000 systemd",
  "  200 50000 node",
  "  300 90000 postgres",
  "  400     0 kthreadd",
  "garbage line",
  "  500 70000 Web Content",
].join("\n");

const DOCKER_OUT = [
  "abc123def4567890\tweb\t12.50%\t300MiB / 1.9GiB",
  "fff000111222\tdb\t0.10%\t1.5GiB / 4GiB",
  "eee\tbroken\tN/A\t--",
].join("\n");

const UNIT_CG = "/user.slice/app.slice/opencode-serve.service";
const CG_BASE = `/sys/fs/cgroup${UNIT_CG}`;
const SERVER_CG = "/user.slice/app.slice/manta-server.service";
const SERVER_CG_BASE = `/sys/fs/cgroup${SERVER_CG}`;

function serverCgroupFiles() {
  return {
    [`${SERVER_CG_BASE}/memory.current`]: `${777 * MIB}\n`,
    [`${SERVER_CG_BASE}/memory.max`]: `${3 * GIB}\n`,
    [`${SERVER_CG_BASE}/memory.high`]: "max\n",
  };
}

// Fake cgroup v2 files for the opencode-serve unit. Default: 2 GiB in use,
// no limits (the common unlimited case).
function cgroupFiles({ current = 2 * GIB, max = "max", high = "max" } = {}) {
  return {
    [`${CG_BASE}/memory.current`]: `${current}\n`,
    [`${CG_BASE}/memory.max`]: `${max}\n`,
    [`${CG_BASE}/memory.high`]: `${high}\n`,
  };
}

// Fake os/fs deps describing a healthy 16 GiB / 100 GiB box. `files` lets a
// test swap any readFile target; unknown paths reject like a missing file.
function healthyDeps({ files = {}, ...over } = {}) {
  const fileMap = {
    "/proc/meminfo": `MemTotal:       ${(16 * GIB) / KIB} kB\nMemFree: 1 kB\nMemAvailable:   ${(8 * GIB) / KIB} kB\n`,
    // TRAP: manta-server's OWN cgroup (not opencode's). Present and readable so a
    // regression that falls back to it would show up as non-null numbers.
    "/proc/self/cgroup": `0::${SERVER_CG}\n`,
    ...serverCgroupFiles(),
    ...cgroupFiles(),
    ...files,
  };
  return {
    platform: "linux",
    readFile: async (p) => {
      if (p in fileMap) return fileMap[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    statfs: async () => ({ bsize: 4096, blocks: (100 * GIB) / 4096, bavail: (60 * GIB) / 4096 }),
    stat: async () => ({ isDirectory: () => true }),
    os: {
      totalmem: () => 16 * GIB,
      freemem: () => 8 * GIB,
      loadavg: () => [0.5, 0.75, 1.25],
      cpuCount: () => 8,
    },
    exec: async (file) => {
      if (file === "ps") return PS_OUT;
      if (file === "docker") return DOCKER_OUT;
      if (file === "systemctl") return `${UNIT_CG}\n`;
      throw new Error(`unexpected exec ${file}`);
    },
    now: () => new Date("2026-10-04T12:00:00.000Z"),
    ...over,
  };
}

const NO_CG = { currentBytes: null, limitBytes: null, availableBytes: null };
const CG_WARNING = "memory: opencode unit cgroup could not be identified or read";

describe("parsers", () => {
  test("parseMeminfo reads MemTotal/MemAvailable (kB → bytes)", () => {
    const r = parseMeminfo("MemTotal: 1000 kB\nMemFree: 5 kB\nMemAvailable: 400 kB\n");
    assert.deepEqual(r, { totalBytes: 1000 * KIB, availableBytes: 400 * KIB });
  });

  test("parseMeminfo leaves MemAvailable null on old kernels", () => {
    assert.deepEqual(parseMeminfo("MemTotal: 1000 kB\n"), { totalBytes: 1000 * KIB, availableBytes: null });
  });

  test("parsePsOutput sorts by RSS desc, drops zero-RSS and junk, limits", () => {
    const r = parsePsOutput(PS_OUT, 3);
    assert.deepEqual(
      r.map((p) => [p.pid, p.name, p.rssBytes]),
      [
        [300, "postgres", 90000 * KIB],
        [500, "Web Content", 70000 * KIB],
        [200, "node", 50000 * KIB],
      ],
    );
  });

  test("parsePsOutput reduces a macOS-style path to its executable basename and strips control chars", () => {
    const r = parsePsOutput("  7  2048 /Applications/Foo Bar.app/Contents/MacOS/Foo Bar\n  8  1024 ev\u001b[31mil\n");
    assert.equal(r[0].name, "Foo Bar");
    assert.equal(r[1].name, "ev[31mil");
  });

  test("parseSize handles docker binary + decimal units and rejects junk", () => {
    assert.equal(parseSize("300MiB"), 300 * MIB);
    assert.equal(parseSize("1.5GiB"), 1.5 * GIB);
    assert.equal(parseSize("0B"), 0);
    assert.equal(parseSize("2kB"), 2000);
    assert.equal(parseSize("N/A"), null);
    assert.equal(parseSize("--"), null);
    assert.equal(parseSize(undefined), null);
  });

  test("parseDockerStats sorts by memory desc and nulls unparseable metrics", () => {
    const items = parseDockerStats(DOCKER_OUT);
    assert.deepEqual(
      items.map((c) => c.name),
      ["db", "web", "broken"],
    );
    assert.equal(items[0].memoryUsageBytes, 1.5 * GIB);
    assert.equal(items[0].memoryLimitBytes, 4 * GIB);
    assert.equal(items[1].id, "abc123def456"); // short id
    assert.equal(items[1].cpuPercent, 12.5);
    assert.deepEqual(
      [items[2].cpuPercent, items[2].memoryUsageBytes, items[2].memoryLimitBytes],
      [null, null, null],
    );
  });
});

describe("status + suggested allowance boundaries", () => {
  const T = THRESHOLDS;
  // Plenty of disk so only memory is under test, and vice versa.
  const bigDisk = { totalBytes: 1000 * GIB, availableBytes: 900 * GIB };
  const mem = (avail, total = 100 * GIB) => ({ totalBytes: total, availableBytes: avail });

  test("memory: critical/constrained boundaries are strict '<' on the absolute floor", () => {
    const total = 4 * GIB; // fractions (0.2/0.6 GiB) sit below the floors, so the floors decide
    assert.equal(classifyStatus({ memory: mem(T.memory.critical.bytes - 1, total), disk: bigDisk }), "critical");
    assert.equal(classifyStatus({ memory: mem(T.memory.critical.bytes, total), disk: bigDisk }), "constrained");
    assert.equal(classifyStatus({ memory: mem(T.memory.constrained.bytes - 1, total), disk: bigDisk }), "constrained");
    assert.equal(classifyStatus({ memory: mem(T.memory.constrained.bytes, total), disk: bigDisk }), "ok");
  });

  test("memory: the fraction of total also trips a level on a small box", () => {
    const f = T.memory;
    // A huge total keeps the absolute floors out of play, isolating the fraction rule.
    const big = 10000 * GIB;
    assert.equal(classifyStatus({ memory: mem(Math.floor(big * f.critical.fraction) - 1, big), disk: bigDisk }), "critical");
    assert.equal(classifyStatus({ memory: mem(Math.ceil(big * f.constrained.fraction) - 1, big), disk: bigDisk }), "constrained");
    assert.equal(classifyStatus({ memory: mem(Math.ceil(big * f.constrained.fraction), big), disk: bigDisk }), "ok");
  });

  test("disk: critical/constrained boundaries", () => {
    const okMem = mem(50 * GIB);
    const total = 20 * GIB; // fractions (0.6/2 GiB) sit below the floors, so the floors decide
    const d = (avail) => ({ totalBytes: total, availableBytes: avail });
    assert.equal(classifyStatus({ memory: okMem, disk: d(T.disk.critical.bytes - 1) }), "critical");
    assert.equal(classifyStatus({ memory: okMem, disk: d(T.disk.critical.bytes) }), "constrained");
    assert.equal(classifyStatus({ memory: okMem, disk: d(T.disk.constrained.bytes - 1) }), "constrained");
    assert.equal(classifyStatus({ memory: okMem, disk: d(T.disk.constrained.bytes) }), "ok");
  });

  test("overall status is the worse of memory and disk", () => {
    const low = { totalBytes: 10000 * GIB, availableBytes: 100 * MIB };
    assert.equal(classifyStatus({ memory: mem(50 * GIB), disk: low }), "critical");
    assert.equal(classifyStatus({ memory: low, disk: bigDisk }), "critical");
    assert.equal(
      classifyStatus({ memory: mem(1 * GIB, 4 * GIB), disk: { totalBytes: 20 * GIB, availableBytes: 3 * GIB } }),
      "constrained",
    );
  });

  test("an unmeasured resource does not contribute; none measured → constrained (conservative)", () => {
    const unknown = { totalBytes: null, availableBytes: null };
    assert.equal(classifyStatus({ memory: mem(50 * GIB), disk: unknown }), "ok");
    assert.equal(classifyStatus({ memory: unknown, disk: bigDisk }), "ok");
    assert.equal(classifyStatus({ memory: unknown, disk: unknown }), "constrained");
  });

  test("suggested allowance: 20% / 10% / 0 by status, floored, never above 20% of available", () => {
    assert.equal(suggestJobMemoryBytes(10 * GIB, "ok"), 2 * GIB);
    assert.equal(suggestJobMemoryBytes(10 * GIB, "constrained"), 1 * GIB);
    assert.equal(suggestJobMemoryBytes(10 * GIB, "critical"), 0);
    assert.equal(suggestJobMemoryBytes(7, "ok"), 1); // floor(1.4)
    assert.equal(suggestJobMemoryBytes(null, "ok"), null);
    for (const s of Object.keys(SUGGESTED_FRACTION)) {
      assert.ok(suggestJobMemoryBytes(12345678, s) <= 0.2 * 12345678);
    }
  });
});

describe("resolveDirectory", () => {
  test("absent input uses the server cwd", async () => {
    assert.deepEqual(await resolveDirectory(undefined, { cwd: () => "/srv/x" }), { ok: true, dir: "/srv/x" });
    assert.deepEqual(await resolveDirectory("", { cwd: () => "/srv/x" }), { ok: true, dir: "/srv/x" });
  });

  test("rejects relative, NUL-containing, missing and non-directory paths", async () => {
    const dirStat = async () => ({ isDirectory: () => true });
    assert.equal((await resolveDirectory("rel/path", { stat: dirStat })).ok, false);
    assert.equal((await resolveDirectory("/tmp/a\0b", { stat: dirStat })).ok, false);
    assert.equal((await resolveDirectory("/nope", { stat: async () => { throw new Error("ENOENT"); } })).ok, false);
    assert.equal((await resolveDirectory("/etc/passwd", { stat: async () => ({ isDirectory: () => false }) })).ok, false);
  });

  test("accepts an existing absolute directory (normalized)", async () => {
    const r = await resolveDirectory("/home/dev/../dev/work", { stat: async () => ({ isDirectory: () => true }) });
    assert.deepEqual(r, { ok: true, dir: "/home/dev/work" });
  });
});

describe("collectSnapshot", () => {
  test("healthy box: full pinned response shape", async () => {
    const s = await collectSnapshot("/work", healthyDeps());
    assert.equal(s.ok, true);
    assert.equal(s.capturedAt, "2026-10-04T12:00:00.000Z");
    assert.deepEqual(s.memory, {
      totalBytes: 16 * GIB,
      availableBytes: 8 * GIB,
      opencodeCgroup: { currentBytes: 2 * GIB, limitBytes: null, availableBytes: null },
    });
    assert.deepEqual(s.cpu, { count: 8, load1: 0.5, load5: 0.75, load15: 1.25 });
    assert.deepEqual(s.disk, { path: "/work", totalBytes: 100 * GIB, availableBytes: 60 * GIB });
    assert.equal(s.topProcesses.length, 4);
    assert.deepEqual(Object.keys(s.topProcesses[0]).sort(), ["name", "pid", "rssBytes"]);
    assert.equal(s.containers.available, true);
    assert.equal(s.containers.items.length, 3);
    assert.deepEqual(Object.keys(s.containers.items[0]).sort(), [
      "cpuPercent",
      "id",
      "memoryLimitBytes",
      "memoryUsageBytes",
      "name",
    ]);
    assert.equal(s.status, "ok");
    assert.equal(s.suggestedJobMemoryBytes, Math.floor(8 * GIB * 0.2));
    assert.deepEqual(s.warnings, []);
    assert.deepEqual(Object.keys(s).sort(), [
      "capturedAt",
      "containers",
      "cpu",
      "disk",
      "memory",
      "ok",
      "status",
      "suggestedJobMemoryBytes",
      "topProcesses",
      "warnings",
    ]);
  });

  test("low memory yields constrained status, reduced allowance and a warning", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        files: { "/proc/meminfo": `MemTotal: ${(4 * GIB) / KIB} kB\nMemAvailable: ${(1 * GIB) / KIB} kB\n` },
      }),
    );
    assert.equal(s.status, "constrained");
    assert.equal(s.suggestedJobMemoryBytes, Math.floor(1 * GIB * 0.1));
    assert.ok(s.warnings.includes("memory: headroom is low"));
  });

  test("Docker not installed (ENOENT): containers unavailable, everything else intact", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        exec: async (file) => {
          if (file === "ps") return PS_OUT;
          throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    assert.deepEqual(s.containers, { available: false, items: [] });
    assert.ok(s.warnings.includes("docker: not installed"));
    assert.equal(s.memory.availableBytes, 8 * GIB);
    assert.equal(s.topProcesses.length, 4);
    assert.equal(s.status, "ok");
  });

  test("Docker daemon error: unavailable, with a fixed warning that never echoes stderr", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        exec: async (file) => {
          if (file === "ps") return PS_OUT;
          throw Object.assign(new Error("Cannot connect to the Docker daemon at unix:///secret/path"), {
            code: 1,
            stderr: "token=hunter2",
          });
        },
      }),
    );
    assert.equal(s.containers.available, false);
    assert.ok(s.warnings.includes("docker: unavailable (daemon not reachable)"));
    assert.ok(!JSON.stringify(s).includes("hunter2"));
    assert.ok(!JSON.stringify(s).includes("/secret/path"));
  });

  test("Docker probe that hangs is bounded by the timeout; other readings survive", async () => {
    const started = Date.now();
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        timeouts: { docker: 50 },
        exec: async (file) => {
          if (file === "ps") return PS_OUT;
          if (file === "systemctl") return `${UNIT_CG}\n`;
          return new Promise(() => {}); // docker never resolves
        },
      }),
    );
    assert.ok(Date.now() - started < 2000, "must not hang on a stuck docker");
    assert.deepEqual(s.containers, { available: false, items: [] });
    assert.ok(s.warnings.includes("docker: timed out"));
    assert.equal(s.topProcesses.length, 4);
    assert.equal(s.disk.availableBytes, 60 * GIB);
  });

  test("a killed exec (execFile timeout) is also reported as a timeout", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        exec: async (file) => {
          if (file === "ps") throw Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" });
          return DOCKER_OUT;
        },
      }),
    );
    assert.deepEqual(s.topProcesses, []);
    assert.ok(s.warnings.includes("processes: timed out"));
    assert.equal(s.containers.available, true);
  });

  test("every source failing still resolves: nulls, warnings, conservative status", async () => {
    const boom = async () => {
      throw new Error("boom");
    };
    const s = await collectSnapshot("/work", {
      platform: "linux",
      readFile: boom,
      statfs: boom,
      exec: boom,
      os: {
        totalmem: () => {
          throw new Error("x");
        },
        freemem: () => {
          throw new Error("x");
        },
        loadavg: () => {
          throw new Error("x");
        },
        cpuCount: () => 0,
      },
      now: () => new Date("2026-10-04T12:00:00.000Z"),
    });
    assert.equal(s.ok, true);
    assert.deepEqual(s.memory, { totalBytes: null, availableBytes: null, opencodeCgroup: NO_CG });
    assert.deepEqual(s.disk, { path: "/work", totalBytes: null, availableBytes: null });
    assert.deepEqual(s.topProcesses, []);
    assert.equal(s.containers.available, false);
    assert.equal(s.suggestedJobMemoryBytes, null);
    assert.equal(s.status, "constrained");
    for (const w of [
      "memory: unavailable",
      CG_WARNING,
      "disk: unavailable",
      "processes: unavailable",
      "cpu: unavailable",
    ]) {
      assert.ok(s.warnings.includes(w), `missing warning ${w}`);
    }
  });

  test("unreadable /proc/meminfo falls back to approximate os values with a warning", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    assert.deepEqual(s.memory.availableBytes, 8 * GIB);
    assert.ok(s.warnings.includes("memory: using approximate values (precise source unavailable)"));
  });

  test("probes use fixed argv with no shell and only read-only subcommands", async () => {
    const calls = [];
    await collectSnapshot(
      "/work",
      healthyDeps({
        exec: async (file, args, opts) => {
          calls.push({ file, args, opts });
          return file === "ps" ? PS_OUT : DOCKER_OUT;
        },
      }),
    );
    const ps = calls.find((c) => c.file === "ps");
    const docker = calls.find((c) => c.file === "docker");
    assert.deepEqual(ps.args, ["-axo", "pid=,rss=,comm="]); // no args/env columns
    assert.equal(docker.args[0], "stats");
    assert.ok(docker.args.includes("--no-stream"));
    for (const banned of ["inspect", "logs", "exec", "run", "rm", "kill", "stop"]) {
      assert.ok(!docker.args.includes(banned), `docker argv must not contain ${banned}`);
    }
    const systemctl = calls.find((c) => c.file === "systemctl");
    assert.deepEqual(systemctl.args, ["--user", "show", OPENCODE_UNIT, "-p", "ControlGroup", "--value"]);
    assert.equal(calls.length, 3);
    for (const c of calls) assert.ok(c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 5000);
  });
});

describe("resourceSnapshot (route entry)", () => {
  test("a bad directory returns {ok:false,error} and runs no probes", async () => {
    let probed = false;
    const r = await resourceSnapshot(
      { directory: "relative" },
      healthyDeps({
        exec: async () => {
          probed = true;
          return "";
        },
      }),
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /absolute/);
    assert.equal(probed, false);
  });

  test("directory only selects the filesystem for disk reporting", async () => {
    const seen = [];
    const r = await resourceSnapshot(
      { directory: "/data/proj" },
      healthyDeps({
        statfs: async (p) => {
          seen.push(p);
          return { bsize: 4096, blocks: 1000, bavail: 500 };
        },
      }),
    );
    assert.equal(r.ok, true);
    assert.deepEqual(seen, ["/data/proj"]);
    assert.equal(r.disk.path, "/data/proj");
  });

  test("absent directory reports the server cwd", async () => {
    const r = await resourceSnapshot({}, healthyDeps({ cwd: () => "/srv/manta" }));
    assert.equal(r.disk.path, "/srv/manta");
  });
});

describe("opencode cgroup", () => {
  test("parsers: cgroup path safety, byte values", () => {
    assert.equal(isSafeCgroupPath("/user.slice/user-1000.slice/user@1000.service/app.slice/opencode-serve.service"), true);
    assert.equal(isSafeCgroupPath("/a/b\\x2dc.service"), true); // systemd escapes
    assert.equal(isSafeCgroupPath("/"), true);
    for (const bad of ["", "relative/path", "/a/../etc", "/a/./b", "/a//b", "/a/", "/a b", "/a;rm", "/a\0b", "/a\nb", "x".repeat(600)]) {
      assert.equal(isSafeCgroupPath(bad), false, JSON.stringify(bad));
    }
    assert.equal(isSafeCgroupPath(undefined), false);

    assert.equal(parseCgroupBytes("12345\n"), 12345);
    assert.equal(parseCgroupBytes("max\n"), null);
    assert.equal(parseCgroupBytes(""), null);
    assert.equal(parseCgroupBytes(undefined), null);
    assert.equal(parseCgroupBytes("9223372036854771712"), null); // implausibly huge ⇒ unlimited
  });

  test("computeCgroupMemory: effective limit is the lower finite of max/high; available clamps at 0", () => {
    assert.deepEqual(computeCgroupMemory({ current: "9", limits: ["20", "12"] }), {
      currentBytes: 9, limitBytes: 12, availableBytes: 3,
    });
    assert.deepEqual(computeCgroupMemory({ current: "9", limits: ["max", "12"] }), {
      currentBytes: 9, limitBytes: 12, availableBytes: 3,
    });
    assert.deepEqual(computeCgroupMemory({ current: "15", limits: ["12", "max"] }), {
      currentBytes: 15, limitBytes: 12, availableBytes: 0,
    });
    // unlimited: current known, limit/available null
    assert.deepEqual(computeCgroupMemory({ current: "9", limits: ["max", "max"] }), {
      currentBytes: 9, limitBytes: null, availableBytes: null,
    });
    assert.deepEqual(computeCgroupMemory({ current: null, limits: ["12"] }), {
      currentBytes: null, limitBytes: 12, availableBytes: null,
    });
  });

  test("v2 via the opencode-serve unit: current/limit/available reported and no warning", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({ files: cgroupFiles({ current: 6 * GIB, max: 12 * GIB, high: 10 * GIB }) }),
    );
    assert.deepEqual(s.memory.opencodeCgroup, {
      currentBytes: 6 * GIB, limitBytes: 10 * GIB, availableBytes: 4 * GIB,
    });
    assert.deepEqual(s.warnings, []);
  });

  test("unlimited cgroup: current only; status and allowance follow the host", async () => {
    const s = await collectSnapshot("/work", healthyDeps());
    assert.deepEqual(s.memory.opencodeCgroup, { currentBytes: 2 * GIB, limitBytes: null, availableBytes: null });
    assert.equal(s.status, "ok");
    assert.equal(s.suggestedJobMemoryBytes, Math.floor(8 * GIB * 0.2));
  });

  // A failing/blank unit lookup must NEVER fall back to the server's own cgroup:
  // that is manta-server's budget, and labelling it opencode's would mislead.
  const lookupFailures = {
    "systemctl missing (ENOENT)": async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    "systemctl exits non-zero": async () => {
      throw Object.assign(new Error("Failed to connect to bus"), { code: 1 });
    },
    "unit has no cgroup (inactive → empty output)": async () => "\n",
    "unit lookup returns an unsafe path": async () => "/../../etc\n",
    "unit lookup returns the root path": async () => "/\n",
  };
  for (const [label, systemctl] of Object.entries(lookupFailures)) {
    test(`unit lookup failure — ${label}: opencodeCgroup is all null, server cgroup is never used`, async () => {
      const reads = [];
      const base = healthyDeps();
      const s = await collectSnapshot("/work", {
        ...base,
        readFile: async (p, enc) => {
          reads.push(p);
          return base.readFile(p, enc);
        },
        exec: async (file, ...rest) => (file === "systemctl" ? systemctl() : base.exec(file, ...rest)),
      });
      assert.deepEqual(s.memory.opencodeCgroup, NO_CG);
      assert.ok(s.warnings.includes(CG_WARNING));
      // The trap files exist but must not be read, nor /proc/self/cgroup consulted.
      assert.ok(!reads.includes("/proc/self/cgroup"), JSON.stringify(reads));
      assert.ok(!reads.some((p) => p.startsWith(SERVER_CG_BASE)), JSON.stringify(reads));
      assert.ok(reads.every((p) => p === "/proc/meminfo"), `only host meminfo may be read: ${JSON.stringify(reads)}`);
      // Everything else is unaffected, and a missing cgroup doesn't change host-based results.
      assert.equal(s.status, "ok");
      assert.equal(s.suggestedJobMemoryBytes, Math.floor(8 * GIB * 0.2));
      assert.equal(s.memory.availableBytes, 8 * GIB);
    });
  }

  test("unit resolved but its cgroup files are missing (e.g. cgroup v1 host): null + warning, no fallback", async () => {
    const reads = [];
    const base = healthyDeps();
    const s = await collectSnapshot("/work", {
      ...base,
      readFile: async (p, enc) => {
        reads.push(p);
        if (p.startsWith(CG_BASE)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return base.readFile(p, enc);
      },
    });
    assert.deepEqual(s.memory.opencodeCgroup, NO_CG);
    assert.ok(s.warnings.includes(CG_WARNING));
    assert.ok(!reads.some((p) => p.includes("/memory/") || p === "/proc/self/cgroup"), JSON.stringify(reads));
  });

  test("a malicious cgroup path from the lookup is never read", async () => {
    const reads = [];
    const base = healthyDeps();
    const s = await collectSnapshot("/work", {
      ...base,
      readFile: async (p, enc) => {
        reads.push(p);
        return base.readFile(p, enc);
      },
      exec: async (file, ...rest) =>
        file === "systemctl" ? "/user.slice/../../../etc\n" : base.exec(file, ...rest),
    });
    assert.ok(reads.every((p) => !p.includes("..")), JSON.stringify(reads));
    assert.deepEqual(reads, ["/proc/meminfo"]);
    assert.deepEqual(s.memory.opencodeCgroup, NO_CG);
    assert.equal(s.ok, true);
  });

  test("non-Linux: cgroup is not applicable — nulls, no warning, no exec of systemctl", async () => {
    const calls = [];
    const s = await collectSnapshot(
      "/work",
      healthyDeps({
        platform: "darwin",
        exec: async (file, ...rest) => {
          calls.push(file);
          return healthyDeps().exec(file, ...rest);
        },
      }),
    );
    assert.deepEqual(s.memory.opencodeCgroup, NO_CG);
    assert.ok(!s.warnings.some((w) => w.includes("cgroup")));
    assert.ok(!calls.includes("systemctl"));
  });

  test("a hung cgroup lookup is bounded; other readings survive", async () => {
    const started = Date.now();
    const base = healthyDeps();
    const s = await collectSnapshot("/work", {
      ...base,
      timeouts: { cgroup: 50 },
      exec: async (file, ...rest) => (file === "systemctl" ? new Promise(() => {}) : base.exec(file, ...rest)),
    });
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(s.memory.opencodeCgroup, NO_CG);
    assert.ok(s.warnings.includes(CG_WARNING));
    assert.equal(s.disk.availableBytes, 60 * GIB);
  });

  test("a tighter cgroup budget lowers status and the allowance below the host-only values", async () => {
    // Host: 8 GiB available of 16 → ok, allowance 20% of 8 GiB.
    const host = await collectSnapshot("/work", healthyDeps());
    assert.equal(host.status, "ok");

    // cgroup limit 10 GiB, 1.5 GiB headroom (15% → NOT < 15%, 1.5 GiB < 2 GiB floor) → constrained.
    const tight = await collectSnapshot(
      "/work",
      healthyDeps({ files: cgroupFiles({ current: 8.5 * GIB, max: 10 * GIB }) }),
    );
    assert.equal(tight.status, "constrained");
    assert.equal(tight.suggestedJobMemoryBytes, Math.floor(1.5 * GIB * 0.1)); // 10% of the LOWER (cgroup) budget
    assert.ok(tight.suggestedJobMemoryBytes < host.suggestedJobMemoryBytes);
    assert.ok(tight.warnings.includes("memory: opencode cgroup headroom is low"));

    // Nearly exhausted → critical, zero allowance. Host alone would still say ok.
    const full = await collectSnapshot(
      "/work",
      healthyDeps({ files: cgroupFiles({ current: 10 * GIB - 100 * MIB, max: 10 * GIB }) }),
    );
    assert.equal(full.memory.availableBytes, 8 * GIB);
    assert.equal(full.status, "critical");
    assert.equal(full.suggestedJobMemoryBytes, 0);

    // Over its limit: available clamps to 0, still critical.
    const over = await collectSnapshot(
      "/work",
      healthyDeps({ files: cgroupFiles({ current: 11 * GIB, max: 10 * GIB }) }),
    );
    assert.equal(over.memory.opencodeCgroup.availableBytes, 0);
    assert.equal(over.status, "critical");
  });

  test("a roomy cgroup never RAISES the allowance above the host-based one", async () => {
    const s = await collectSnapshot(
      "/work",
      healthyDeps({ files: cgroupFiles({ current: 1 * GIB, max: 400 * GIB }) }),
    );
    assert.equal(s.status, "ok");
    assert.equal(s.suggestedJobMemoryBytes, Math.floor(8 * GIB * 0.2)); // host (8 GiB) is the lower bound
  });

  test("classifyStatus/suggestJobMemoryBytes unit boundaries with a cgroup", () => {
    const host = { totalBytes: 16 * GIB, availableBytes: 8 * GIB };
    const disk = { totalBytes: 100 * GIB, availableBytes: 60 * GIB };
    const cg = (limit, avail) => ({ currentBytes: limit - avail, limitBytes: limit, availableBytes: avail });
    // Floors only (limit small enough that fractions sit below floors): 4 GiB limit.
    assert.equal(classifyStatus({ memory: { ...host, opencodeCgroup: cg(4 * GIB, 512 * MIB - 1) }, disk }), "critical");
    assert.equal(classifyStatus({ memory: { ...host, opencodeCgroup: cg(4 * GIB, 512 * MIB) }, disk }), "constrained");
    assert.equal(classifyStatus({ memory: { ...host, opencodeCgroup: cg(4 * GIB, 2 * GIB - 1) }, disk }), "constrained");
    assert.equal(classifyStatus({ memory: { ...host, opencodeCgroup: cg(4 * GIB, 2 * GIB) }, disk }), "ok");
    // Unlimited / unknown cgroup adds nothing.
    assert.equal(classifyStatus({ memory: { ...host, opencodeCgroup: NO_CG }, disk }), "ok");
    assert.equal(classifyStatus({ memory: host, disk }), "ok");
    // A cgroup alone never rescues "nothing measured".
    const unknown = { totalBytes: null, availableBytes: null };
    assert.equal(classifyStatus({ memory: { ...unknown, opencodeCgroup: cg(4 * GIB, 3 * GIB) }, disk: unknown }), "constrained");

    // Allowance: lower of host and finite cgroup available, status fraction, cap 20%.
    assert.equal(suggestJobMemoryBytes(10 * GIB, "ok", 4 * GIB), Math.floor(4 * GIB * 0.2));
    assert.equal(suggestJobMemoryBytes(3 * GIB, "ok", 40 * GIB), Math.floor(3 * GIB * 0.2));
    assert.equal(suggestJobMemoryBytes(10 * GIB, "ok", null), 2 * GIB);
    assert.equal(suggestJobMemoryBytes(null, "ok", 5 * GIB), 1 * GIB); // host unknown, cgroup finite
    assert.equal(suggestJobMemoryBytes(10 * GIB, "constrained", 0), 0);
    assert.equal(suggestJobMemoryBytes(10 * GIB, "ok", -5), 0); // clamped
    assert.equal(suggestJobMemoryBytes(null, "ok", null), null);
  });
});

describe("withTimeout", () => {
  test("rejects with ETIMEDOUT when the promise never settles; passes through values", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20), { code: "ETIMEDOUT" });
    assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
  });
});

const hasPs = spawnSync("ps", ["-o", "pid="], { encoding: "utf8" }).status === 0;

describe("non-disclosure (real ps, real process)", () => {
  test(
    "command-line arguments and environment values of a live process never appear",
    { skip: !hasPs && "ps not available" },
    async () => {
      const ARG_SECRET = "ARGSECRET_7f3a9c";
      const ENV_SECRET = "ENVSECRET_b81d42";
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 15000)", "--", `--token=${ARG_SECRET}`],
        { env: { ...process.env, MANTA_TEST_SECRET: ENV_SECRET }, stdio: "ignore" },
      );
      try {
        // Use the real default exec (ps) with a limit big enough to include the child.
        const s = await resourceSnapshot({}, { topProcessLimit: 1_000_000 });
        assert.equal(s.ok, true);
        const mine = s.topProcesses.find((p) => p.pid === child.pid);
        assert.ok(mine, "the live child process should be listed (proves ps was really read)");
        assert.ok(mine.rssBytes > 0);
        assert.deepEqual(Object.keys(mine).sort(), ["name", "pid", "rssBytes"]);
        const blob = JSON.stringify(s);
        assert.ok(!blob.includes(ARG_SECRET), "argv value leaked into the snapshot");
        assert.ok(!blob.includes(ENV_SECRET), "environment value leaked into the snapshot");
        assert.ok(!blob.includes("--token"), "argv flag leaked into the snapshot");
        assert.ok(!blob.includes("MANTA_TEST_SECRET"), "environment name leaked into the snapshot");
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});

describe("wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSource = readFileSync(join(here, "index.mjs"), "utf8");

  test("GET /api/resource-snapshot is wired through the snapshot module (class-2 500 is annotated)", () => {
    assert.match(indexSource, /import \{ resourceSnapshot \} from "\.\/resourceSnapshot\.mjs";/);
    const start = indexSource.indexOf('path === "/api/resource-snapshot"');
    assert.ok(start >= 0, "route must exist in index.mjs");
    const block = indexSource.slice(start, indexSource.indexOf("---------- Native push", start));
    assert.match(block, /req\.method === "GET"/);
    assert.match(block, /resourceSnapshot\(\{ directory \}\)/);
    assert.match(block, /respondJson\(res, 400, result\)/);
    assert.match(block, /class-2 \(BET-1460\)/);
  });
});

import { describe, it, expect } from "vitest";
import {
  SshTransport,
  evictOrphanForwardHolder,
  controlArgs,
  sshTarget,
} from "./sshTransport";
import type { SshRunner, SpawnResult } from "./sshTransport";
import type { AppConfig } from "../../shared/types.js";

// A fully mocked shell so no real ssh/lsof/ps is ever spawned (no SSH in CI).
// Records every invocation and returns canned results keyed by a matcher.

interface Call {
  cmd: "ssh" | string;
  args: string[];
}

class FakeRunner implements SshRunner {
  calls: Call[] = [];
  // ssh handler: inspect args, return a SpawnResult.
  sshHandler: (args: string[]) => SpawnResult = () => ok();
  // capture handler keyed by command.
  captureHandler: (cmd: string, args: string[]) => string = () => "";

  async runSsh(args: string[]): Promise<SpawnResult> {
    this.calls.push({ cmd: "ssh", args });
    return this.sshHandler(args);
  }
  async capture(cmd: string, args: string[]): Promise<string> {
    this.calls.push({ cmd, args });
    return this.captureHandler(cmd, args);
  }

  /** All ssh calls whose args contain the given `-O <op>`. */
  controlOps(): string[] {
    const ops: string[] = [];
    for (const c of this.calls) {
      if (c.cmd !== "ssh") continue;
      const i = c.args.indexOf("-O");
      if (i >= 0 && c.args[i + 1]) ops.push(c.args[i + 1]);
    }
    return ops;
  }
}

function ok(stdout = ""): SpawnResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr = "", code = 255): SpawnResult {
  return { code, stdout: "", stderr };
}

const CONFIG: AppConfig = {
  host: "box.example",
  user: "dev",
  identityFile: "/home/dev/.ssh/id_ed25519",
  projects: [],
};

describe("controlArgs / sshTarget", () => {
  it("builds the shared ControlMaster args including the identity file", () => {
    expect(controlArgs(CONFIG)).toEqual([
      "-o", "ControlMaster=auto",
      "-o", "ControlPath=/tmp/bui-cm-%C",
      "-o", "ControlPersist=10m",
      "-i", "/home/dev/.ssh/id_ed25519",
    ]);
    expect(sshTarget(CONFIG)).toBe("dev@box.example");
    expect(sshTarget({ host: "h", projects: [] })).toBe("h");
  });
});

describe("SshTransport.ping", () => {
  it("resolves when `ssh -O check` reports a live master", async () => {
    const r = new FakeRunner();
    r.sshHandler = () => ok();
    const t = new SshTransport(CONFIG, r);
    await expect(t.ping()).resolves.toBeUndefined();
    expect(r.controlOps()).toEqual(["check"]);
  });

  it("rejects when `ssh -O check` reports no live master", async () => {
    const r = new FakeRunner();
    r.sshHandler = () => fail("No ControlPath specified / not running");
    const t = new SshTransport(CONFIG, r);
    await expect(t.ping()).rejects.toThrow(/check failed/);
  });
});

describe("SshTransport.open", () => {
  it("is a no-op boot when the master is already live (check passes)", async () => {
    const r = new FakeRunner();
    r.sshHandler = (args) => (args.includes("check") ? ok() : ok());
    const t = new SshTransport(CONFIG, r);
    await t.open();
    // Only the `-O check` should have run — no trivial `true` boot needed.
    expect(r.controlOps()).toEqual(["check"]);
    const bootRan = r.calls.some((c) => c.args[c.args.length - 1] === "true");
    expect(bootRan).toBe(false);
  });

  it("boots the master with a trivial `ssh … true` when check fails", async () => {
    const r = new FakeRunner();
    r.sshHandler = (args) => {
      if (args.includes("-O") && args.includes("check")) return fail("not running");
      if (args[args.length - 1] === "true") return ok();
      return ok();
    };
    const t = new SshTransport(CONFIG, r);
    await t.open();
    const bootRan = r.calls.some((c) => c.args[c.args.length - 1] === "true");
    expect(bootRan).toBe(true);
  });

  it("throws when the boot itself fails", async () => {
    const r = new FakeRunner();
    r.sshHandler = (args) => {
      if (args.includes("-O") && args.includes("check")) return fail("not running");
      return fail("Permission denied", 255);
    };
    const t = new SshTransport(CONFIG, r);
    await expect(t.open()).rejects.toThrow(/master boot exited/);
  });

  it("throws when no host is configured", async () => {
    const r = new FakeRunner();
    const t = new SshTransport({ host: "", projects: [] }, r);
    await expect(t.open()).rejects.toThrow(/No host configured/);
  });
});

describe("SshTransport.close", () => {
  it("issues `ssh -O exit` on the control path", async () => {
    const r = new FakeRunner();
    const t = new SshTransport(CONFIG, r);
    await t.close();
    expect(r.controlOps()).toEqual(["exit"]);
    // Uses the shared control args (targets the live master, not an orphan).
    const exitCall = r.calls.find((c) => c.args.includes("exit"))!;
    expect(exitCall.args).toContain("ControlPath=/tmp/bui-cm-%C");
  });

  it("never throws even if `-O exit` fails", async () => {
    const r = new FakeRunner();
    r.sshHandler = () => fail("already gone");
    const t = new SshTransport(CONFIG, r);
    await expect(t.close()).resolves.toBeUndefined();
  });
});

describe("evictOrphanForwardHolder", () => {
  const LIVE = "/tmp/bui-cm-ab12cd34";

  function runnerWithHolder(psCmdline: string): FakeRunner {
    const r = new FakeRunner();
    r.captureHandler = (cmd) => {
      if (cmd === "lsof") return "p42\ncssh\nn127.0.0.1:14096\n";
      if (cmd === "ps") return psCmdline;
      return "";
    };
    // `ssh -G` resolves the live socket; everything else (the orphan `-O exit`) ok.
    r.sshHandler = (args) => {
      if (args.includes("-G")) return ok(`host box.example\ncontrolpath ${LIVE}\n`);
      return ok();
    };
    return r;
  }

  it("evicts a stale orphan master and reports evicted:true", async () => {
    const r = runnerWithHolder(
      "ssh -o ControlPath=/tmp/bui-cm-deadbeef -N box.example",
    );
    const outcome = await evictOrphanForwardHolder(CONFIG, 14096, r);
    expect(outcome).toEqual({ evicted: true });
    // The eviction targets the ORPHAN socket, not the live one.
    const exitCall = r.calls.find(
      (c) => c.cmd === "ssh" && c.args.includes("exit"),
    )!;
    expect(exitCall.args).toContain("ControlPath=/tmp/bui-cm-deadbeef");
  });

  it("reports evicted:false when nothing holds the port", async () => {
    const r = new FakeRunner();
    r.captureHandler = () => "";
    const outcome = await evictOrphanForwardHolder(CONFIG, 14096, r);
    expect(outcome).toEqual({ evicted: false });
  });

  it("reports foreign for a non-bui ssh holder", async () => {
    const r = runnerWithHolder("ssh -L 14096:localhost:14096 box.example");
    const outcome = await evictOrphanForwardHolder(CONFIG, 14096, r);
    expect(outcome).toMatchObject({ foreign: true, pid: 42 });
  });

  it("does not evict when the LIVE master holds the port", async () => {
    const r = runnerWithHolder(`ssh -o ControlPath=${LIVE} -N box.example`);
    const outcome = await evictOrphanForwardHolder(CONFIG, 14096, r);
    expect(outcome).toEqual({ evicted: false });
    expect(r.controlOps()).not.toContain("exit");
  });
});

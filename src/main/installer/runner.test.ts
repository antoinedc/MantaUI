// runner.test.ts — execRemote / streamRemote / probeSshG unit tests with a
// stubbed spawn. No real SSH connection is ever opened.

import { describe, it, expect } from "vitest";
import {
  execRemote,
  streamRemote,
  probeSshG,
  type SpawnFn,
  SSH_BIN,
} from "./runner.js";
import { makeFakeChild } from "./_testFixtures.js";

// ---------------------------------------------------------------------------
// execRemote
// ---------------------------------------------------------------------------

describe("execRemote", () => {
  it("builds the canonical ssh argv (ConnectTimeout + BatchMode + alias + cmd)", async () => {
    const captured: { command: string; args: string[] } = { command: "", args: [] };
    const fake = makeFakeChild();
    const spawn: SpawnFn = (command, args) => {
      captured.command = command;
      captured.args = args;
      return fake.child as any;
    };
    const p = execRemote("dev", "echo hi", { spawn });
    // Fire a successful exit after the listener attaches.
    setImmediate(() => fake.fireExit(0));
    const r = await p;
    expect(captured.command).toBe(SSH_BIN);
    expect(captured.args).toEqual([
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "dev",
      "echo hi",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("returns non-zero exit without throwing", async () => {
    const fake = makeFakeChild();
    const p = execRemote("dev", "false", { spawn: () => fake.child as any });
    setImmediate(() => fake.fireExit(1));
    const r = await p;
    expect(r.code).toBe(1);
  });

  it("captures stdout / stderr into strings", async () => {
    const fake = makeFakeChild();
    const p = execRemote("dev", "sh -c 'echo out; echo err 1>&2'", {
      spawn: () => fake.child as any,
    });
    setImmediate(() => {
      fake.pushStdout("out\n");
      fake.pushStderr("err\n");
      fake.fireExit(0);
    });
    const r = await p;
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
  });

  it("kills the child and reports SIGTERM when the timeout elapses", async () => {
    const fake = makeFakeChild();
    const p = execRemote("dev", "sleep 999", {
      spawn: () => fake.child as any,
      timeoutMs: 50,
    });
    const r = await p;
    expect(r.signal).toBe("SIGTERM");
    expect(r.code).toBeNull();
    expect(fake.killCount()).toBeGreaterThan(0);
    expect(r.stderr).toMatch(/timed out after 50ms/);
  });

  it("rejects empty alias / empty command", async () => {
    await expect(
      execRemote("", "true", { spawn: () => makeFakeChild().child as any }),
    ).rejects.toThrow(/alias is required/);
    await expect(
      execRemote("dev", "", { spawn: () => makeFakeChild().child as any }),
    ).rejects.toThrow(/command is required/);
  });

  it("includes -tt in the argv when forceTty:true", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const p = execRemote("dev", "bash", {
      spawn: (_c, args) => {
        captured.args = args;
        return fake.child as any;
      },
      forceTty: true,
    });
    setImmediate(() => fake.fireExit(0));
    await p;
    expect(captured.args).toContain("-tt");
  });

  it("honours a custom ConnectTimeout", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const p = execRemote("dev", "true", {
      spawn: (_c, args) => {
        captured.args = args;
        return fake.child as any;
      },
      connectTimeoutSec: 30,
    });
    setImmediate(() => fake.fireExit(0));
    await p;
    expect(captured.args).toContain("ConnectTimeout=30");
  });

  it("translates a spawn error into code -1 + a stderr marker", async () => {
    const fake = makeFakeChild();
    const p = execRemote("dev", "true", { spawn: () => fake.child as any });
    setImmediate(() => fake.fireError(new Error("ENOENT ssh")));
    const r = await p;
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(/\[spawn error: ENOENT ssh\]/);
  });
});

// ---------------------------------------------------------------------------
// streamRemote
// ---------------------------------------------------------------------------

describe("streamRemote", () => {
  it("streams every stdout chunk to the sink in arrival order", async () => {
    const fake = makeFakeChild();
    const received: string[] = [];
    const handle = streamRemote("dev", "curl | bash", {
      onStdout: (chunk) => received.push(chunk),
      spawn: () => fake.child as any,
    });
    // Defer pushes so the listener attached inside streamRemote has a chance
    // to drain the buffer in flowing mode (Readable data events are
    // delivered asynchronously). Without this, the pushes land in the buffer
    // but the `data` events haven't fired yet when we await handle.done.
    setImmediate(() => {
      fake.pushStdout("first\n");
      fake.pushStdout("second\n");
      fake.fireExit(0);
    });
    await handle.done;
    expect(received).toEqual(["first\n", "second\n"]);
  });

  it("streams stderr to the onStderr sink when provided", async () => {
    const fake = makeFakeChild();
    const stderrChunks: string[] = [];
    const handle = streamRemote("dev", "curl | bash", {
      onStdout: () => {},
      onStderr: (s) => stderrChunks.push(s),
      spawn: () => fake.child as any,
    });
    setImmediate(() => {
      fake.pushStderr("warning line\n");
      fake.fireExit(0);
    });
    await handle.done;
    expect(stderrChunks).toEqual(["warning line\n"]);
  });

  it("drops stderr silently when no onStderr is provided", async () => {
    const fake = makeFakeChild();
    const handle = streamRemote("dev", "curl | bash", {
      onStdout: () => {},
      spawn: () => fake.child as any,
    });
    setImmediate(() => {
      fake.pushStderr("noise\n");
      fake.fireExit(0);
    });
    await expect(handle.done).resolves.toEqual({ code: 0, signal: null });
  });

  it("kill() sends SIGTERM and the resolved exit reflects the signal", async () => {
    const fake = makeFakeChild();
    const handle = streamRemote("dev", "curl | bash", {
      onStdout: () => {},
      spawn: () => fake.child as any,
    });
    handle.kill();
    // Simulate the child actually dying from the signal.
    setImmediate(() => fake.fireExit(null, "SIGTERM"));
    const out = await handle.done;
    expect(out.signal).toBe("SIGTERM");
    expect(fake.killCount()).toBe(1);
  });

  it("kill() is safe to call multiple times", () => {
    const fake = makeFakeChild();
    const handle = streamRemote("dev", "true", {
      onStdout: () => {},
      spawn: () => fake.child as any,
    });
    handle.kill();
    handle.kill();
    handle.kill();
    expect(fake.killCount()).toBe(3);
  });

  it("rejects empty alias / empty command", () => {
    expect(() =>
      streamRemote("", "true", { onStdout: () => {}, spawn: () => makeFakeChild().child as any }),
    ).toThrow(/alias is required/);
    expect(() =>
      streamRemote("dev", "", { onStdout: () => {}, spawn: () => makeFakeChild().child as any }),
    ).toThrow(/command is required/);
  });
});

// ---------------------------------------------------------------------------
// probeSshG
// ---------------------------------------------------------------------------

describe("probeSshG", () => {
  it("passes `-G <alias>` (NOT a remote command) and parses the captured stdout", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const p = probeSshG("dev", {
      spawn: (_c, args) => {
        captured.args = args;
        return fake.child as any;
      },
    });
    setImmediate(() => {
      fake.pushStdout(
        ["user dev", "hostname box.example", "port 2222", ""].join("\n"),
      );
      fake.fireExit(0);
    });
    const res = await p;
    expect(captured.args).toEqual(["-G", "dev"]);
    expect(res.hostname).toBe("box.example");
    expect(res.user).toBe("dev");
    expect(res.port).toBe(2222);
  });

  it("returns all-nulls when `ssh -G` exits non-zero (alias unparseable)", async () => {
    const fake = makeFakeChild();
    const p = probeSshG("dev", { spawn: () => fake.child as any });
    setImmediate(() => fake.fireExit(1));
    const res = await p;
    expect(res).toEqual({ hostname: null, user: null, port: null, identityFiles: [] });
  });

  it("returns all-nulls on a spawn-time error (ssh not on PATH)", async () => {
    const fake = makeFakeChild();
    const p = probeSshG("dev", { spawn: () => fake.child as any });
    setImmediate(() => fake.fireError(new Error("ENOENT")));
    const res = await p;
    expect(res).toEqual({ hostname: null, user: null, port: null, identityFiles: [] });
  });

  it("rejects an empty alias", async () => {
    await expect(probeSshG("", { spawn: () => makeFakeChild().child as any })).rejects.toThrow(
      /alias is required/,
    );
  });
});

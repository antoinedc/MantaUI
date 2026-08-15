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
import { makeFakeChild, makeStdinCapturingChild } from "./_testFixtures.js";

// ---------------------------------------------------------------------------
// execRemote
// ---------------------------------------------------------------------------

describe("execRemote", () => {
  it("builds the canonical ssh argv (ConnectTimeout + BatchMode + -- + alias + cmd)", async () => {
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
    // `--` terminates option parsing before the destination (BET-384
    // review cycle 1 nit — a leading-`-` destination must never be read
    // as an ssh(1) flag). See buildArgs's comment for the empirical proof.
    expect(captured.args).toEqual([
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "dev",
      "echo hi",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("puts -- immediately before the destination even with a custom target's -p/-i", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const p = execRemote(
      { kind: "custom", host: "-oProxyCommand=evil", port: 2222, identityFile: "~/.ssh/id_x" },
      "echo hi",
      {
        spawn: (_c, args) => {
          captured.args = args;
          return fake.child as any;
        },
      },
    );
    setImmediate(() => fake.fireExit(0));
    await p;
    const dashDashIndex = captured.args.indexOf("--");
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(captured.args[dashDashIndex + 1]).toBe("-oProxyCommand=evil");
    // -p/-i land before --, never after (they're real ssh options, not
    // part of the destination).
    expect(captured.args.indexOf("-p")).toBeLessThan(dashDashIndex);
    expect(captured.args.indexOf("-i")).toBeLessThan(dashDashIndex);
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
// execRemote — stdin option (BET-979)
// ---------------------------------------------------------------------------
// The sudo password (any secret) is delivered over a SEPARATE, short ssh call
// via the `stdin` option — never in the ssh argv (invisible to `ps` on the
// box). When `stdin` is absent the child's stdio[0] must stay `"ignore"`,
// byte-identical to today.

describe("execRemote — stdin (BET-979)", () => {
  it("opens stdin as a pipe, writes the string + newline, and ends it", async () => {
    const captured: { args: string[]; wrote: string[]; ended: boolean } = {
      args: [],
      wrote: [],
      ended: false,
    };
    const { child, fireExit } = makeStdinCapturingChild(captured);
    const p = execRemote("dev", "bash -lc 'cat > x'", {
      spawn: (_c, args) => {
        captured.args = args;
        return child;
      },
      stdin: "hunter2",
    });
    setImmediate(() => fireExit(0));
    const r = await p;
    expect(r.code).toBe(0);
    expect(captured.wrote).toEqual(["hunter2\n"]);
    expect(captured.ended).toBe(true);
    // The secret must never appear in the ssh argv (ps visibility).
    expect(captured.args.join(" ")).not.toContain("hunter2");
  });

  it("keeps stdio[0] as ignore when stdin is absent (byte-identical)", async () => {
    let spawnStdio: unknown = null;
    const fake = makeFakeChild();
    const spawn: SpawnFn = (_c, _a, options) => {
      spawnStdio = options?.stdio;
      return fake.child as any;
    };
    const p = execRemote("dev", "true", { spawn });
    setImmediate(() => fake.fireExit(0));
    await p;
    expect(spawnStdio).toEqual(["ignore", "pipe", "pipe"]);
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

// ---------------------------------------------------------------------------
// BET-360: askpass env-var construction + BatchMode suppression
// ---------------------------------------------------------------------------

describe("execRemote — askpass env (BET-360)", () => {
  it("drops BatchMode=yes when allowPrompt is true", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const p = execRemote("dev", "echo hi", {
      spawn: (_c, args) => {
        captured.args = args;
        return fake.child as any;
      },
      allowPrompt: true,
    });
    setImmediate(() => fake.fireExit(0));
    await p;
    // BatchMode=yes must NOT be in the args when allowPrompt is set.
    expect(captured.args).not.toContain("BatchMode=yes");
    // ConnectTimeout is still present.
    expect(captured.args).toContain("ConnectTimeout=10");
  });

  it("keeps BatchMode=yes by default (allowPrompt unset)", async () => {
    const captured: { args: string[] } = { args: [] };
    const fake = makeFakeChild();
    const p = execRemote("dev", "echo hi", {
      spawn: (_c, args) => {
        captured.args = args;
        return fake.child as any;
      },
    });
    setImmediate(() => fake.fireExit(0));
    await p;
    expect(captured.args).toContain("BatchMode=yes");
  });

  it("merges env into the spawn options (overlay, not replace)", async () => {
    const captured: { opts: Parameters<SpawnFn>[2] | undefined } = { opts: undefined };
    const fake = makeFakeChild();
    const askpassEnv = {
      SSH_ASKPASS: "/tmp/helper.sh",
      SSH_ASKPASS_REQUIRE: "force",
      MANTA_ASKPASS_FILE: "/tmp/pw",
    };
    const p = execRemote("dev", "echo hi", {
      spawn: (_c, _a, opts) => {
        captured.opts = opts;
        return fake.child as any;
      },
      env: askpassEnv,
    });
    setImmediate(() => fake.fireExit(0));
    await p;
    // The env was passed through and contains the askpass vars.
    expect(captured.opts?.env).toBeDefined();
    expect(captured.opts?.env?.SSH_ASKPASS).toBe("/tmp/helper.sh");
    expect(captured.opts?.env?.SSH_ASKPASS_REQUIRE).toBe("force");
    // process.env is preserved (PATH must survive).
    expect(captured.opts?.env?.PATH).toBe(process.env.PATH);
  });

  it("does not set env on spawn when no env option is provided", async () => {
    const captured: { opts: Parameters<SpawnFn>[2] | undefined } = { opts: undefined };
    const fake = makeFakeChild();
    const p = execRemote("dev", "echo hi", {
      spawn: (_c, _a, opts) => {
        captured.opts = opts;
        return fake.child as any;
      },
    });
    setImmediate(() => fake.fireExit(0));
    await p;
    // No env key → child inherits process.env (Node default).
    expect(captured.opts?.env).toBeUndefined();
  });
});

describe("streamRemote — askpass env (BET-360)", () => {
  it("drops BatchMode and merges env when allowPrompt + env are set", async () => {
    const captured: { args: string[]; opts: Parameters<SpawnFn>[2] | undefined } = {
      args: [],
      opts: undefined,
    };
    const fake = makeFakeChild();
    const handle = streamRemote("dev", "echo hi", {
      spawn: (_c, args, opts) => {
        captured.args = args;
        captured.opts = opts;
        return fake.child as any;
      },
      allowPrompt: true,
      env: { SSH_ASKPASS: "/tmp/helper.sh", SSH_ASKPASS_REQUIRE: "force", MANTA_ASKPASS_FILE: "/tmp/pw" },
      onStdout: () => {},
    });
    setImmediate(() => fake.fireExit(0));
    await handle.done;
    expect(captured.args).not.toContain("BatchMode=yes");
    expect(captured.opts?.env?.SSH_ASKPASS).toBe("/tmp/helper.sh");
  });
});

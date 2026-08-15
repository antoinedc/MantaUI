// sudoPass.test.ts — units for the sudo-password staging (BET-979).
//
// writeSudoPass stages the password at ~/.manta-sudo-pass on the box over a
// SEPARATE, short ssh call, delivering it via STDIN — never in the ssh argv.
// clearSudoPass removes it and must never throw (a failed cleanup must not
// fail an otherwise-good install). Both commands are constants so they live
// in exactly one place and are pinned here.

import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { SpawnFn } from "./runner.js";
import {
  WRITE_SUDO_PASS_CMD,
  CLEAR_SUDO_PASS_CMD,
  writeSudoPass,
  clearSudoPass,
} from "./sudoPass.js";

// A fake child that captures every stdin write + the ssh argv, so the tests
// can assert both "the password went in via stdin" and "it is NOT in argv".
function makeStdinCapturingChild(captured: { args: string[]; wrote: string[] }) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      captured.wrote.push(chunk.toString("utf8"));
      cb();
    },
    final(cb) {
      cb();
    },
  });
  const emitter = new EventEmitter();
  const child: any = {
    stdin,
    stdout,
    stderr,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: vi.fn(),
  };
  return { child, fireExit: (code: number) => emitter.emit("exit", code, null) };
}

describe("sudo password command constants (BET-979 D7)", () => {
  it("WRITE_SUDO_PASS_CMD is exactly the D1 step 1 command", () => {
    expect(WRITE_SUDO_PASS_CMD).toBe(
      `bash -lc 'umask 077; cat > "$HOME/.manta-sudo-pass"'`,
    );
  });

  it("CLEAR_SUDO_PASS_CMD is exactly the D1 step 2 command", () => {
    expect(CLEAR_SUDO_PASS_CMD).toBe(`bash -lc 'rm -f "$HOME/.manta-sudo-pass"'`);
  });
});

describe("writeSudoPass", () => {
  it("passes the password via stdin and NEVER in the command/argv", async () => {
    const captured: { args: string[]; wrote: string[] } = { args: [], wrote: [] };
    const { child, fireExit } = makeStdinCapturingChild(captured);
    const spawn: SpawnFn = (_c, args) => {
      captured.args = args;
      return child;
    };
    const ok = writeSudoPass("dev", "s3cret!", { spawn });
    setImmediate(() => fireExit(0));
    expect(await ok).toBe(true);
    // The password hit stdin (with the terminating newline cat needs).
    expect(captured.wrote).toEqual(["s3cret!\n"]);
    // ...and never the ssh argv (invisible to `ps` on the box).
    expect(captured.args.join(" ")).not.toContain("s3cret!");
    expect(captured.args.join(" ")).not.toContain("s3cret");
  });

  it("returns false when the write exits non-zero", async () => {
    const captured: { args: string[]; wrote: string[] } = { args: [], wrote: [] };
    const { child, fireExit } = makeStdinCapturingChild(captured);
    const p = writeSudoPass("dev", "pw", { spawn: () => child });
    setImmediate(() => fireExit(1));
    expect(await p).toBe(false);
  });
});

describe("clearSudoPass", () => {
  it("resolves even when the underlying exec rejects (never throws)", async () => {
    // A spawn that throws synchronously → execRemote rejects; clearSudoPass
    // must swallow it and resolve.
    const failingSpawn: SpawnFn = () => {
      throw new Error("ssh not found");
    };
    await expect(clearSudoPass("dev", { spawn: failingSpawn })).resolves.toBeUndefined();
  });

  it("resolves on a normal successful clear", async () => {
    const captured: { args: string[]; wrote: string[] } = { args: [], wrote: [] };
    const { child, fireExit } = makeStdinCapturingChild(captured);
    const p = clearSudoPass("dev", { spawn: () => child });
    setImmediate(() => fireExit(0));
    await expect(p).resolves.toBeUndefined();
  });
});

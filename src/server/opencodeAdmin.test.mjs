// Tests for src/server/opencodeAdmin.mjs
//
// `exec` is injected so these never actually run systemctl.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restartOpencode, runServerSelfUpdate } from "./opencodeAdmin.mjs";

describe("restartOpencode", () => {
  it("invokes systemctl --user restart opencode-serve with a fixed argv (no shell string)", async () => {
    const calls = [];
    const exec = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: "", stderr: "" }; };
    const result = await restartOpencode(exec);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "systemctl");
    assert.deepEqual(calls[0].args, ["--user", "restart", "opencode-serve"]);
  });

  it("returns ok:false with the error message when the command fails", async () => {
    const exec = async () => { throw new Error("Unit opencode-serve.service not found."); };
    const result = await restartOpencode(exec);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Unit opencode-serve.service not found.");
  });

  it("never interpolates arguments into a single shell string", async () => {
    // Defense-in-depth regression guard: args must always be an array of
    // fixed literals, never a caller-influenced string that could carry
    // shell metacharacters. This function takes no external input at all,
    // so the array is always exactly these three literals.
    const calls = [];
    const exec = async (cmd, args) => { calls.push({ cmd, args }); };
    await restartOpencode(exec);
    for (const arg of calls[0].args) {
      assert.equal(typeof arg, "string");
    }
    assert.equal(calls[0].args.join(" "), "--user restart opencode-serve");
  });
});

describe("runServerSelfUpdate", () => {
  // The injection here uses the callback-shaped execFile (not the
  // promisified one) because the production path needs the raw
  // ChildProcess handle to .unref() it. Stub returns a fake child with a
  // fixed pid and a no-op unref so we can assert the call shape.
  function fakeSpawn(records, pid = 4242) {
    return (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return {
        pid,
        unref() {
          /* no-op */
        },
      };
    };
  }

  it("spawns the script detached + unref'd with no argv (fire-and-forget)", async () => {
    const calls = [];
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", fakeSpawn(calls));
    assert.equal(result.ok, true);
    assert.equal(result.pid, 4242);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/abs/scripts/self-update.sh");
    assert.deepEqual(calls[0].args, []);
    // detached:true is the load-bearing flag — without it the child would
    // keep the bui-server alive after the restart. stdio:"ignore" keeps
    // the script's stdout/stderr from blowing up bui-server's stdio.
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.stdio, "ignore");
  });

  it("returns ok:false with the error message when spawn throws (script missing, no exec bit)", async () => {
    const spawn = () => {
      throw new Error("spawn /abs/scripts/self-update.sh EACCES");
    };
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", spawn);
    assert.equal(result.ok, false);
    assert.equal(result.error, "spawn /abs/scripts/self-update.sh EACCES");
  });

  it("never interpolates arguments into a single shell string", async () => {
    // Same defense-in-depth guard as restartOpencode: this function takes
    // no caller input (the script path is resolved at module load from
    // import.meta.url), so the argv array must always be exactly [].
    const calls = [];
    await runServerSelfUpdate("/abs/scripts/self-update.sh", fakeSpawn(calls));
    assert.deepEqual(calls[0].args, []);
  });
});

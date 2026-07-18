// Tests for src/server/opencodeAdmin.mjs
//
// `exec` is injected so these never actually run systemctl.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restartOpencode } from "./opencodeAdmin.mjs";

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

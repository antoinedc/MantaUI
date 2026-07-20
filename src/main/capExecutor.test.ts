// Tests for src/main/capExecutor.ts — the Mac-side plugin executor.
//
// BET-210 regression: ctx.exec was dropping opts.env at the spawn boundary,
// so manifest `env:` and `MANTA_INPUT_*` never reached the `run:` shell.
// These tests spawn a real /bin/sh through the public `makeExec` helper
// (re-exported for testing) and assert the env actually crosses the spawn
// boundary. No mocks — the whole point of the bug is that env must reach
// the child process, and the only honest assertion is to look at the
// child's own stdout.

import { describe, it, expect } from "vitest";
import { makeExec, type CapCtx } from "./capExecutor.js";

// Shared abort signal that never fires — tests rely on the spawn exiting
// quickly under their own /bin/sh -c command. If it doesn't, vitest's
// default timeout will fail the test with a clearer message than a hung
// AbortController would.
const signal = new AbortController().signal;
const noop = () => {};

describe("capExecutor — makeExec env passthrough (BET-210)", () => {
  it("passes opts.env entries into the spawned shell", async () => {
    const exec = makeExec(signal, noop);
    const r = await exec(
      "/bin/sh",
      ["-c", "printf '%s' \"$MANTA_INPUT_FOO\""],
      { env: { MANTA_INPUT_FOO: "bar-from-opts" } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("bar-from-opts");
  });

  it("preserves multiple env vars, including manifest-style keys", async () => {
    const exec = makeExec(signal, noop);
    // Mirror a realistic buildEnv() output: MANTA_INPUT_* + a manifest env
    // key + MANTA_PLUGIN/MANTA_JOB_ID. The /bin/sh -c script prints them
    // in order, separated by a delimiter that can't appear in the values.
    const env = {
      MANTA_INPUT_SIMULATOR: "iPhone 16 Pro",
      MANTA_INPUT_SCHEME: "MantaUI",
      WORKSPACE: "/tmp/does-not-need-to-exist",
      MANTA_PLUGIN: "ios-mantaui",
      MANTA_JOB_ID: "deadbeef",
    };
    const r = await exec(
      "/bin/sh",
      [
        "-c",
        "printf '%s|%s|%s|%s|%s' \"$MANTA_INPUT_SIMULATOR\" \"$MANTA_INPUT_SCHEME\" \"$WORKSPACE\" \"$MANTA_PLUGIN\" \"$MANTA_JOB_ID\"",
      ],
      { env },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("iPhone 16 Pro|MantaUI|/tmp/does-not-need-to-exist|ios-mantaui|deadbeef");
  });

  it("falls back to process.env when opts.env is omitted (legacy behavior)", async () => {
    const exec = makeExec(signal, noop);
    // HOME is set on every sane process; if opts.env is omitted, HOME must
    // still reach the child (proves the PATH-patch path didn't regress the
    // no-opts branch).
    const r = await exec(
      "/bin/sh",
      ["-c", "printf '%s' \"$HOME\""],
      {},
    );
    expect(r.code).toBe(0);
    // Don't assert the exact value — $HOME is environment-dependent.
    // Assert that it is non-empty (env reached the child at all).
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toBe(process.env.HOME ?? "");
  });

  it("re-applies the PATH prefix onto opts.env so Homebrew stays visible", async () => {
    const exec = makeExec(signal, noop);
    // Even when the caller supplies its own PATH (e.g. buildEnv() inherits
    // process.env.PATH), the Homebrew PATH_PREFIX must still be prepended.
    // We assert by checking that PATH starts with PATH_PREFIX; exact tail
    // is environment-dependent.
    const r = await exec(
      "/bin/sh",
      ["-c", "printf '%s' \"$PATH\""],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith("/opt/homebrew/bin:/usr/local/bin:")).toBe(true);
    expect(r.stdout.endsWith("/usr/bin:/bin")).toBe(true);
  });

  it("exposes env on the CapCtx exec opts type (compile-time + runtime)", async () => {
    // Compile-time: this assignment only type-checks if `env` is part of
    // the opts shape. Runtime: re-assert that the env reaches the child so
    // a future refactor that adds `env` to the type but forgets the spawn
    // plumbing is still caught.
    const ctx: Pick<CapCtx, "exec"> = {
      exec: makeExec(signal, noop),
    };
    const r = await ctx.exec(
      "/bin/sh",
      ["-c", "printf '%s' \"$MANTA_INPUT_PROOF\""],
      { env: { MANTA_INPUT_PROOF: "yes" } },
    );
    expect(r.stdout).toBe("yes");
  });
});

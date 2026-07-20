// Tests for src/main/capExecutor.ts — focused on the per-step env plumbing
// (BET-210). Keeps the surface small: real /bin/sh spawn, no spawn mocking.
// `makeExec` is exported for these tests so the env path is reachable
// without going through the manifest handler.

import { describe, it, expect } from "vitest";
import { makeExec } from "./capExecutor.js";

const NOOP_LOG = () => {};

describe("makeExec — per-step env plumbing (BET-210)", () => {
  it("delivers opts.env vars to the spawned shell", async () => {
    const exec = makeExec(new AbortController().signal, NOOP_LOG);
    const res = await exec("/bin/sh", ["-c", 'echo "$MANTA_INPUT_FOO"'], {
      env: { MANTA_INPUT_FOO: "bar" },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("bar\n");
  });

  it("merges opts.env with the PATH patch (Homebrew prefix preserved on macOS)", async () => {
    const exec = makeExec(new AbortController().signal, NOOP_LOG);
    const res = await exec("/bin/sh", ["-c", 'echo "$MANTA_INPUT_BREW:$PATH"'], {
      env: { MANTA_INPUT_BREW: "ok" },
    });
    expect(res.code).toBe(0);
    const stdout = res.stdout.replace(/\n$/, "");
    // The executor unconditionally prepends "/opt/homebrew/bin:/usr/local/bin:"
    // to the spawn PATH so GUI-launched macOS shells see Homebrew binaries
    // (see AGENTS.md "macOS PATH gotcha"). The test asserts the prefix lands
    // regardless of the host's actual PATH (this test box may be Linux).
    expect(stdout.startsWith("ok:/opt/homebrew/bin:/usr/local/bin:")).toBe(true);
  });

  it("falls back to process.env when opts.env is omitted (regression)", async () => {
    const exec = makeExec(new AbortController().signal, NOOP_LOG);
    // HOME is in process.env on every supported platform — use it as a probe.
    const expected = process.env.HOME ?? "";
    const res = await exec("/bin/sh", ["-c", 'echo "$HOME"']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`${expected}\n`);
  });

  it("propagates manifest env: values alongside the PATH patch", async () => {
    const exec = makeExec(new AbortController().signal, NOOP_LOG);
    // Simulate what buildEnv returns: process.env + manifest env + MANTA_INPUT_*.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPO: "/tmp/repo",
      MANTA_INPUT_SIMULATOR: "iPhone 16 Pro",
    };
    const res = await exec(
      "/bin/sh",
      ["-c", 'echo "$REPO/$MANTA_INPUT_SIMULATOR"'],
      { env },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("/tmp/repo/iPhone 16 Pro\n");
  });
});

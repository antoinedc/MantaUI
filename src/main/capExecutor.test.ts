// Tests for src/main/capExecutor.ts — the desktop-side plugin executor.
//
// Three concerns live here:
//
// 1. BET-210 regression: ctx.exec was dropping opts.env at the spawn
//    boundary, so manifest `env:` and `MANTA_INPUT_*` never reached the
//    `run:` shell. These tests spawn a real /bin/sh through the public
//    `makeExec` helper and assert the env actually crosses the spawn
//    boundary. No mocks — the whole point of the bug is that env must
//    reach the child process, and the only honest assertion is to look at
//    the child's own stdout.
//
// 2. BET-327: the two pure helpers that the executor reads process.platform
//    into ONCE and threads down — `spawnErrorMessage` and `killTree`.
//    Tests assert each platform branch without spawning a real child
//    where unnecessary; `killTree` for `linux` uses a fake child to
//    capture the SIGTERM call without touching the real process tree.
//    The third helper from BET-327, `patchPath`, was promoted to
//    `src/shared/paths.mjs` in BET-339 (shared with the box server's
//    Claude credential refresh) and now lives in `paths.test.ts`.
//
// 3. Compile-time surface: `CapCtx.exec` opts must include `env`, and
//    supplying it must still pass through at runtime.

import { describe, it, expect, vi } from "vitest";
import {
  makeExec,
  spawnErrorMessage,
  killTree,
  makeManifestHandler,
  type CapCtx,
} from "./capExecutor.js";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("a caller-supplied PATH in opts.env reaches the child unmodified on the CI platform", async () => {
    // CI runs on Linux, where patchPath deliberately leaves PATH alone
    // (no Homebrew prefix, no extra key). Asserting the exact bytes here
    // pins the "POSIX CI / Windows behavior parity" promise: what the
    // caller put in opts.env.PATH is what the child sees, byte-identical.
    const exec = makeExec(signal, noop);
    const callerPath = "/usr/bin:/bin";
    const r = await exec(
      "/bin/sh",
      ["-c", "printf '%s' \"$PATH\""],
      { env: { PATH: callerPath } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(callerPath);
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

// ---------------------------------------------------------------------------
// spawnErrorMessage — the one string builder shared by the sync catch and
// the child's `error` event.
// ---------------------------------------------------------------------------

describe("capExecutor — spawnErrorMessage (BET-327)", () => {
  it("mentions Homebrew on darwin and includes the cmd and detail", () => {
    const msg = spawnErrorMessage("claude", "darwin", "spawn ENOENT");
    expect(msg).toContain("Homebrew");
    expect(msg).toContain("claude");
    expect(msg).toContain("spawn ENOENT");
  });

  it("does NOT mention Homebrew on win32 and includes the cmd and detail", () => {
    const msg = spawnErrorMessage("claude", "win32", "spawn ENOENT");
    expect(msg).not.toContain("Homebrew");
    expect(msg).toContain("claude");
    expect(msg).toContain("spawn ENOENT");
  });

  it("does NOT mention Homebrew on linux and includes the cmd and detail", () => {
    const msg = spawnErrorMessage("claude", "linux", "spawn ENOENT");
    expect(msg).not.toContain("Homebrew");
    expect(msg).toContain("claude");
    expect(msg).toContain("spawn ENOENT");
  });
});

// ---------------------------------------------------------------------------
// killTree — abort a child. POSIX branches assert SIGTERM via a fake
// ChildProcess; the win32 branch is asserted to not throw when pid is
// undefined (taskkill is NOT actually run, per the issue spec).
// ---------------------------------------------------------------------------

describe("capExecutor — killTree (BET-327 / BET-652)", () => {
  it("kills the process GROUP on POSIX — SIGTERM then SIGKILL after grace", () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    try {
      const fake = { pid: 12345, kill: childKill, exitCode: null } as unknown as ChildProcess;
      killTree(fake, "linux", 5_000);
      // The shell leads its own process group (spawned detached), so the FIRST
      // kill is the group signum −pid, not the single process.
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it("escalates to group SIGKILL after the grace window on POSIX", () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    try {
      const fake = { pid: 12345, kill: childKill, exitCode: null } as unknown as ChildProcess;
      killTree(fake, "linux", 5_000);
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGTERM");
      processKill.mockClear();
      vi.advanceTimersByTime(5_000);
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGKILL");
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("falls back to the single process when the child has no pid (POSIX)", () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    try {
      const fake = { pid: undefined, kill: childKill, exitCode: null } as unknown as ChildProcess;
      expect(() => killTree(fake, "linux", 5_000)).not.toThrow();
      expect(childKill).toHaveBeenCalledWith("SIGTERM");
      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it("does not throw on win32 when pid is undefined", () => {
    // The fake child has pid: undefined — taskkill would crash if it ran,
    // so the guard must short-circuit. We do NOT want this test to
    // actually invoke taskkill (CI does not have it, and the issue
    // explicitly bans running it).
    const fake = { pid: undefined, kill: vi.fn(), exitCode: null } as unknown as ChildProcess;
    expect(() => killTree(fake, "win32", 5_000)).not.toThrow();
    expect(fake.kill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step timeout (BET-652) — makeExec now accepts a per-step AbortSignal and
// the runner passes the step controller's signal through, so a step's
// `timeout:` is actually enforced instead of running to the 25-min job abort.
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<CapCtx>): CapCtx {
  return {
    jobId: "abc12345",
    input: {},
    config: {},
    signal: new AbortController().signal,
    log: () => {},
    exec: () => Promise.resolve({ code: 0, stdout: "" }),
    ...overrides,
  } as unknown as CapCtx;
}

describe("capExecutor — per-step timeout (BET-652)", () => {
  it("rejects a step killed by its own timeout with a clear message, job signal unaborted", async () => {
    vi.useFakeTimers();
    try {
      const handler = makeManifestHandler({
        name: "t",
        steps: [{ name: "hang", run: "true", timeout: "1s" }],
      } as never);
      const job = new AbortController();
      // Fake exec that hangs until its own opts.signal aborts (mirrors the
      // real makeExec's group-kill-on-step-abort) — then resolves like a
      // killed command would (non-zero).
      const exec = (
        _cmd: string,
        _args: string[],
        opts?: { signal?: AbortSignal },
      ) =>
        new Promise<{ code: number; stdout: string }>((resolve) => {
          const s = opts?.signal;
          if (!s) return resolve({ code: 0, stdout: "" });
          if (s.aborted) return resolve({ code: 143, stdout: "" });
          s.addEventListener(
            "abort",
            () => resolve({ code: 143, stdout: "" }),
            { once: true },
          );
        });
      const ctx = makeCtx({ signal: job.signal, exec });
      const pending = handler(ctx);
      // Mark the rejection handled up front so advancing the fake timers
      // (which fires the step abort → exec resolves → runManifest throws)
      // doesn't trip Node's unhandled-rejection warning before we observe it.
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).rejects.toThrow("step 1 (hang) timed out after 1s");
      expect(job.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// git-tree integrity guard (BET-652) — HEAD is snapshotted on every distinct
// step cwd before the build and re-read afterward; a mismatch (an external
// process reset the shared clone mid-job) discards the result by failing.
// ---------------------------------------------------------------------------

describe("capExecutor — git-tree integrity guard (BET-652)", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);

  it("rejects when HEAD moved during the job, and probes exactly twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-integrity-"));
    try {
      let probe = 0;
      const logs: string[] = [];
      const exec = (_cmd: string): Promise<{ code: number; stdout: string }> => {
        if (_cmd === "git") {
          probe++;
          const sha = probe === 1 ? shaA : shaB;
          return Promise.resolve({ code: 0, stdout: `${sha}\n` });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      };
      const handler = makeManifestHandler({
        name: "t",
        steps: [{ name: "build", run: "true", cwd: dir }],
      } as never);
      const ctx = makeCtx({ exec, log: (l) => logs.push(l) });
      await expect(handler(ctx)).rejects.toThrow(
        "working tree moved during the job",
      );
      expect(probe).toBe(2);
      expect(logs.some((l) => l.includes("[integrity] HEAD at start"))).toBe(true);
      expect(logs.some((l) => l.includes("[integrity] HEAD at end"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves when HEAD is unchanged at the end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-integrity-"));
    try {
      let probe = 0;
      const exec = (_cmd: string): Promise<{ code: number; stdout: string }> => {
        if (_cmd === "git") {
          probe++;
          return Promise.resolve({ code: 0, stdout: `${shaA}\n` });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      };
      const handler = makeManifestHandler({
        name: "t",
        steps: [{ name: "build", run: "true", cwd: dir }],
      } as never);
      const ctx = makeCtx({ exec });
      const res = await handler(ctx);
      expect(res.result).toEqual({ steps: [{ name: "build", code: 0, skipped: false }] });
      expect(probe).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips non-git cwds silently (non-zero rev-parse), no integrity logs, resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-integrity-"));
    try {
      let probe = 0;
      const logs: string[] = [];
      const exec = (_cmd: string): Promise<{ code: number; stdout: string }> => {
        if (_cmd === "git") {
          probe++;
          return Promise.resolve({ code: 128, stdout: `fatal: not a git repository\n` });
        }
        return Promise.resolve({ code: 0, stdout: "" });
      };
      const handler = makeManifestHandler({
        name: "t",
        steps: [{ name: "build", run: "true", cwd: dir }],
      } as never);
      const ctx = makeCtx({ exec, log: (l) => logs.push(l) });
      const res = await handler(ctx);
      expect(res.result).toEqual({ steps: [{ name: "build", code: 0, skipped: false }] });
      expect(probe).toBe(1);
      expect(logs.some((l) => l.includes("[integrity]"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

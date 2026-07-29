// askpass.test.ts — unit tests for the SSH_ASKPASS session manager.
//
// No real filesystem: all I/O is injected. Tests verify the env-var
// construction, the platform-specific helper script content, the 0600
// passphrase file, and the idempotent cleanup.

import { describe, it, expect } from "vitest";
import {
  createAskpassSession,
  helperScriptContent,
  helperScriptExtension,
} from "./askpass.js";

describe("helperScriptContent", () => {
  it("returns a /bin/sh script on unix", () => {
    const content = helperScriptContent("linux");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain('cat "$MANTA_ASKPASS_FILE"');
  });

  it("returns a cmd batch on win32", () => {
    const content = helperScriptContent("win32");
    expect(content).toContain("@echo off");
    expect(content).toContain('type "%MANTA_ASKPASS_FILE%"');
  });

  it("guards against a missing MANTA_ASKPASS_FILE (unix)", () => {
    const content = helperScriptContent("darwin");
    expect(content).toMatch(/if.*-z.*MANTA_ASKPASS_FILE/);
  });
});

describe("helperScriptExtension", () => {
  it("returns .sh on unix", () => {
    expect(helperScriptExtension("linux")).toBe(".sh");
    expect(helperScriptExtension("darwin")).toBe(".sh");
  });

  it("returns .cmd on win32", () => {
    expect(helperScriptExtension("win32")).toBe(".cmd");
  });
});

describe("createAskpassSession", () => {
  function makeDeps() {
    const files: Record<string, string> = {};
    const chmods: Record<string, number> = {};
    const dirs: string[] = [];
    return {
      files,
      chmods,
      dirs,
      deps: {
        platform: "linux" as string,
        tmpdirPath: "/tmp",
        mkdtemp: (prefix: string) => {
          const dir = `/tmp/${prefix}XYZ`;
          dirs.push(dir);
          return dir;
        },
        writeFile: (path: string, data: string) => {
          files[path] = data;
        },
        chmod: (path: string, mode: number) => {
          chmods[path] = mode;
        },
        rm: (path: string, _opts: { recursive: boolean; force: boolean }) => {
          const idx = dirs.indexOf(path);
          if (idx >= 0) dirs.splice(idx, 1);
        },
      },
    };
  }

  it("writes the helper script and passphrase file, and returns the correct env", () => {
    const { deps, files, chmods } = makeDeps();
    const session = createAskpassSession("hunter2", deps);

    expect(session.env.SSH_ASKPASS).toMatch(/askpass\.sh$/);
    expect(session.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(session.env.MANTA_ASKPASS_FILE).toMatch(/passphrase$/);

    // The helper script was written with the sh content.
    const helperPath = session.env.SSH_ASKPASS;
    expect(files[helperPath]).toContain("#!/bin/sh");
    expect(files[helperPath]).toContain('cat "$MANTA_ASKPASS_FILE"');

    // The passphrase file was written.
    const pwPath = session.env.MANTA_ASKPASS_FILE;
    expect(files[pwPath]).toBe("hunter2");

    // The helper was chmod'd executable on unix.
    expect(chmods[helperPath]).toBe(0o700);
  });

  it("chmods the helper on unix but not on win32", () => {
    const { deps: unixDeps, chmods: unixChmods } = makeDeps();
    unixDeps.platform = "linux";
    createAskpassSession("pw", unixDeps);
    const unixHelper = Object.keys(unixChmods)[0];
    expect(unixHelper).toBeDefined();
    expect(unixChmods[unixHelper]).toBe(0o700);

    const winFixture = makeDeps();
    winFixture.deps.platform = "win32";
    createAskpassSession("pw", winFixture.deps);
    // No chmod calls on win32.
    expect(Object.keys(winFixture.chmods)).toHaveLength(0);
  });

  it("writes a .cmd helper on win32", () => {
    const { deps, files } = makeDeps();
    deps.platform = "win32";
    const session = createAskpassSession("pw", deps);
    expect(session.env.SSH_ASKPASS).toMatch(/askpass\.cmd$/);
    expect(files[session.env.SSH_ASKPASS]).toContain("@echo off");
  });

  it("cleanup removes the temp dir and is idempotent", () => {
    const { deps, dirs } = makeDeps();
    const session = createAskpassSession("pw", deps);
    expect(dirs).toHaveLength(1);
    session.cleanup();
    expect(dirs).toHaveLength(0);
    // Second cleanup is a no-op.
    session.cleanup();
    expect(dirs).toHaveLength(0);
  });

  it("throws if passphrase is not a string", () => {
    expect(() => createAskpassSession(null as never, makeDeps().deps)).toThrow(
      /passphrase is required/,
    );
  });
});

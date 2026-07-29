// Tests for src/shared/paths.mjs — the on-disk state directory constants,
// the `~` → `$HOME` expander, and the platform-aware PATH patcher shared by
// the desktop plugin runner (src/main/capExecutor.ts) and the box server's
// Claude credential refresh (src/server/opencode.mjs).
//
// Pure-function coverage. The expander's POSIX-vs-Windows correctness comes
// from `path.join`, so the byte-level assertions here pin the observable
// shape: bare `~` returns the homedir verbatim, leading-`~/` forms join
// through the platform separator, the backslash form the function already
// accepted still works, and non-tilde / non-string inputs pass through.
//
// The PATH-patcher's cases are platform-arg driven (BET-327): the helper
// reads `process.platform` nowhere inside, so the tests can assert each
// branch from a Linux CI runner.

import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandTilde,
  patchPath,
  DARWIN_PATH_PREFIX,
  stateHome,
  statePath,
  uploadRoot,
  outboxRoot,
  secretsRoot,
  STATE_DIRNAME,
  UPLOAD_DIRNAME,
  OUTBOX_DIRNAME,
  SECRETS_DIRNAME,
} from "./paths.mjs";

// ---------------------------------------------------------------------------
// stateHome / statePath — the test-isolation seam (see paths.mjs for the
// incident: an un-injected auth test wiped the live box's credentials on every
// `npm test`, because the store path was `$HOME`-derived with no way to
// redirect it).
// ---------------------------------------------------------------------------

describe("paths — state directory resolution", () => {
  const original = process.env.MANTA_STATE_HOME;

  afterEach(() => {
    if (original === undefined) delete process.env.MANTA_STATE_HOME;
    else process.env.MANTA_STATE_HOME = original;
  });

  it("falls back to the real homedir when MANTA_STATE_HOME is unset", () => {
    // PRODUCTION behaviour: a box must resolve its own $HOME, so that no stray
    // env var can silently orphan its identity.
    delete process.env.MANTA_STATE_HOME;
    expect(stateHome()).toBe(homedir());
    expect(statePath("auth.json")).toBe(join(homedir(), STATE_DIRNAME, "auth.json"));
    expect(uploadRoot()).toBe(join(homedir(), UPLOAD_DIRNAME));
    expect(outboxRoot()).toBe(join(homedir(), OUTBOX_DIRNAME));
    expect(secretsRoot()).toBe(join(homedir(), SECRETS_DIRNAME));
  });

  it("relocates every state dir together when MANTA_STATE_HOME is set", () => {
    process.env.MANTA_STATE_HOME = "/tmp/sandbox-home";
    expect(stateHome()).toBe("/tmp/sandbox-home");
    expect(statePath("secrets.json")).toBe(join("/tmp/sandbox-home", STATE_DIRNAME, "secrets.json"));
    expect(statePath()).toBe(join("/tmp/sandbox-home", STATE_DIRNAME));
    expect(uploadRoot()).toBe(join("/tmp/sandbox-home", UPLOAD_DIRNAME));
    expect(outboxRoot()).toBe(join("/tmp/sandbox-home", OUTBOX_DIRNAME));
    expect(secretsRoot()).toBe(join("/tmp/sandbox-home", SECRETS_DIRNAME));
  });

  it("ignores an empty or whitespace override rather than writing to /", () => {
    // A blank env var is far likelier to be a broken wrapper script than an
    // intentional "use the process root", and `join("", ".manta")` would
    // resolve relative to the CWD — a store nobody owns.
    process.env.MANTA_STATE_HOME = "";
    expect(stateHome()).toBe(homedir());
    process.env.MANTA_STATE_HOME = "   ";
    expect(stateHome()).toBe(homedir());
  });

  it("is sandboxed while the suite runs (canary)", () => {
    // This asserts the WIRING, not the function: vitest.config.ts injects
    // MANTA_STATE_HOME into every worker. If that wiring is removed, tests
    // silently start reading and writing the live box again — exactly the
    // condition that cost a box its identity. Fail loudly instead.
    expect(original, "MANTA_STATE_HOME must be set for the test run").toBeTruthy();
    expect(original).not.toBe(homedir());
  });
});

describe("paths — expandTilde", () => {
  it("expands a bare `~` to the user's homedir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("expands `~/foo/bar` against the user's homedir", () => {
    expect(expandTilde("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });

  it("expands `~\\foo` (backslash form) against the user's homedir", () => {
    // The function accepts the backslash form for parity with Windows
    // callers; on POSIX platforms path.join converts the forward slashes
    // back to `/`, so the result is still a POSIX-style absolute path.
    expect(expandTilde("~\\foo")).toBe(`${homedir()}/foo`);
  });

  it("passes a non-tilde path through unchanged", () => {
    // A bare relative path with no leading `~` must NOT be touched — only
    // the leading-tilde expansion is this function's job. Do NOT reach into
    // it for resolve()/absolute() behaviour.
    expect(expandTilde("relative/path")).toBe("relative/path");
    expect(expandTilde("/already/absolute")).toBe("/already/absolute");
  });

  it("passes a non-string input through unchanged", () => {
    // The function is called from user-input paths that may be `undefined`,
    // `null`, numbers, etc. when the field was missing. The contract is
    // "pass through whatever you got" — not "throw" — so the caller can
    // detect the missing-field case at its own layer.
    expect(expandTilde(undefined)).toBeUndefined();
    expect(expandTilde(null)).toBeNull();
    expect(expandTilde(42)).toBe(42);
    expect(expandTilde("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// patchPath — pure, the only PATH mutation shared between the desktop plugin
// runner and the box server's Claude credential refresh. Three platforms;
// the body reads no `process.platform` so each branch is unit-testable from
// a Linux CI runner.
// ---------------------------------------------------------------------------

describe("paths — patchPath (BET-327 / BET-339)", () => {
  it("exposes the macOS prefix as a constant in the order the helper prepends", () => {
    // The helper hardcodes the order (Homebrew first, /usr/local/bin
    // second); any reorder would break the existing macOS user. The
    // constant is the single source of truth for both consumers, so
    // pinning it here catches accidental edits in either consumer.
    expect(DARWIN_PATH_PREFIX).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("prepends the Homebrew paths on darwin and preserves the original tail", () => {
    const out = patchPath({ PATH: "/usr/bin:/bin", FOO: "bar" }, "darwin");
    expect(out.FOO).toBe("bar");
    // Exact prefix shape matters: Homebrew first, then /usr/local/bin,
    // then the caller's PATH tail. Don't accept any reordering.
    expect(out.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("uses the platform delimiter on darwin so the resulting PATH is well-formed everywhere", () => {
    // path.delimiter is ":" on POSIX and ";" on Windows — the helper must
    // use it, not hardcode ":", otherwise the resulting string would be
    // parseable only on POSIX. On the Linux CI runner we can only verify
    // the POSIX shape here; the Windows delimiter is exercised by the
    // typecheck (the function's body uses `delimiter`, not ":").
    const out = patchPath({ PATH: "" }, "darwin");
    // Both prefix entries must appear, in the canonical order, separated
    // by the platform delimiter. On Linux the delimiter is ":".
    expect(out.PATH ?? "").toBe("/opt/homebrew/bin:/usr/local/bin:");
  });

  it("returns the env byte-identical on linux and does not introduce a new PATH key", () => {
    // BET-339 acceptance: on linux, a caller-supplied PATH reaches the
    // spawn unchanged. The helper is a no-op off macOS — no extra prefix,
    // no shadow key. (Node surfaces PATH case-insensitively on Windows;
    // writing a `PATH` key next to an existing `Path` key produces an env
    // with both, which one the child sees is undefined. Same hazard on
    // Linux, lower stakes — but the helper's "do nothing" contract is the
    // same on every non-darwin platform.)
    const env = { PATH: "/usr/bin:/bin", FOO: "bar" };
    const out = patchPath(env, "linux");
    expect(out).toEqual(env);
    // And the input object must not be mutated.
    expect(env).toEqual({ PATH: "/usr/bin:/bin", FOO: "bar" });
  });

  it("does not invent an empty PATH key when baseEnv has no PATH on linux", () => {
    // BET-339 acceptance: on linux, an env without a PATH key must come
    // out without one. The old hand-rolled
    // `[..., process.env.PATH ?? ""].filter(Boolean).join(":")` in
    // src/server/opencode.mjs would have written "" as PATH — every
    // child would see PATH="" and ENOENT on any binary. patchPath must
    // not regress that.
    const out = patchPath({ FOO: "bar" }, "linux");
    expect(out.FOO).toBe("bar");
    expect(out.PATH).toBeUndefined();
  });

  it("returns the env byte-identical on win32 and does not introduce a new PATH key", () => {
    // Windows surfaces PATH as `Path` (case-insensitive); if patchPath
    // wrote a new `PATH` key next to an existing `Path` key the child
    // would see an env with BOTH and behaviour would be undefined. So
    // on win32 we touch NOTHING.
    const env = { Path: "C:\\Windows\\System32", FOO: "bar" } as unknown as NodeJS.ProcessEnv;
    const out = patchPath(env, "win32");
    expect(out).toEqual(env);
  });

  it("does not crash and does not invent an empty PATH key when baseEnv has no PATH off macOS", () => {
    const out = patchPath({ FOO: "bar" }, "linux");
    expect(out.FOO).toBe("bar");
    expect(out.PATH).toBeUndefined();
  });
});

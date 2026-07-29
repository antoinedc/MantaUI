// handlers.test.ts — IPC wiring tests for src/main/installer/handlers.ts.
//
// These tests verify that:
//   1. The mint-and-claim IPC handler funnels through the INJECTED
//      `persist` callback (the same one main's manual claim path uses).
//      This is the regression test for BET-372 — the production wiring
//      used to grab a non-exported `commit` via a circular require against
//      the main entry module, yielding `undefined` and throwing
//      `TypeError: commit is not a function` on every successful SSH claim.
//   2. The handlers.ts source file does NOT pull the main entry module
//      back into the installer module's require graph (a simple
//      source-level assertion that pins the circular require from
//      sneaking back in).
//
// No SSH connection, no network: the installer module is mocked at the
// boundary so the wiring — not the install — is what the tests exercise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PreflightResult } from "./preflight.js";

// --- electron mock ----------------------------------------------------------
//
// vi.mock factories are hoisted to the top of the file, so any variable
// the factory closes over has to be declared with `vi.hoisted()` — or the
// factory has to inline its state. We use a hoisted Map keyed by channel
// so individual tests can invoke the handler the way the renderer's IPC
// bridge would.

const ipcState = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, payload: unknown) => unknown>();
  const ipcMainHandle = vi.fn(
    (channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  );
  return { handlers, ipcMainHandle };
});

vi.mock("electron", () => ({
  ipcMain: { handle: ipcState.ipcMainHandle },
}));

// --- installer module mock --------------------------------------------------
//
// We don't want a real SSH connection; we want to assert that the handler
// forwards `alias` + `claimUrlOverride` and threads the INJECTED persist
// callback down to mintAndClaim unchanged.

const mintState = vi.hoisted(() => ({
  mintAndClaim: vi.fn(
    async (
      _alias: string,
      deps: {
        persist: (patch: unknown) => void;
        claimUrlOverride?: string;
      },
    ) => {
      // Simulate the post-claim persist that mintAndClaim performs on the
      // box's success path — exactly what src/main/installer/installer.ts:387
      // does after a successful /auth/claim response.
      deps.persist({
        serverUrl: "https://box.example",
        boxId: "0123456789abcdef0123456789abcdef",
        boxToken: "fedcba9876543210fedcba9876543210",
      });
      return {
        ok: true,
        boxId: "0123456789abcdef0123456789abcdef",
        boxToken: "fedcba9876543210fedcba9876543210",
      };
    },
  ),
}));

const installerState = vi.hoisted(() => ({
  preflightBox: vi.fn(async (): Promise<PreflightResult> => ({
    ok: true,
    ingressMode: "public-tls" as const,
    probes: {
      reachability: "ok" as const,
      os: { id: "linux" as const, arch: "x64" as const, release: "6.5.0" },
      passwordlessSudo: true,
      tailscale: { running: false, ipv4: null },
      clockSkewSeconds: 0,
      alreadyInstalled: false,
    },
    failures: [],
  })),
  runInstall: vi.fn(() => ({
    // Resolves immediately so the handler's fire-and-forget `.finally()`
    // clears the module's `activeHandle` before the next test runs —
    // otherwise every later `installerStart` call in this file sees a
    // still-active install and throws.
    done: Promise.resolve({ code: 0, signal: null }),
    cancel: vi.fn(),
  })),
}));

/** Flush the microtask queue so handlers.ts's fire-and-forget
 * `handle.done.then(...).finally(...)` chain (which resets module state)
 * has actually run before the next assertion/test. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock("./installer.js", () => ({
  mintAndClaim: mintState.mintAndClaim,
  listSshHosts: vi.fn(),
  preflightBox: installerState.preflightBox,
  runInstall: installerState.runInstall,
  DEFAULT_SSH_CONFIG_PATH: "/dev/null",
}));

// Also stub the small support module the handlers pull in but never call
// during the mint-and-claim path. handlers.ts only imports a type from
// stageMapper.js now (erased at compile time), so no mock needed for it.
vi.mock("./diagnostics.js", () => ({
  buildDiagnostics: vi.fn(),
}));

import { IPC, type AppConfig } from "../../shared/types.js";
import { registerInstallerHandlers } from "./handlers.js";

beforeEach(() => {
  ipcState.handlers.clear();
  ipcState.ipcMainHandle.mockClear();
  mintState.mintAndClaim.mockClear();
  installerState.preflightBox.mockClear();
  installerState.runInstall.mockClear();
});

describe("registerInstallerHandlers — mint-and-claim (BET-372)", () => {
  it("invokes the injected persist with the claimed credentials", async () => {
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});
    registerInstallerHandlers(() => null, persist);

    const handler = ipcState.handlers.get(IPC.installerMintAndClaim);
    expect(handler).toBeDefined();

    const out = await handler!(null, { alias: "dev" });
    expect(out).toEqual({
      ok: true,
      boxId: "0123456789abcdef0123456789abcdef",
      boxToken: "fedcba9876543210fedcba9876543210",
    });

    // mintAndClaim was called with the injected persist (not a wrapper that
    // re-requires main/index.js) and with the renderer-provided input.
    expect(mintState.mintAndClaim).toHaveBeenCalledTimes(1);
    const [aliasArg, deps] = mintState.mintAndClaim.mock.calls[0];
    expect(aliasArg).toBe("dev");
    expect(deps.persist).toBe(persist);
    expect(deps.claimUrlOverride).toBeUndefined();

    // And the persist callback actually fires with the claimed patch —
    // the exact regression BET-372 reported. Before the fix, the
    // handler's persist wrapper threw before reaching this assertion.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      serverUrl: "https://box.example",
      boxId: "0123456789abcdef0123456789abcdef",
      boxToken: "fedcba9876543210fedcba9876543210",
    });
  });

  it("forwards claimUrlOverride through to mintAndClaim", async () => {
    const persist = vi.fn((_patch: Partial<AppConfig>) => {});
    registerInstallerHandlers(() => null, persist);

    const handler = ipcState.handlers.get(IPC.installerMintAndClaim);
    await handler!(null, { alias: "dev", claimUrlOverride: "https://override.example" });

    const [, deps] = mintState.mintAndClaim.mock.calls[0];
    expect(deps.claimUrlOverride).toBe("https://override.example");
  });

  it("registers every installer IPC channel on the handler bus", () => {
    registerInstallerHandlers(() => null, vi.fn());
    const registeredChannels = ipcState.ipcMainHandle.mock.calls.map((c) => c[0]);
    expect(registeredChannels).toEqual(
      expect.arrayContaining([
        IPC.installerListHosts,
        IPC.installerState,
        IPC.installerStart,
        IPC.installerCancel,
        IPC.installerMintAndClaim,
        IPC.installerGetDiagnostics,
      ]),
    );
    // BET-383: there is exactly one entry point for starting an install —
    // the renderer never calls preflight directly, and the standalone
    // channel no longer exists at all (not merely unregistered).
    expect(IPC).not.toHaveProperty("installerPreflight");
  });
});

// Minimal fixture — only the fields classifyPreflight/the assertions below
// actually read, kept in one place so the two tests don't each hand-roll it.
function failedPreflightFixture(cause: string): PreflightResult {
  return {
    ok: false,
    ingressMode: "no-root",
    probes: {
      reachability: "unreachable",
      os: { id: "unknown", arch: "unknown", release: null },
      passwordlessSudo: false,
      tailscale: { running: false, ipv4: null },
      clockSkewSeconds: 0,
      alreadyInstalled: false,
    },
    failures: [{ cause, action: "Check the alias resolves." }],
  };
}

// BET-383: preflight folded into installerStart as phase 1, run in main.
describe("registerInstallerHandlers — installerStart preflight fold (BET-383)", () => {
  it("a passing preflight proceeds to runInstall and returns a handleId", async () => {
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const handler = ipcState.handlers.get(IPC.installerStart);

    const out = (await handler!(null, { alias: "dev" })) as { handleId: string };
    expect(installerState.preflightBox).toHaveBeenCalledWith("dev");
    expect(installerState.runInstall).toHaveBeenCalledTimes(1);
    expect(out.handleId).toMatch(/^install-/);
    const kinds = win.webContents.send.mock.calls.map((c) => (c[1] as { kind: string }).kind);
    expect(kinds).not.toContain("preflight-failed");
    // Let the mocked `done` promise resolve so activeHandle clears before
    // the next test starts a new install.
    await flushMicrotasks();
  });

  it("a failing preflight never calls runInstall, emits preflight-failed, and installerState echoes the real verdict", async () => {
    installerState.preflightBox.mockResolvedValueOnce(
      failedPreflightFixture("Could not connect to the host over SSH."),
    );
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const stateHandler = ipcState.handlers.get(IPC.installerState);

    await startHandler!(null, { alias: "dev" });

    expect(installerState.runInstall).not.toHaveBeenCalled();
    const [, payload] = win.webContents.send.mock.calls[0] as [string, {
      kind: string;
      failures: Array<{ cause: string }>;
    }];
    expect(payload.kind).toBe("preflight-failed");
    expect(payload.failures[0].cause).toMatch(/Could not connect/);

    // No placeholder — the real verdict comes back from installerState too.
    const state = (await stateHandler!(null, undefined)) as {
      preflight: PreflightResult | null;
    };
    expect(state.preflight?.ok).toBe(false);
    expect(state.preflight?.failures[0].cause).toMatch(/Could not connect/);
  });
});

// Source-level guard: the handlers.ts file MUST NOT pull main's index.js
// back into the installer module's require graph. This catches a future
// regression where someone re-adds a circular require to grab `commit`
// — the same trap BET-372 fixed. A source-level assertion is intentionally
// cheap and survives refactors that keep the function names but rewrite
// the wiring.
describe("handlers.ts — no circular require of main/index", () => {
  const handlersPath = fileURLToPath(new URL("./handlers.ts", import.meta.url));
  const source = readFileSync(handlersPath, "utf8");

  it("does not require ../index.js", () => {
    // Match either CommonJS require(...) of ../index or an ES import from
    // "../index.js" (the issue's root cause was the former, but the assertion
    // covers both — same trap).
    expect(source).not.toMatch(/require\(["']\.\.\/index(\.js)?["']\)/);
    expect(source).not.toMatch(/from\s+["']\.\.\/index(\.js)?["']/);
  });

  it("does not reference commit at all (it must be injected, not imported)", () => {
    // The whole point of BET-372's fix: `commit` lives in main, and
    // handlers.ts receives it as a parameter. Any executable reference to
    // `commit` inside this file means someone snuck a binding back in.
    // Comments may discuss the symbol (to explain the fix); only code
    // matters, so strip block + line comments first.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bcommit\b/);
  });

  it("takes persist as a parameter on registerInstallerHandlers", () => {
    // Spot-check the function signature so a future refactor that drops
    // the second argument fails this test instead of silently falling back
    // to a require(). The signature is multi-line, so strip newlines + runs
    // of whitespace before applying the regex. We anchor on the function
    // name + persist + its callback type, in that order, with anything
    // (including a getWindow arg) allowed between the opening `(` and the
    // persist parameter — getWindow's `() => BrowserWindow | null` contains
    // its own parens which a strict `[^)]*` would not cross.
    const code = source.replace(/\s+/g, " ");
    expect(code).toMatch(
      /function\s+registerInstallerHandlers\s*\([\s\S]*persist\s*:\s*\(patch\s*:\s*Partial<AppConfig>\)\s*=>\s*void/,
    );
  });
});

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
        askpassEnv?: Record<string, string>;
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
  preflightBox: vi.fn(async (
    _alias?: unknown,
    _deps?: unknown,
  ): Promise<PreflightResult> => ({
    ok: true,
    ingressMode: "public-tls" as const,
    probes: {
      reachability: "ok" as const,
      hostFingerprint: null,
      os: { id: "linux" as const, arch: "x64" as const, release: "6.5.0" },
      sudoAccess: "nopasswd",
      tailscale: { running: false, ipv4: null },
      clockSkewSeconds: 0,
      alreadyInstalled: false,
      windowsAgent: "not-windows" as const,
      keyFormat: "not-windows" as const,
    },
    failures: [],
    unknownHost: null,
  })),
  runInstall: vi.fn((
    _alias?: unknown,
    _sink?: unknown,
    _deps?: unknown,
  ) => ({
    // Resolves immediately so the handler's fire-and-forget `.finally()`
    // clears the module's `activeHandle` before the next test runs —
    // otherwise every later `installerStart` call in this file sees a
    // still-active install and throws.
    done: Promise.resolve({ code: 0, signal: null }),
    cancel: vi.fn(),
  })),
}));

// BET-361: trustHost writes the host key to known_hosts. Stubbed here so
// the handler test never touches ssh-keyscan or the filesystem.
const knownHostsState = vi.hoisted(() => ({
  trustHost: vi.fn(async () => ({ ok: true as const, line: "box ssh-ed25519 AAAA" })),
}));

// BET-360: createAskpassSession creates a temp dir + helper script. Stubbed
// so the handler test never touches the filesystem; cleanup is a spy so we
// can assert it fires on the right paths.
const askpassState = vi.hoisted(() => ({
  createAskpassSession: vi.fn((_passphrase: string) => ({
    env: {
      SSH_ASKPASS: "/tmp/fake-askpass.sh",
      SSH_ASKPASS_REQUIRE: "force",
      MANTA_ASKPASS_FILE: "/tmp/fake-passphrase",
    },
    cleanup: vi.fn(),
  })),
}));

// BET-979: sudo-password staging (writeSudoPass / clearSudoPass) — stubbed
// so the handler test never opens an ssh call. Spies assert the write fires
// on the sudo-password prompt path and the clear fires on every terminal path.
const sudoPassState = vi.hoisted(() => ({
  writeSudoPass: vi.fn(async () => true),
  clearSudoPass: vi.fn(async () => {}),
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

vi.mock("./knownHosts.js", () => ({
  trustHost: knownHostsState.trustHost,
}));

vi.mock("./askpass.js", () => ({
  createAskpassSession: askpassState.createAskpassSession,
}));

vi.mock("./sudoPass.js", () => ({
  writeSudoPass: sudoPassState.writeSudoPass,
  clearSudoPass: sudoPassState.clearSudoPass,
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
  knownHostsState.trustHost.mockClear();
  askpassState.createAskpassSession.mockClear();
  sudoPassState.writeSudoPass.mockClear();
  sudoPassState.clearSudoPass.mockClear();
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
        IPC.installerTrustHost,
        IPC.installerAskpassRespond,
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
      hostFingerprint: null,
      os: { id: "unknown", arch: "unknown", release: null },
      sudoAccess: "none",
      tailscale: { running: false, ipv4: null },
      clockSkewSeconds: 0,
      alreadyInstalled: false,
      windowsAgent: "not-windows",
      keyFormat: "not-windows",
    },
    failures: [{ cause, action: "Check the alias resolves." }],
    unknownHost: null,
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

// BET-705 b: installerState exposes the active handle id (so a remount can
// restore Cancel) and the stored install target (so the auto-claim resolves
// against the host that was actually installed, never the picker's current
// selection).
describe("registerInstallerHandlers — activeHandleId + target (BET-705 b)", () => {
  it("installerState reports the active handle id and the stored target after a start", async () => {
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const stateHandler = ipcState.handlers.get(IPC.installerState);

    await startHandler!(null, { alias: "prod.example.com" });
    const state = (await stateHandler!(null, undefined)) as {
      active: boolean;
      activeHandleId: string | null;
      target: unknown;
    };
    expect(state.active).toBe(true);
    expect(state.activeHandleId).toMatch(/^install-/);
    expect(state.target).toBe("prod.example.com");
    await flushMicrotasks();
  });

  it("installerMintAndClaim prefers the stored install target over the renderer's alias", async () => {
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const claimHandler = ipcState.handlers.get(IPC.installerMintAndClaim);

    // Install ran against origin.example.com, then finished (clears the
    // active handle but NOT the stored target — the claim comes after done).
    await startHandler!(null, { alias: "origin.example.com" });
    await flushMicrotasks();

    // The renderer (post-remount host-picker reset) passes a stale alias —
    // main must still claim against the stored target.
    await claimHandler!(null, { alias: "wrong.example.com" });
    const [targetArg] = mintState.mintAndClaim.mock.calls[0];
    expect(targetArg).toBe("origin.example.com");
    await flushMicrotasks();
  });
});

// BET-361: a never-seen host pauses the install for a trust decision.
// The handler must (a) emit a `fingerprint` event, (b) hold the slot while
// waiting, (c) resume into runInstall after a Trust answer + successful
// trustHost, and (d) abort with preflight-failed on a decline.
describe("registerInstallerHandlers — fingerprint pause/resume (BET-361)", () => {
  function unknownHostPreflight(): PreflightResult {
    return {
      ok: false,
      ingressMode: "no-root",
      probes: {
        reachability: "unknown-host",
        hostFingerprint: {
          algo: "ED25519",
          sha256: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
        },
        os: { id: "unknown", arch: "unknown", release: null },
        sudoAccess: "none",
        tailscale: { running: false, ipv4: null },
        clockSkewSeconds: 0,
        alreadyInstalled: false,
        windowsAgent: "not-windows",
        keyFormat: "not-windows",
      },
      failures: [
        {
          cause: "This host's identity is not yet trusted.",
          action: "Review the host key fingerprint and choose Trust to continue, or pick a different host.",
        },
      ],
      unknownHost: {
        algo: "ED25519",
        sha256: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=",
      },
    };
  }

  it("emits a fingerprint event, then resumes into runInstall after Trust", async () => {
    installerState.preflightBox
      .mockResolvedValueOnce(unknownHostPreflight())
      .mockResolvedValueOnce({
        // Second preflight (after trust) — the host key is now known.
        ok: true,
        ingressMode: "public-tls",
        probes: {
          reachability: "ok",
          hostFingerprint: null,
          os: { id: "linux", arch: "x64", release: "6.5.0" },
          sudoAccess: "nopasswd",
          tailscale: { running: false, ipv4: null },
          clockSkewSeconds: 0,
          alreadyInstalled: false,
          windowsAgent: "not-windows",
          keyFormat: "not-windows",
        },
        failures: [],
        unknownHost: null,
      });
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const trustHandler = ipcState.handlers.get(IPC.installerTrustHost);
    const stateHandler = ipcState.handlers.get(IPC.installerState);

    // installerStart does not resolve until the trust loop finishes — drive
    // it without awaiting so we can answer the prompt mid-flight.
    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;

    // Let the preflight + fingerprint event land.
    await flushMicrotasks();
    await flushMicrotasks();

    // While paused, installerState reports the trust wait.
    const paused = (await stateHandler!(null, undefined)) as {
      waitingForTrust: boolean;
      trustHandleId: string | null;
      pendingFingerprint: { algo: string; sha256: string } | null;
    };
    expect(paused.waitingForTrust).toBe(true);
    expect(paused.trustHandleId).toMatch(/^install-/);
    expect(paused.pendingFingerprint?.algo).toBe("ED25519");

    // A fingerprint event was pushed to the renderer.
    const fpEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "fingerprint",
    ) as [string, { kind: string; handleId: string; fingerprint: { algo: string } }];
    expect(fpEvent).toBeDefined();
    expect(fpEvent[1].fingerprint.algo).toBe("ED25519");
    const handleId = fpEvent[1].handleId;

    // runInstall has NOT started yet — the install is paused.
    expect(installerState.runInstall).not.toHaveBeenCalled();

    // User clicks Trust.
    await trustHandler!(null, { handleId, trust: true });
    await startP;

    // trustHost wrote the host key, preflight re-ran, and the install started.
    expect(knownHostsState.trustHost).toHaveBeenCalledTimes(1);
    expect(installerState.preflightBox).toHaveBeenCalledTimes(2);
    expect(installerState.runInstall).toHaveBeenCalledTimes(1);

    // The trust wait is cleared.
    const after = (await stateHandler!(null, undefined)) as { waitingForTrust: boolean };
    expect(after.waitingForTrust).toBe(false);

    await flushMicrotasks();
  });

  it("aborts with preflight-failed on a decline (Trust=false), never starts the install", async () => {
    installerState.preflightBox.mockResolvedValueOnce(unknownHostPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const trustHandler = ipcState.handlers.get(IPC.installerTrustHost);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    const fpEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "fingerprint",
    ) as [string, { handleId: string }];
    await trustHandler!(null, { handleId: fpEvent[1].handleId, trust: false });
    await startP;

    expect(knownHostsState.trustHost).not.toHaveBeenCalled();
    expect(installerState.runInstall).not.toHaveBeenCalled();
    const failed = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "preflight-failed",
    ) as [string, { kind: string; failures: { cause: string }[] }];
    expect(failed).toBeDefined();
    expect(failed[1].failures[0].cause).toMatch(/not yet trusted/);
  });

  it("refuses a second install while a trust prompt is paused", async () => {
    installerState.preflightBox.mockResolvedValueOnce(unknownHostPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const trustHandler = ipcState.handlers.get(IPC.installerTrustHost);

    // Start the first install and let it pause.
    void startHandler!(null, { alias: "dev" });
    await flushMicrotasks();
    await flushMicrotasks();

    // A second start while paused must throw (single-active slot held).
    await expect(
      startHandler!(null, { alias: "dev2" }),
    ).rejects.toThrow(/already in progress/);

    // Clean up: answer the paused prompt so the slot is released.
    const fpEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "fingerprint",
    ) as [string, { handleId: string }];
    await trustHandler!(null, { handleId: fpEvent[1].handleId, trust: false });
    await flushMicrotasks();
  });

  it("installerCancel during the trust pause aborts the wait", async () => {
    installerState.preflightBox.mockResolvedValueOnce(unknownHostPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const cancelHandler = ipcState.handlers.get(IPC.installerCancel);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();
    const fpEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "fingerprint",
    ) as [string, { handleId: string }];

    await cancelHandler!(null, { handleId: fpEvent[1].handleId });
    await startP;

    expect(installerState.runInstall).not.toHaveBeenCalled();
    expect(knownHostsState.trustHost).not.toHaveBeenCalled();
    const failed = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "preflight-failed",
    );
    expect(failed).toBeDefined();
  });
});

// BET-360: a passphrase-protected key (not in ssh-agent) pauses the install
// for a passphrase, then re-runs preflight + install with SSH_ASKPASS.
describe("registerInstallerHandlers — passphrase pause/resume (BET-360)", () => {
  function authFailedPreflight(): PreflightResult {
    return {
      ok: false,
      ingressMode: "no-root",
      probes: {
        reachability: "auth-failed",
        hostFingerprint: null,
        os: { id: "unknown", arch: "unknown", release: null },
        sudoAccess: "none",
        tailscale: { running: false, ipv4: null },
        clockSkewSeconds: 0,
        alreadyInstalled: false,
        windowsAgent: "not-windows",
        keyFormat: "not-windows",
      },
      failures: [
        {
          cause: "SSH key authentication was rejected.",
          action:
            "Make sure your key is loaded (ssh-add) and listed in the server's ~/.ssh/authorized_keys.",
        },
      ],
      unknownHost: null,
    };
  }

  function okPreflight(): PreflightResult {
    return {
      ok: true,
      ingressMode: "public-tls",
      probes: {
        reachability: "ok",
        hostFingerprint: null,
        os: { id: "linux", arch: "x64", release: "6.5.0" },
        sudoAccess: "nopasswd",
        tailscale: { running: false, ipv4: null },
        clockSkewSeconds: 0,
        alreadyInstalled: false,
        windowsAgent: "not-windows",
        keyFormat: "not-windows",
      },
      failures: [],
      unknownHost: null,
    };
  }

  it("emits a passphrase event, creates an askpass session, re-runs preflight, and starts the install with askpassEnv", async () => {
    installerState.preflightBox
      .mockResolvedValueOnce(authFailedPreflight())
      .mockResolvedValueOnce(okPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);
    const stateHandler = ipcState.handlers.get(IPC.installerState);

    // installerStart does not resolve until the askpass loop finishes — drive
    // it without awaiting so we can answer the prompt mid-flight.
    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    // While paused, installerState reports the secret wait + its kind.
    const paused = (await stateHandler!(null, undefined)) as {
      waitingForSecret: boolean;
      secretHandleId: string | null;
      secretKind: string | null;
    };
    expect(paused.waitingForSecret).toBe(true);
    expect(paused.secretKind).toBe("passphrase");
    expect(paused.secretHandleId).toMatch(/^install-/);

    // A passphrase event was pushed to the renderer.
    const pwEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string; secretKind?: string }).kind === "secret" && (c[1] as { kind: string; secretKind?: string }).secretKind === "passphrase",
    ) as [string, { kind: string; handleId: string; prompt: string }];
    expect(pwEvent).toBeDefined();
    expect(pwEvent[1].prompt).toMatch(/passphrase/i);
    const handleId = pwEvent[1].handleId;

    // runInstall has NOT started yet — the install is paused.
    expect(installerState.runInstall).not.toHaveBeenCalled();

    // User enters a passphrase and submits.
    await respondHandler!(null, { handleId, secret: "hunter2" });
    await startP;

    // An askpass session was created with the user's passphrase.
    expect(askpassState.createAskpassSession).toHaveBeenCalledTimes(1);
    expect(askpassState.createAskpassSession).toHaveBeenCalledWith("hunter2");

    // Preflight was called twice: once with no askpass, once with askpassEnv.
    expect(installerState.preflightBox).toHaveBeenCalledTimes(2);
    const [, secondCallArgs] = installerState.preflightBox.mock.calls[1];
    expect(secondCallArgs).toEqual({ askpassEnv: expect.objectContaining({ SSH_ASKPASS_REQUIRE: "force" }) });

    // runInstall was called with askpassEnv.
    expect(installerState.runInstall).toHaveBeenCalledTimes(1);
    const [, , installDeps] = installerState.runInstall.mock.calls[0];
    expect(installDeps).toEqual({ askpassEnv: expect.objectContaining({ SSH_ASKPASS_REQUIRE: "force" }) });

    // The passphrase wait is cleared.
    const after = (await stateHandler!(null, undefined)) as { waitingForSecret: boolean };
    expect(after.waitingForSecret).toBe(false);

    await flushMicrotasks();
  });

  it("aborts with preflight-failed on a cancel (passphrase=null), never creates a session or starts the install", async () => {
    installerState.preflightBox.mockResolvedValueOnce(authFailedPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    const pwEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string; secretKind?: string }).kind === "secret" && (c[1] as { kind: string; secretKind?: string }).secretKind === "passphrase",
    ) as [string, { kind: string; handleId: string }];
    await respondHandler!(null, { handleId: pwEvent[1].handleId, secret: null });
    await startP;

    expect(askpassState.createAskpassSession).not.toHaveBeenCalled();
    expect(installerState.runInstall).not.toHaveBeenCalled();
    const failed = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "preflight-failed",
    ) as [string, { kind: string; failures: { cause: string }[] }];
    expect(failed).toBeDefined();
    expect(failed[1].failures[0].cause).toMatch(/authentication was rejected/);
  });

  it("cleans up the askpass session when the second preflight still fails (wrong passphrase)", async () => {
    installerState.preflightBox
      .mockResolvedValueOnce(authFailedPreflight())
      .mockResolvedValueOnce(authFailedPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    const pwEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string; secretKind?: string }).kind === "secret" && (c[1] as { kind: string; secretKind?: string }).secretKind === "passphrase",
    ) as [string, { kind: string; handleId: string }];
    await respondHandler!(null, { handleId: pwEvent[1].handleId, secret: "wrong" });
    await startP;

    // Session was created but then cleaned up (preflight still failed).
    expect(askpassState.createAskpassSession).toHaveBeenCalledTimes(1);
    const session = askpassState.createAskpassSession.mock.results[0].value;
    expect(session.cleanup).toHaveBeenCalledTimes(1);
    expect(installerState.runInstall).not.toHaveBeenCalled();
  });

  it("installerCancel during the passphrase pause aborts the wait", async () => {
    installerState.preflightBox.mockResolvedValueOnce(authFailedPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const cancelHandler = ipcState.handlers.get(IPC.installerCancel);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();
    const pwEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string; secretKind?: string }).kind === "secret" && (c[1] as { kind: string; secretKind?: string }).secretKind === "passphrase",
    ) as [string, { kind: string; handleId: string }];

    await cancelHandler!(null, { handleId: pwEvent[1].handleId });
    await startP;

    expect(askpassState.createAskpassSession).not.toHaveBeenCalled();
    expect(installerState.runInstall).not.toHaveBeenCalled();
    const failed = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "preflight-failed",
    );
    expect(failed).toBeDefined();
  });

  it("refuses a second install while a passphrase prompt is paused", async () => {
    installerState.preflightBox.mockResolvedValueOnce(authFailedPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);

    void startHandler!(null, { alias: "dev" });
    await flushMicrotasks();
    await flushMicrotasks();

    await expect(
      startHandler!(null, { alias: "dev2" }),
    ).rejects.toThrow(/already in progress/);

    // Clean up: answer the paused prompt.
    const pwEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string; secretKind?: string }).kind === "secret" && (c[1] as { kind: string; secretKind?: string }).secretKind === "passphrase",
    ) as [string, { kind: string; handleId: string }];
    await respondHandler!(null, { handleId: pwEvent[1].handleId, secret: null });
    await flushMicrotasks();
  });

  it("installerMintAndClaim passes askpassEnv and cleans up on success", async () => {
    // Simulate a completed install with an active askpass session by running
    // the full flow up to the install start, then calling mintAndClaim.
    installerState.preflightBox
      .mockResolvedValueOnce(authFailedPreflight())
      .mockResolvedValueOnce(okPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);
    const claimHandler = ipcState.handlers.get(IPC.installerMintAndClaim);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();
    const pwEvent = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string; secretKind?: string }).kind === "secret" && (c[1] as { kind: string; secretKind?: string }).secretKind === "passphrase",
    ) as [string, { kind: string; handleId: string }];
    await respondHandler!(null, { handleId: pwEvent[1].handleId, secret: "hunter2" });
    await startP;

    // The askpass session is active.
    const session = askpassState.createAskpassSession.mock.results[0].value;
    expect(session.cleanup).not.toHaveBeenCalled();

    // Claim succeeds → mintAndClaim receives askpassEnv, session is cleaned up.
    await claimHandler!(null, { alias: "dev" });
    const [, claimDeps] = mintState.mintAndClaim.mock.calls[0];
    expect(claimDeps.askpassEnv).toEqual(
      expect.objectContaining({ SSH_ASKPASS_REQUIRE: "force" }),
    );
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
  });
});

// BET-979: a box with password-sudo (sudoAccess === "password") pauses the
// install BEFORE runInstall for the password, stages it via a SEPARATE ssh
// call (writeSudoPass), then starts the install. Declining (Cancel) must
// report a preflight-failed and NEVER start the install — there is no
// Skip/degraded path (the same all-or-nothing rule BET-980 establishes, one
// layer up). The staged password is cleared on every terminal path.
describe("registerInstallerHandlers — sudo-password pause/resume (BET-979)", () => {
  function passwordSudoPreflight(): PreflightResult {
    return {
      ok: true,
      ingressMode: "public-tls",
      probes: {
        reachability: "ok",
        hostFingerprint: null,
        os: { id: "linux", arch: "x64", release: "6.5.0" },
        sudoAccess: "password",
        tailscale: { running: false, ipv4: null },
        clockSkewSeconds: 0,
        alreadyInstalled: false,
        windowsAgent: "not-windows",
        keyFormat: "not-windows",
      },
      failures: [],
      unknownHost: null,
    };
  }

  function findSudoEvent(win: { webContents: { send: ReturnType<typeof vi.fn> } }) {
    return win.webContents.send.mock.calls.find(
      (c) =>
        (c[1] as { kind: string; secretKind?: string }).kind === "secret" &&
        (c[1] as { kind: string; secretKind?: string }).secretKind === "sudo-password",
    ) as [string, { kind: string; handleId: string; secretKind: string; prompt: string }] | undefined;
  }

  it("emits a sudo-password secret event, stages the password, and starts the install", async () => {
    installerState.preflightBox.mockResolvedValue(passwordSudoPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);
    const stateHandler = ipcState.handlers.get(IPC.installerState);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    // While paused, installerState reports the sudo-password kind.
    const paused = (await stateHandler!(null, undefined)) as {
      waitingForSecret: boolean;
      secretKind: string | null;
      secretHandleId: string | null;
    };
    expect(paused.waitingForSecret).toBe(true);
    expect(paused.secretKind).toBe("sudo-password");
    expect(paused.secretHandleId).toMatch(/^install-/);

    // A sudo-password secret event was pushed; the install is still paused.
    const pwEvent = findSudoEvent(win);
    expect(pwEvent).toBeDefined();
    expect(installerState.runInstall).not.toHaveBeenCalled();

    // User enters the password and continues.
    await respondHandler!(null, { handleId: pwEvent![1].handleId, secret: "pw123" });
    await startP;

    // The password was staged via writeSudoPass (NOT through the install
    // stream), then the install started.
    expect(sudoPassState.writeSudoPass).toHaveBeenCalledTimes(1);
    expect(sudoPassState.writeSudoPass).toHaveBeenCalledWith("dev", "pw123");
    expect(installerState.runInstall).toHaveBeenCalledTimes(1);

    // On install success the staged password is cleared (done.then).
    await flushMicrotasks();
    expect(sudoPassState.clearSudoPass).toHaveBeenCalled();
  });

  it("declining (secret null) reports preflight-failed and NEVER starts the install or stages the password", async () => {
    installerState.preflightBox.mockResolvedValue(passwordSudoPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    const pwEvent = findSudoEvent(win);
    await respondHandler!(null, { handleId: pwEvent![1].handleId, secret: null });
    await startP;

    expect(installerState.runInstall).not.toHaveBeenCalled();
    expect(sudoPassState.writeSudoPass).not.toHaveBeenCalled();
    const failed = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "preflight-failed",
    ) as [string, { kind: string; failures: { cause: string }[] }];
    expect(failed).toBeDefined();
    expect(failed[1].failures[0].cause).toMatch(/needs a password to run commands as root/);
    // The decline path still clears (idempotent — nothing was actually staged).
    await flushMicrotasks();
    expect(sudoPassState.clearSudoPass).toHaveBeenCalled();
  });

  it("installerCancel during the sudo-password pause aborts the wait without starting the install", async () => {
    installerState.preflightBox.mockResolvedValue(passwordSudoPreflight());
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const cancelHandler = ipcState.handlers.get(IPC.installerCancel);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();

    const pwEvent = findSudoEvent(win);
    await cancelHandler!(null, { handleId: pwEvent![1].handleId });
    await startP;

    expect(installerState.runInstall).not.toHaveBeenCalled();
    expect(sudoPassState.writeSudoPass).not.toHaveBeenCalled();
    const failed = win.webContents.send.mock.calls.find(
      (c) => (c[1] as { kind: string }).kind === "preflight-failed",
    );
    expect(failed).toBeDefined();
    await flushMicrotasks();
  });

  it("clears the staged sudo password when the install fails", async () => {
    installerState.preflightBox.mockResolvedValue(passwordSudoPreflight());
    installerState.runInstall.mockImplementationOnce(() => ({
      done: Promise.resolve({ code: 1, signal: null }),
      cancel: vi.fn(),
    }));
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    registerInstallerHandlers(() => win as never, vi.fn());
    const startHandler = ipcState.handlers.get(IPC.installerStart);
    const respondHandler = ipcState.handlers.get(IPC.installerAskpassRespond);

    const startP = startHandler!(null, { alias: "dev" }) as Promise<{ handleId: string }>;
    await flushMicrotasks();
    await flushMicrotasks();
    const pwEvent = findSudoEvent(win);
    await respondHandler!(null, { handleId: pwEvent![1].handleId, secret: "pw" });
    await startP;
    expect(installerState.runInstall).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    expect(sudoPassState.clearSudoPass).toHaveBeenCalled();
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

import { describe, it, expect, vi } from "vitest";
import {
  WELCOME_PROJECT_NAME,
  WELCOME_PROJECT_CWD,
  firstChatSessionId,
  ensureWelcomeProject,
  verifyBoxAnswers,
  finalizeOnboarding,
  hasConnectedProvider,
  type VerifyApi,
  type VerifyStore,
} from "./onboardingVerify";

function makeApi(over: Partial<VerifyApi> = {}): VerifyApi {
  return {
    tmuxNewSession: vi.fn(async () => ({ ok: true as const, sessionName: "welcome" })),
    opencodeProviderAuth: vi.fn(async () => ({ action: "status", providers: [] })),
    opencodePrompt: vi.fn(async () => ({ ok: true })),
    opencodeMessages: vi.fn(async () => []),
    ...over,
  };
}

function makeStore(over: Partial<VerifyStore> = {}): VerifyStore {
  // Default projects + refresh hook that simulates the post-create store
  // re-sync: once refresh() runs, the projects list carries the new
  // welcome project + chat window. Tests that don't simulate the create
  // can pre-populate `projects` and skip refresh().
  let projects: VerifyStore["projects"] = over.projects ?? [];
  const refresh = over.refresh ?? vi.fn(async () => {
    // Simulate the real store after tmuxNewSession("welcome", chatMode:true):
    // a new "welcome" project with one chat-mode window appears. The
    // append (not replace) covers both the fresh-box case (empty → adds
    // welcome) and the "projects exist but no chat window" case (existing
    // list → adds welcome alongside).
    if (!projects.some((p) => p.tmuxSession === "welcome")) {
      projects = [
        ...projects,
        {
          tmuxSession: "welcome",
          windows: [{ opencodeSessionId: "sid-welcome" }],
        },
      ];
    }
  });
  const setActive = over.setActive ?? vi.fn(() => undefined);
  return {
    get projects() {
      return projects;
    },
    refresh,
    setActive,
  };
}

describe("firstChatSessionId", () => {
  it("returns null for an empty project list", () => {
    expect(firstChatSessionId([])).toBeNull();
  });

  it("returns the first chat-mode session id in declaration order", () => {
    const projects = [
      {
        tmuxSession: "a",
        windows: [{ opencodeSessionId: null }, { opencodeSessionId: "sid-1" }],
      },
      {
        tmuxSession: "b",
        windows: [{ opencodeSessionId: "sid-2" }],
      },
    ];
    expect(firstChatSessionId(projects)).toBe("sid-1");
  });

  it("skips projects that have only terminal-mode windows", () => {
    const projects = [
      { tmuxSession: "a", windows: [{ opencodeSessionId: null }] },
      { tmuxSession: "b", windows: [{ opencodeSessionId: "sid-x" }] },
    ];
    expect(firstChatSessionId(projects)).toBe("sid-x");
  });
});

describe("ensureWelcomeProject", () => {
  it("creates a welcome project when none exists", async () => {
    const api = makeApi();
    const store = makeStore({ projects: [] });
    await ensureWelcomeProject({ api, store });
    expect(api.tmuxNewSession).toHaveBeenCalledWith({
      name: WELCOME_PROJECT_NAME,
      cwd: WELCOME_PROJECT_CWD,
      windowName: "default",
      chatMode: true,
      createDir: true,
    });
    expect(store.refresh).toHaveBeenCalledTimes(1);
    expect(store.setActive).toHaveBeenCalledWith("welcome");
  });

  it("skips creation when a project with a chat session already exists", async () => {
    const api = makeApi();
    const store = makeStore({
      projects: [
        {
          tmuxSession: "preexisting",
          windows: [{ opencodeSessionId: "sid-pre" }],
        },
      ],
    });
    await ensureWelcomeProject({ api, store });
    expect(api.tmuxNewSession).not.toHaveBeenCalled();
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it("creates a project when projects exist but none has a chat window", async () => {
    const api = makeApi();
    const store = makeStore({
      projects: [
        { tmuxSession: "preexisting", windows: [{ opencodeSessionId: null }] },
      ],
    });
    await ensureWelcomeProject({ api, store });
    expect(api.tmuxNewSession).toHaveBeenCalledTimes(1);
  });

  it("throws when the box rejects the create request", async () => {
    const api = makeApi({
      tmuxNewSession: vi.fn(async () => ({ ok: false as const, error: "permission denied" })),
    });
    const store = makeStore({ projects: [] });
    await expect(ensureWelcomeProject({ api, store })).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("verifyBoxAnswers", () => {
  it("returns ok when a new assistant message with time.completed appears", async () => {
    let pollCount = 0;
    const api = makeApi({
      opencodeMessages: vi.fn(async () => {
        pollCount += 1;
        // First poll: just the user message. Second poll: assistant message with completion.
        if (pollCount < 2) return [{ info: { id: "u-1", role: "user" } }];
        return [
          { info: { id: "u-1", role: "user" } },
          { info: { id: "a-1", role: "assistant", time: { completed: 1700000000000 } } },
        ];
      }),
    });
    const outcome = await verifyBoxAnswers({
      api,
      sessionId: "s-1",
      // Use real Date.now() (no injected clock) so the loop's deadline math
      // actually advances; the second-poll success returns well within the
      // default 15s budget.
      pollIntervalMs: 5,
    });
    expect(outcome).toEqual({ ok: true });
    expect(api.opencodePrompt).toHaveBeenCalledWith("s-1", "hi");
  });

  it("does not pass on an assistant message that existed BEFORE the prompt", async () => {
    // The transcript already contains a completed assistant message; the
    // baseline filter must keep this from being a false positive. The poll
    // keeps returning the same list (no NEW assistant message), so the
    // helper times out within the small budget.
    const api = makeApi({
      opencodeMessages: vi.fn(async () => [
        { info: { id: "a-existing", role: "assistant", time: { completed: 1699999000000 } } },
      ]),
    });
    const outcome = await verifyBoxAnswers({
      api,
      sessionId: "s-1",
      pollIntervalMs: 5,
      timeoutMs: 50,
    });
    expect(outcome.ok).toBe(false);
  });

  it("returns a failure message when the prompt send is rejected", async () => {
    const api = makeApi({
      opencodePrompt: vi.fn(async () => ({ ok: false, error: "no_provider" })),
    });
    const outcome = await verifyBoxAnswers({
      api,
      sessionId: "s-1",
      pollIntervalMs: 5,
      timeoutMs: 100,
    });
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok === false) {
      expect(outcome.message).toMatch(/no_provider/);
    }
  });

  it("does not pass on a NEW assistant message without time.completed", async () => {
    let pollCount = 0;
    const api = makeApi({
      opencodeMessages: vi.fn(async () => {
        pollCount += 1;
        if (pollCount < 2) return [];
        // New assistant message but no completion stamp — turn is still in flight.
        return [
          { info: { id: "u-1", role: "user" } },
          { info: { id: "a-1", role: "assistant", time: {} } },
        ];
      }),
    });
    const outcome = await verifyBoxAnswers({
      api,
      sessionId: "s-1",
      pollIntervalMs: 5,
      timeoutMs: 50,
    });
    expect(outcome.ok).toBe(false);
  });

  it("times out when no assistant response arrives within the budget", async () => {
    const api = makeApi({
      opencodeMessages: vi.fn(async () => []),
    });
    const outcome = await verifyBoxAnswers({
      api,
      sessionId: "s-1",
      pollIntervalMs: 5,
      timeoutMs: 25,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.message).toMatch(/didn't answer the test prompt/);
    }
  });

  it("ignores transient fetch failures (keeps polling)", async () => {
    let pollCount = 0;
    const api = makeApi({
      opencodeMessages: vi.fn(async () => {
        pollCount += 1;
        if (pollCount === 1) throw new Error("network blip");
        return [
          { info: { id: "u-1", role: "user" } },
          { info: { id: "a-1", role: "assistant", time: { completed: 1700000000000 } } },
        ];
      }),
    });
    const outcome = await verifyBoxAnswers({
      api,
      sessionId: "s-1",
      pollIntervalMs: 5,
      timeoutMs: 5000,
    });
    expect(outcome).toEqual({ ok: true });
  });
});

describe("finalizeOnboarding", () => {
  it("creates a project, sends the probe, and resolves on a real response", async () => {
    let pollCount = 0;
    const api = makeApi({
      tmuxNewSession: vi.fn(async () => ({ ok: true as const, sessionName: "welcome" })),
      opencodeMessages: vi.fn(async () => {
        pollCount += 1;
        // First poll is the BASELINE snapshot taken BEFORE the prompt is
        // sent — only the user message is present. Subsequent polls return
        // the assistant reply, which is what `verifyBoxAnswers` is waiting
        // for. Without this split the baseline filter would never see a
        // new assistant message and the verify would time out.
        if (pollCount === 1) return [{ info: { id: "u-1", role: "user" } }];
        return [
          { info: { id: "u-1", role: "user" } },
          { info: { id: "a-1", role: "assistant", time: { completed: 1700000000000 } } },
        ];
      }),
    });
    // Pre-populate the store with the post-create project so the verify
    // path has a chat session to send the probe against. The default
    // refresh() in makeStore would also populate this — using an explicit
    // pre-population here keeps the test intent obvious.
    const store = makeStore({
      projects: [
        {
          tmuxSession: "welcome",
          windows: [{ opencodeSessionId: "sid-welcome" }],
        },
      ],
    });
    await expect(
      finalizeOnboarding({
        api,
        store,
        pollIntervalMs: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects with the verify-box message when no assistant response arrives", async () => {
    const api = makeApi({
      opencodeMessages: vi.fn(async () => []),
    });
    const store = makeStore({
      projects: [
        {
          tmuxSession: "welcome",
          windows: [{ opencodeSessionId: "sid-welcome" }],
        },
      ],
    });
    await expect(
      finalizeOnboarding({
        api,
        store,
        pollIntervalMs: 5,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/didn't answer/);
  });
});

describe("hasConnectedProvider", () => {
  it("returns true when any row is connected", async () => {
    const api = makeApi({
      opencodeProviderAuth: vi.fn(async () => ({
        action: "status",
        providers: [
          { id: "anthropic", connected: false },
          { id: "openai", connected: true },
        ],
      })),
    });
    expect(await hasConnectedProvider(api)).toBe(true);
  });

  it("returns false when every row is disconnected", async () => {
    const api = makeApi({
      opencodeProviderAuth: vi.fn(async () => ({
        action: "status",
        providers: [{ id: "anthropic", connected: false }],
      })),
    });
    expect(await hasConnectedProvider(api)).toBe(false);
  });

  it("returns false on a malformed response", async () => {
    const api = makeApi({
      opencodeProviderAuth: vi.fn(async () => null),
    });
    expect(await hasConnectedProvider(api)).toBe(false);
  });

  it("returns false on an IPC throw (treat as unreachable, not a fatal)", async () => {
    const api = makeApi({
      opencodeProviderAuth: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    expect(await hasConnectedProvider(api)).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { resolveSessionOwner, useStore } from "./store";
import type { Project } from "../shared/types";

function proj(over: Partial<Project> & { tmuxSession: string }): Project {
  return {
    tmuxSession: over.tmuxSession,
    defaultCwd: over.defaultCwd ?? "~",
    attached: over.attached ?? false,
    windows: over.windows ?? [],
  };
}

describe("resolveSessionOwner", () => {
  it("returns null when no window owns the session id", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        windows: [
          { index: 0, name: "main", active: true, paneCurrentPath: "/x", opencodeSessionId: null },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_missing")).toBeNull();
  });

  it("finds the owning window and prefers paneCurrentPath over defaultCwd", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        defaultCwd: "~/bui",
        windows: [
          { index: 2, name: "feat", active: false, paneCurrentPath: "/abs/feat", opencodeSessionId: "ses_a" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_a")).toEqual({
      tmuxSession: "bui",
      windowIndex: 2,
      cwd: "/abs/feat",
    });
  });

  it("falls back to project defaultCwd when paneCurrentPath is empty", () => {
    const projects = [
      proj({
        tmuxSession: "bui",
        defaultCwd: "~/bui",
        windows: [
          { index: 1, name: "w", active: false, paneCurrentPath: "", opencodeSessionId: "ses_b" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_b")).toEqual({
      tmuxSession: "bui",
      windowIndex: 1,
      cwd: "~/bui",
    });
  });

  it("returns the first matching window across multiple projects", () => {
    const projects = [
      proj({ tmuxSession: "a", windows: [] }),
      proj({
        tmuxSession: "b",
        defaultCwd: "~/b",
        windows: [
          { index: 0, name: "w", active: true, paneCurrentPath: "/b", opencodeSessionId: "ses_c" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_c")).toEqual({
      tmuxSession: "b",
      windowIndex: 0,
      cwd: "/b",
    });
  });
});

// ===== Chat-mode status: setChatRunning / setChatAttention =====
//
// Drives the sidebar dot for chat-mode windows. The PTY-pane poller
// can't see chat windows' state (the holder runs `sleep infinity`),
// so all sidebar signals for chat sessions flow through these actions
// from the global opencode SSE subscription in App.tsx.

describe("setChatRunning / setChatAttention", () => {
  // Reset zustand store to a known state before each test. Only the
  // fields the actions read or write need to be set.
  beforeEach(() => {
    useStore.setState({
      projects: [
        proj({
          tmuxSession: "bui",
          windows: [
            {
              index: 0,
              name: "chat",
              active: false,
              paneCurrentPath: "/x",
              opencodeSessionId: "ses_chat",
            },
          ],
        }),
      ],
      status: {},
      activeProjectName: null,
      activeWindowByProject: {},
    });
  });

  describe("setChatRunning", () => {
    it("no-ops when no window owns the sessionId", () => {
      useStore.getState().setChatRunning("ses_unknown", true);
      expect(useStore.getState().status).toEqual({});
    });

    it("sets running:true for the matching window", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      expect(useStore.getState().status.bui[0]).toEqual({
        running: true,
        subagents: 0,
        attention: false,
        attentionKind: undefined,
      });
    });

    it("latches attention='idle' on running → idle when user isn't on the window", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatRunning("ses_chat", false);
      const win = useStore.getState().status.bui[0];
      expect(win.running).toBe(false);
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("idle");
    });

    it("does NOT latch attention when the user IS on the window", () => {
      useStore.setState({
        activeProjectName: "bui",
        activeWindowByProject: { bui: 0 },
      });
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatRunning("ses_chat", false);
      expect(useStore.getState().status.bui[0].attention).toBe(false);
    });

    it("downgrades a stale 'question' latch to amber 'idle' on running → idle while away", () => {
      // A pending Question keeps the session BUSY, so reaching idle proves
      // the block is gone — the red `?` is stale (its clearing
      // question.replied event was missed). Downgrade to the soft amber
      // "go check" signal instead of stranding the red `?` until the user
      // opens the window.
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().setChatRunning("ses_chat", false);
      const win = useStore.getState().status.bui[0];
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("idle");
    });

    it("clears a stale 'permission' latch entirely on running → idle while the user IS on the window", () => {
      useStore.setState({
        activeProjectName: "bui",
        activeWindowByProject: { bui: 0 },
      });
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "permission");
      useStore.getState().setChatRunning("ses_chat", false);
      const win = useStore.getState().status.bui[0];
      expect(win.attention).toBe(false);
      expect(win.attentionKind).toBeUndefined();
    });

    it("keeps the 'question' latch while the session is still running (busy)", () => {
      // The downgrade ONLY fires on the running→idle transition. A
      // running→running tick (busy heartbeat) must keep the red `?` — the
      // question is genuinely still blocking.
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().setChatRunning("ses_chat", true);
      const win = useStore.getState().status.bui[0];
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("question");
    });
  });

  describe("setChatAttention", () => {
    it("no-ops when no window owns the sessionId", () => {
      useStore.getState().setChatAttention("ses_unknown", "question");
      expect(useStore.getState().status).toEqual({});
    });

    it("sets attention:true with kind='question'", () => {
      useStore.getState().setChatAttention("ses_chat", "question");
      expect(useStore.getState().status.bui[0]).toEqual({
        running: false,
        subagents: 0,
        attention: true,
        attentionKind: "question",
      });
    });

    it("sets attention:true with kind='permission'", () => {
      useStore.getState().setChatAttention("ses_chat", "permission");
      expect(useStore.getState().status.bui[0].attentionKind).toBe(
        "permission",
      );
    });

    it("clears attention when called with null (replied/rejected)", () => {
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().setChatAttention("ses_chat", null);
      const win = useStore.getState().status.bui[0];
      expect(win.attention).toBe(false);
      expect(win.attentionKind).toBeUndefined();
    });

    it("latches question attention EVEN when the user is on the window", () => {
      // Blocking kinds ('question' / 'permission') must persist so that
      // navigating away mid-turn still surfaces the indicator in the
      // sidebar. The card is also visible inline; the sidebar dot is
      // redundant-but-harmless while active and gets cleared on the
      // next setActive() touch.
      useStore.setState({
        activeProjectName: "bui",
        activeWindowByProject: { bui: 0 },
      });
      useStore.getState().setChatAttention("ses_chat", "question");
      expect(useStore.getState().status.bui[0]?.attention).toBe(true);
      expect(useStore.getState().status.bui[0]?.attentionKind).toBe("question");
    });

    it("latches permission attention EVEN when the user is on the window", () => {
      useStore.setState({
        activeProjectName: "bui",
        activeWindowByProject: { bui: 0 },
      });
      useStore.getState().setChatAttention("ses_chat", "permission");
      expect(useStore.getState().status.bui[0]?.attention).toBe(true);
      expect(useStore.getState().status.bui[0]?.attentionKind).toBe(
        "permission",
      );
    });

    it("does NOT set 'idle' attention when the user IS on the window", () => {
      // Soft "go check" signal — if they're already looking at the
      // window, there's nothing to go check.
      useStore.setState({
        activeProjectName: "bui",
        activeWindowByProject: { bui: 0 },
      });
      useStore.getState().setChatAttention("ses_chat", "idle");
      expect(useStore.getState().status.bui[0]?.attention ?? false).toBe(false);
    });

    it("preserves running:true while raising attention", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "question");
      const win = useStore.getState().status.bui[0];
      expect(win.running).toBe(true);
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("question");
    });
  });

  describe("setActive clears attention fully", () => {
    it("wipes BOTH attention and attentionKind when focusing the window", () => {
      // REGRESSION: clearAttention used to leave attentionKind set. A later
      // running update could then re-derive a red ?/! glyph from the dead
      // kind. Focusing a window must leave it fully clean.
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().setActive("bui", 0);
      const win = useStore.getState().status.bui[0];
      expect(win.attention).toBe(false);
      expect(win.attentionKind).toBeUndefined();
    });
  });

  describe("applyStatusBatch preserves chat-window state", () => {
    it("does not clobber chat windows' running state with poller data", () => {
      // Set running via the chat path...
      useStore.getState().setChatRunning("ses_chat", true);
      // ...then the poller batch arrives. Because the window has an
      // opencodeSessionId set, applyStatusBatch must NOT overwrite it
      // with whatever (probably false) the BUSY_RE matched against the
      // empty holder pane.
      useStore.getState().applyStatusBatch([
        // No entry for bui:0 in the batch (the poller wouldn't include
        // chat-mode windows in a fixed world, but even when it does,
        // the chat-state must win).
      ]);
      const win = useStore.getState().status.bui[0];
      expect(win.running).toBe(true);
    });

    it("preserves chat-window attentionKind across poller ticks", () => {
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().applyStatusBatch([]);
      const win = useStore.getState().status.bui[0];
      expect(win.attentionKind).toBe("question");
      expect(win.attention).toBe(true);
    });
  });

  describe("setChatSubagents", () => {
    // Sole update path for the `·N` indicator on chat-mode windows. The
    // TUI poller's regex can't see chat-mode panes (they run `sleep
    // infinity`, not claude). ChatPanel pushes here whenever its derived
    // count from countRunningSubagents changes.

    it("no-ops when no window owns the sessionId", () => {
      useStore.getState().setChatSubagents("ses_unknown", 3);
      expect(useStore.getState().status).toEqual({});
    });

    it("sets the subagent count on the matching window", () => {
      useStore.getState().setChatSubagents("ses_chat", 2);
      expect(useStore.getState().status.bui[0]).toEqual({
        running: false,
        subagents: 2,
        attention: false,
        attentionKind: undefined,
      });
    });

    it("returns the previous state object when the count is unchanged (no churn)", () => {
      // Critical for keystroke perf: ChatPanel pushes on every transcript
      // change, which is many per second during streaming. A no-op must
      // not allocate a new state, or every zustand subscriber re-renders.
      useStore.getState().setChatSubagents("ses_chat", 0);
      const firstStatus = useStore.getState().status;
      useStore.getState().setChatSubagents("ses_chat", 0);
      expect(useStore.getState().status).toBe(firstStatus);
    });

    it("preserves running and attention fields when changing the count", () => {
      // Subagent count is orthogonal to running/attention; updating it
      // must not clear unrelated flags set by setChatRunning/Attention.
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().setChatSubagents("ses_chat", 4);
      const win = useStore.getState().status.bui[0];
      expect(win.running).toBe(true);
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("question");
      expect(win.subagents).toBe(4);
    });
  });
});

// ===== Startup attention replay =====
//
// opencode SSE is forward-only, so a window already blocked on a question /
// permission when the app (re)connects never re-fires the *.asked event.
// replayChatAttention queries each chat-window's live pending state per
// session (the /question + /permission lists are ?directory=-scoped) and
// latches the indicator so the dot appears WITHOUT the user focusing first.

describe("replayChatAttention", () => {
  let questionsBySid: Record<string, unknown[]>;
  let permissionsBySid: Record<string, unknown[]>;
  let questionCalls: string[];
  let permissionCalls: string[];

  beforeEach(() => {
    questionsBySid = {};
    permissionsBySid = {};
    questionCalls = [];
    permissionCalls = [];
    (globalThis as unknown as { window: unknown }).window = {
      api: {
        opencodeQuestions: async (sid: string) => {
          questionCalls.push(sid);
          return questionsBySid[sid] ?? [];
        },
        opencodePermissions: async (sid: string) => {
          permissionCalls.push(sid);
          return permissionsBySid[sid] ?? [];
        },
      },
    };
    useStore.setState({
      projects: [
        proj({
          tmuxSession: "bui",
          windows: [
            {
              index: 0,
              name: "chat",
              active: false,
              paneCurrentPath: "/x",
              opencodeSessionId: "ses_q",
            },
            {
              index: 1,
              name: "chat2",
              active: false,
              paneCurrentPath: "/y",
              opencodeSessionId: "ses_p",
            },
            {
              index: 2,
              name: "term",
              active: false,
              paneCurrentPath: "/z",
              opencodeSessionId: null,
            },
          ],
        }),
      ],
      status: {},
      activeProjectName: null,
      activeWindowByProject: {},
    });
  });

  it("latches 'question' for a session with a pending question", async () => {
    questionsBySid["ses_q"] = [{ id: "q1", sessionID: "ses_q" }];
    await useStore.getState().replayChatAttention();
    const win = useStore.getState().status.bui[0];
    expect(win.attention).toBe(true);
    expect(win.attentionKind).toBe("question");
  });

  it("latches 'permission' for a session with only a pending permission", async () => {
    permissionsBySid["ses_p"] = [{ id: "p1", sessionID: "ses_p" }];
    await useStore.getState().replayChatAttention();
    const win = useStore.getState().status.bui[1];
    expect(win.attention).toBe(true);
    expect(win.attentionKind).toBe("permission");
  });

  it("question outranks permission when both are pending", async () => {
    questionsBySid["ses_q"] = [{ id: "q1", sessionID: "ses_q" }];
    permissionsBySid["ses_q"] = [{ id: "p1", sessionID: "ses_q" }];
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status.bui[0].attentionKind).toBe("question");
  });

  it("does NOT latch attention for sessions with nothing pending", async () => {
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status).toEqual({});
  });

  it("only queries chat-mode windows (skips terminal windows)", async () => {
    await useStore.getState().replayChatAttention();
    expect(questionCalls.sort()).toEqual(["ses_p", "ses_q"]);
    expect(permissionCalls.sort()).toEqual(["ses_p", "ses_q"]);
  });

  it("is resilient to a per-session fetch rejection", async () => {
    (globalThis as unknown as { window: { api: Record<string, unknown> } })
      .window.api.opencodeQuestions = async (sid: string) => {
      if (sid === "ses_q") throw new Error("scoped fetch failed");
      return [];
    };
    permissionsBySid["ses_p"] = [{ id: "p1", sessionID: "ses_p" }];
    await useStore.getState().replayChatAttention();
    // ses_p still latched despite ses_q's question fetch throwing.
    expect(useStore.getState().status.bui[1].attentionKind).toBe("permission");
  });
});

describe("setDefaultModel (onboarding Step 3 + Settings)", () => {
  beforeEach(() => {
    useStore.setState({ defaultModel: null });
  });

  it("optimistically sets, persists via configUpdate, and reconciles", async () => {
    const patches: Array<Record<string, unknown>> = [];
    (globalThis as unknown as { window: { api: Record<string, unknown> } }).window = {
      api: {
        // Echo the patch back (main's success path returns the saved config).
        configUpdate: async (patch: Record<string, unknown>) => {
          patches.push(patch);
          return { defaultModel: patch.defaultModel };
        },
      },
    };
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
    await useStore.getState().setDefaultModel(model);
    expect(patches).toEqual([{ defaultModel: model }]);
    expect(useStore.getState().defaultModel).toEqual(model);
  });

  it("reconciles to null when main drops the field (reject path)", async () => {
    (globalThis as unknown as { window: { api: Record<string, unknown> } }).window = {
      api: {
        // Simulate main NOT persisting defaultModel (returns config without it).
        configUpdate: async () => ({}),
      },
    };
    await useStore.getState().setDefaultModel({ providerID: "openai", modelID: "gpt-4o" });
    expect(useStore.getState().defaultModel).toBeNull();
  });
});

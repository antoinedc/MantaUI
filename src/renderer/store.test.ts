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
        tmuxSession: "manta",
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
        tmuxSession: "manta",
        defaultCwd: "~/manta",
        windows: [
          { index: 2, name: "feat", active: false, paneCurrentPath: "/abs/feat", opencodeSessionId: "ses_a" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_a")).toEqual({
      tmuxSession: "manta",
      windowIndex: 2,
      cwd: "/abs/feat",
    });
  });

  it("falls back to project defaultCwd when paneCurrentPath is empty", () => {
    const projects = [
      proj({
        tmuxSession: "manta",
        defaultCwd: "~/manta",
        windows: [
          { index: 1, name: "w", active: false, paneCurrentPath: "", opencodeSessionId: "ses_b" },
        ],
      }),
    ];
    expect(resolveSessionOwner(projects, "ses_b")).toEqual({
      tmuxSession: "manta",
      windowIndex: 1,
      cwd: "~/manta",
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
          tmuxSession: "manta",
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
      const win = useStore.getState().status.manta[0];
      expect(win).toMatchObject({
        running: true,
        subagents: 0,
        attention: false,
        attentionKind: undefined,
      });
      // BET-119: an idle → running transition stamps lastMessageAt.
      expect(win.lastMessageAt).toEqual(expect.any(Number));
    });

    it("stamps lastMessageAt on every running-value transition (BET-119)", () => {
      const before = Date.now();
      useStore.getState().setChatRunning("ses_chat", true);
      const afterStart = useStore.getState().status.manta[0].lastMessageAt;
      expect(afterStart).toBeGreaterThanOrEqual(before);

      useStore.getState().setChatRunning("ses_chat", false);
      const afterIdle = useStore.getState().status.manta[0].lastMessageAt;
      expect(afterIdle).toBeGreaterThanOrEqual(afterStart!);
    });

    it("does NOT re-stamp lastMessageAt on a no-op running→running call (BET-119)", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      const first = useStore.getState().status.manta[0].lastMessageAt;
      useStore.getState().setChatRunning("ses_chat", true);
      const second = useStore.getState().status.manta[0].lastMessageAt;
      expect(second).toBe(first);
    });

    it("latches attention='idle' on running → idle when user isn't on the window", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatRunning("ses_chat", false);
      const win = useStore.getState().status.manta[0];
      expect(win.running).toBe(false);
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("idle");
    });

    it("does NOT latch attention when the user IS on the window", () => {
      useStore.setState({
        activeProjectName: "manta",
        activeWindowByProject: { manta: 0 },
      });
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatRunning("ses_chat", false);
      expect(useStore.getState().status.manta[0].attention).toBe(false);
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
      const win = useStore.getState().status.manta[0];
      expect(win.attention).toBe(true);
      expect(win.attentionKind).toBe("idle");
    });

    it("clears a stale 'permission' latch entirely on running → idle while the user IS on the window", () => {
      useStore.setState({
        activeProjectName: "manta",
        activeWindowByProject: { manta: 0 },
      });
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "permission");
      useStore.getState().setChatRunning("ses_chat", false);
      const win = useStore.getState().status.manta[0];
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
      const win = useStore.getState().status.manta[0];
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
      expect(useStore.getState().status.manta[0]).toEqual({
        running: false,
        subagents: 0,
        attention: true,
        attentionKind: "question",
      });
    });

    it("sets attention:true with kind='permission'", () => {
      useStore.getState().setChatAttention("ses_chat", "permission");
      expect(useStore.getState().status.manta[0].attentionKind).toBe(
        "permission",
      );
    });

    it("clears attention when called with null (replied/rejected)", () => {
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().setChatAttention("ses_chat", null);
      const win = useStore.getState().status.manta[0];
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
        activeProjectName: "manta",
        activeWindowByProject: { manta: 0 },
      });
      useStore.getState().setChatAttention("ses_chat", "question");
      expect(useStore.getState().status.manta[0]?.attention).toBe(true);
      expect(useStore.getState().status.manta[0]?.attentionKind).toBe("question");
    });

    it("latches permission attention EVEN when the user is on the window", () => {
      useStore.setState({
        activeProjectName: "manta",
        activeWindowByProject: { manta: 0 },
      });
      useStore.getState().setChatAttention("ses_chat", "permission");
      expect(useStore.getState().status.manta[0]?.attention).toBe(true);
      expect(useStore.getState().status.manta[0]?.attentionKind).toBe(
        "permission",
      );
    });

    it("does NOT set 'idle' attention when the user IS on the window", () => {
      // Soft "go check" signal — if they're already looking at the
      // window, there's nothing to go check.
      useStore.setState({
        activeProjectName: "manta",
        activeWindowByProject: { manta: 0 },
      });
      useStore.getState().setChatAttention("ses_chat", "idle");
      expect(useStore.getState().status.manta[0]?.attention ?? false).toBe(false);
    });

    it("preserves running:true while raising attention", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      useStore.getState().setChatAttention("ses_chat", "question");
      const win = useStore.getState().status.manta[0];
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
      useStore.getState().setActive("manta", 0);
      const win = useStore.getState().status.manta[0];
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
        // No entry for manta:0 in the batch (the poller wouldn't include
        // chat-mode windows in a fixed world, but even when it does,
        // the chat-state must win).
      ]);
      const win = useStore.getState().status.manta[0];
      expect(win.running).toBe(true);
    });

    it("preserves chat-window attentionKind across poller ticks", () => {
      useStore.getState().setChatAttention("ses_chat", "question");
      useStore.getState().applyStatusBatch([]);
      const win = useStore.getState().status.manta[0];
      expect(win.attentionKind).toBe("question");
      expect(win.attention).toBe(true);
    });

    it("preserves chat-window lastMessageAt across poller ticks (BET-119)", () => {
      useStore.getState().setChatRunning("ses_chat", true);
      const stamped = useStore.getState().status.manta[0].lastMessageAt;
      useStore.getState().applyStatusBatch([]);
      expect(useStore.getState().status.manta[0].lastMessageAt).toBe(stamped);
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
      expect(useStore.getState().status.manta[0]).toEqual({
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
      const win = useStore.getState().status.manta[0];
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
  // Default every session to an in-flight transcript (last assistant message
  // has no completion stamp) so existing "latch" expectations below keep
  // their original meaning; tests that exercise the orphan/self-heal path
  // override this per-session to a COMPLETED transcript.
  let messagesBySid: Record<string, unknown[]>;
  let questionCalls: string[];
  let permissionCalls: string[];
  let messagesCalls: string[];
  let rejectCalls: Array<{ requestId: string; sessionId: string }>;

  const inFlightTranscript = [{ info: { role: "assistant" } }];
  const completedTranscript = [
    { info: { role: "assistant", time: { completed: 1234 } } },
  ];

  beforeEach(() => {
    questionsBySid = {};
    permissionsBySid = {};
    messagesBySid = {};
    questionCalls = [];
    permissionCalls = [];
    messagesCalls = [];
    rejectCalls = [];
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
        opencodeMessages: async (sid: string) => {
          messagesCalls.push(sid);
          return messagesBySid[sid] ?? inFlightTranscript;
        },
        opencodeQuestionReject: async (requestId: string, sessionId: string) => {
          rejectCalls.push({ requestId, sessionId });
        },
      },
    };
    useStore.setState({
      projects: [
        proj({
          tmuxSession: "manta",
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
    const win = useStore.getState().status.manta[0];
    expect(win.attention).toBe(true);
    expect(win.attentionKind).toBe("question");
  });

  it("latches 'permission' for a session with only a pending permission", async () => {
    permissionsBySid["ses_p"] = [{ id: "p1", sessionID: "ses_p" }];
    await useStore.getState().replayChatAttention();
    const win = useStore.getState().status.manta[1];
    expect(win.attention).toBe(true);
    expect(win.attentionKind).toBe("permission");
  });

  it("question outranks permission when both are pending", async () => {
    questionsBySid["ses_q"] = [{ id: "q1", sessionID: "ses_q" }];
    permissionsBySid["ses_q"] = [{ id: "p1", sessionID: "ses_q" }];
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status.manta[0].attentionKind).toBe("question");
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
    expect(useStore.getState().status.manta[1].attentionKind).toBe("permission");
  });

  it("skips the transcript check entirely when nothing is pending (no opencodeMessages call)", async () => {
    await useStore.getState().replayChatAttention();
    expect(messagesCalls).toEqual([]);
  });

  it("does NOT latch and rejects an orphaned question whose turn already completed", async () => {
    questionsBySid["ses_q"] = [{ id: "q1", sessionID: "ses_q", requestId: "que_1" }];
    messagesBySid["ses_q"] = completedTranscript;
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status.manta?.[0]?.attention).not.toBe(true);
    expect(rejectCalls).toEqual([{ requestId: "que_1", sessionId: "ses_q" }]);
  });

  it("skips (but does not reject) an orphaned question with no requestId", async () => {
    questionsBySid["ses_q"] = [{ id: "q1", sessionID: "ses_q" }];
    messagesBySid["ses_q"] = completedTranscript;
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status.manta?.[0]?.attention).not.toBe(true);
    expect(rejectCalls).toEqual([]);
  });

  it("does NOT latch a stale permission whose turn already completed, and does not reject it", async () => {
    permissionsBySid["ses_p"] = [{ id: "p1", sessionID: "ses_p" }];
    messagesBySid["ses_p"] = completedTranscript;
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status.manta?.[1]?.attention).not.toBe(true);
    expect(rejectCalls).toEqual([]);
  });

  it("skips latching (fails safe) when the transcript fetch itself throws", async () => {
    questionsBySid["ses_q"] = [{ id: "q1", sessionID: "ses_q", requestId: "que_1" }];
    (globalThis as unknown as { window: { api: Record<string, unknown> } })
      .window.api.opencodeMessages = async () => {
      throw new Error("transcript fetch failed");
    };
    await useStore.getState().replayChatAttention();
    expect(useStore.getState().status.manta?.[0]?.attention).not.toBe(true);
    expect(rejectCalls).toEqual([]);
  });
});

// ===== Cold-start lastMessageAt backfill (BET-119) =====
//
// opencode SSE is forward-only (same rationale as replayChatAttention
// above), so a chat window's lastMessageAt is unset until its first
// busy/idle transition post-launch. backfillLastMessageTimes queries each
// chat window's owning directory for its opencode session list and stamps
// lastMessageAt from time.updated — but only for windows with no live stamp
// yet, so it can never clobber a real setChatRunning-driven value.

describe("backfillLastMessageTimes", () => {
  let sessionsByDir: Record<string, Array<{ id: string; time?: { updated?: number } }>>;
  let listCalls: string[];

  beforeEach(() => {
    sessionsByDir = {};
    listCalls = [];
    (globalThis as unknown as { window: unknown }).window = {
      api: {
        opencodeListSessions: async (dir: string) => {
          listCalls.push(dir);
          return sessionsByDir[dir] ?? [];
        },
      },
    };
    useStore.setState({
      projects: [
        proj({
          tmuxSession: "manta",
          windows: [
            {
              index: 0,
              name: "chat",
              active: false,
              paneCurrentPath: "/x",
              opencodeSessionId: "ses_chat",
            },
            {
              index: 1,
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

  it("stamps lastMessageAt from time.updated for a chat window with no prior stamp", async () => {
    sessionsByDir["/x"] = [{ id: "ses_chat", time: { updated: 12345 } }];
    await useStore.getState().backfillLastMessageTimes();
    expect(useStore.getState().status.manta[0].lastMessageAt).toBe(12345);
  });

  it("never stomps a live SSE-driven stamp", async () => {
    useStore.getState().setChatRunning("ses_chat", true);
    const live = useStore.getState().status.manta[0].lastMessageAt;
    sessionsByDir["/x"] = [{ id: "ses_chat", time: { updated: 1 } }];
    await useStore.getState().backfillLastMessageTimes();
    expect(useStore.getState().status.manta[0].lastMessageAt).toBe(live);
  });

  it("only queries chat-mode windows' directories (skips terminal windows)", async () => {
    await useStore.getState().backfillLastMessageTimes();
    expect(listCalls).toEqual(["/x"]);
  });

  it("is a no-op when there are no chat-mode windows", async () => {
    useStore.setState({
      projects: [
        proj({
          tmuxSession: "manta",
          windows: [
            {
              index: 0,
              name: "term",
              active: false,
              paneCurrentPath: "/z",
              opencodeSessionId: null,
            },
          ],
        }),
      ],
      status: {},
    });
    await useStore.getState().backfillLastMessageTimes();
    expect(listCalls).toEqual([]);
    expect(useStore.getState().status).toEqual({});
  });

  it("is resilient to a per-directory fetch rejection", async () => {
    (globalThis as unknown as { window: { api: Record<string, unknown> } })
      .window.api.opencodeListSessions = async () => {
      throw new Error("fetch failed");
    };
    await expect(
      useStore.getState().backfillLastMessageTimes(),
    ).resolves.toBeUndefined();
    expect(useStore.getState().status.manta?.[0]?.lastMessageAt).toBeUndefined();
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

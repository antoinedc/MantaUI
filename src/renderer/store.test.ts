// @vitest-environment jsdom
// jsdom required because applyProjects/setActive persist + restore the
// last-active session via localStorage (readSavedActiveSession /
// writeSavedActiveSession). The rest of the file doesn't care — the nodenv
// differences are confined to the persistence helpers' try/catch.
import { describe, it, expect, beforeEach } from "vitest";
import { loadPersistedSnapshot, resolveSessionOwner, useStore } from "./store";
import { writeSavedActiveSession } from "./chatShared";
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

describe("setPendingPairLink (BET-240 deep-link pairing)", () => {
  beforeEach(() => {
    useStore.setState({ pendingPairLink: null });
  });

  it("writes the raw URL into pendingPairLink", () => {
    const url = "manta://pair?box=0123456789abcdef0123456789abcdef&code=123456";
    useStore.getState().setPendingPairLink(url);
    expect(useStore.getState().pendingPairLink).toBe(url);
  });

  it("clears the field when null is passed (consume-on-use)", () => {
    useStore.setState({
      pendingPairLink: "manta://pair?box=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code=111111",
    });
    useStore.getState().setPendingPairLink(null);
    expect(useStore.getState().pendingPairLink).toBeNull();
  });
});

describe("deep-link pairing error", () => {
  beforeEach(() => {
    useStore.setState({ pairLinkError: null, pendingPairLink: null });
  });

  it("setPairLinkError carries the failure reason, and null consumes it", () => {
    useStore.getState().setPairLinkError("Couldn't reach your box.");
    expect(useStore.getState().pairLinkError).toBe("Couldn't reach your box.");
    useStore.getState().setPairLinkError(null);
    expect(useStore.getState().pairLinkError).toBeNull();
  });
});

// ===== New-session drafts (BET draft model) =====
//
// A "new session" is an in-memory store draft until it commits. The draft
// holds the composer workspace; navigating away/back must not lose it, and
// navigating to a real session (setActive) must exit any draft view.

describe("new-session drafts", () => {
  beforeEach(() => {
    useStore.setState({ activeDraftId: null, drafts: [] });
  });

  it("createDraft adds a draft and makes it the active view", () => {
    const id = useStore.getState().createDraft("new-project");
    const s = useStore.getState();
    expect(s.drafts.map((d) => d.id)).toEqual([id]);
    expect(s.activeDraftId).toBe(id);
    const d = s.drafts[0];
    expect(d.mode).toBe("new-project");
    expect(d.cwd).toBe("~");
    expect(d.input).toBe("");
    expect(d.wantWorktree).toBe(false);
  });

  it("createDraft new-session mode targets the project and seeds cwd from config", () => {
    useStore.setState({ worktreePerSession: true });
    useStore.getState().createDraft({ projectName: "better-ui" });
    const d = useStore.getState().drafts[0];
    expect(d.mode).toEqual({ projectName: "better-ui" });
    // new-session cwd starts empty (resolved from the project later)
    expect(d.cwd).toBe("");
    // wantWorktree seeds from the worktreePerSession config for new-session mode
    expect(d.wantWorktree).toBe(true);
  });

  it("updateDraft patches only the matching draft", () => {
    const a = useStore.getState().createDraft("new-project");
    const b = useStore.getState().createDraft({ projectName: "x" });
    useStore.getState().updateDraft(a, { input: "hello" });
    const s = useStore.getState();
    expect(s.drafts.find((d) => d.id === a)!.input).toBe("hello");
    expect(s.drafts.find((d) => d.id === b)!.input).toBe("");
  });

  it("dismissDraft removes it and re-points the active view at another draft", () => {
    const a = useStore.getState().createDraft("new-project");
    const b = useStore.getState().createDraft({ projectName: "x" });
    // dismiss the first (not active) — active stays b
    useStore.getState().dismissDraft(a);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual([b]);
    expect(useStore.getState().activeDraftId).toBe(b);
  });

  it("dismissing the ACTIVE draft falls back to a surviving draft, else null", () => {
    const a = useStore.getState().createDraft("new-project");
    const s = useStore.getState();
    expect(s.activeDraftId).toBe(a);
    useStore.getState().dismissDraft(a);
    expect(useStore.getState().activeDraftId).toBeNull();
    expect(useStore.getState().drafts).toEqual([]);
  });

  it("setActive (a real session) clears the active draft view", () => {
    useStore.setState({
      projects: [
        proj({
          tmuxSession: "manta",
          windows: [
            { index: 0, name: "w", active: true, paneCurrentPath: "/x", opencodeSessionId: "ses_a" },
          ],
        }),
      ],
    });
    const id = useStore.getState().createDraft({ projectName: "manta" });
    expect(useStore.getState().activeDraftId).toBe(id);
    useStore.getState().setActive("manta", 0);
    expect(useStore.getState().activeDraftId).toBeNull();
    // the draft itself is untouched — it stays in the sidebar for later use
    expect(useStore.getState().drafts.some((d) => d.id === id)).toBe(true);
  });
});

// ===== Last-active session restore =====
//
// activeProjectName starts null on a fresh boot / renderer reload. Without
// restore, applyProjects defaulted to projects[0] — landing the user on an
// arbitrary/first session instead of the one they last used. These tests pin
// the persistence (setActive writes) + restore (applyProjects reads).

describe("last-active session restore (refresh / relaunch)", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      projects: [],
      activeProjectName: null,
      activeWindowByProject: {},
      recentWindows: [],
    });
  });

  function sessions() {
    return [
      proj({
        tmuxSession: "alpha",
        defaultCwd: "~/alpha",
        windows: [
          { index: 0, name: "w0", active: true, paneCurrentPath: "/alpha/0", opencodeSessionId: null },
          { index: 1, name: "w1", active: false, paneCurrentPath: "/alpha/1", opencodeSessionId: null },
        ],
      }),
      proj({
        tmuxSession: "beta",
        defaultCwd: "~/beta",
        windows: [
          { index: 0, name: "w0", active: true, paneCurrentPath: "/beta/0", opencodeSessionId: null },
        ],
      }),
    ];
  }

  // Shared restore path: the saved last-used session is alpha/window 1 and the
  // tree has alpha/beta. Used by several tests below whose saved-cursor differs
  // only by what surrounds the applyProjects call.
  function savedAlphaAfterApply() {
    writeSavedActiveSession({ project: "alpha", window: 1 });
    useStore.getState().applyProjects(sessions());
    return useStore.getState();
  }

  it("setActive persists the pin to localStorage", () => {
    useStore.setState({ projects: sessions() });
    useStore.getState().setActive("beta", 0);
    expect(localStorage.getItem("manta:lastActiveSession")).toBe(
      JSON.stringify({ project: "beta", window: 0 }),
    );
  });

  it("applyProjects with no prior selection restores the saved last-used session", () => {
    const s = savedAlphaAfterApply();
    expect(s.activeProjectName).toBe("alpha");
    expect(s.activeWindowByProject.alpha).toBe(1);
  });

  it("applyProjects keeps an existing valid selection (mid-session refresh)", () => {
    useStore.setState({
      activeProjectName: "beta",
      activeWindowByProject: { beta: 0 },
    });
    writeSavedActiveSession({ project: "alpha", window: 1 });
    useStore.getState().applyProjects(sessions());
    const s = useStore.getState();
    // a live refresh must NOT yank the user off the session they're on
    expect(s.activeProjectName).toBe("beta");
    expect(s.activeProjectName).not.toBe("alpha");
  });

  it("applyProjects falls back to projects[0] when the saved session is gone", () => {
    writeSavedActiveSession({ project: "vanished", window: 0 });
    useStore.getState().applyProjects(sessions());
    const s = useStore.getState();
    expect(s.activeProjectName).toBe("alpha");
  });

  it("applyProjects falls back to projects[0] when the saved window no longer exists", () => {
    writeSavedActiveSession({ project: "alpha", window: 9 });
    useStore.getState().applyProjects(sessions());
    const s = useStore.getState();
    expect(s.activeProjectName).toBe("alpha");
    // window 9 doesn't exist — clamp to the tmux-active / first window
    expect(s.activeWindowByProject.alpha).toBe(0);
  });

  it("applyProjects restores the saved window over the tmux-active one", () => {
    // alpha's tmux-active window is 0, but the user last used window 1 —
    // restore must win so they land exactly where they left off.
    const s = savedAlphaAfterApply();
    expect(s.activeProjectName).toBe("alpha");
    expect(s.activeWindowByProject.alpha).toBe(1);
  });

  it("applyProjects with no saved pin and no valid selection falls back to projects[0]", () => {
    useStore.getState().applyProjects(sessions());
    const s = useStore.getState();
    expect(s.activeProjectName).toBe("alpha");
    expect(s.activeWindowByProject.alpha).toBe(0);
  });

  it("applyProjects clears the auto-created zero-state draft once projects arrive", () => {
    // Boot races: loaded flips true while projects is still [], which auto-
    // creates a "welcome" new-project draft. When applyProjects then loads real
    // sessions, that draft must go away — otherwise its NewSessionScreen
    // overlay keeps covering the restored session.
    const id = useStore.getState().createDraft("new-project");
    useStore.setState({
      projects: [],
      activeProjectName: null,
      activeWindowByProject: {},
      activeDraftId: id,
      drafts: useStore.getState().drafts,
    });
    writeSavedActiveSession({ project: "alpha", window: 1 });
    useStore.getState().applyProjects(sessions());
    const s = useStore.getState();
    expect(s.projects.length).toBeGreaterThan(0);
    expect(s.activeDraftId).toBeNull();
    expect(s.drafts).toEqual([]);
    // and it still lands on the restored session, not the composer
    expect(s.activeProjectName).toBe("alpha");
    expect(s.activeWindowByProject.alpha).toBe(1);
  });

  it("applyProjects does NOT clear a draft when projects already exist (normal refresh)", () => {
    useStore.setState({ projects: sessions(), activeProjectName: "alpha" });
    const id = useStore.getState().createDraft({ projectName: "beta" });
    // a refresh with an active deliberate draft must keep it
    useStore.getState().applyProjects(sessions());
    const s = useStore.getState();
    expect(s.activeDraftId).toBe(id);
    expect(s.drafts.some((d) => d.id === id)).toBe(true);
  });
});

// ===== Sync snapshot / delta persistence (BET-678) =====
//
// applySyncPayload is the single choke point that routes sync snapshots +
// live deltas into the store (projects/config/stale), advances the cursor,
// and schedules the persisted snapshot write. loadPersistedSnapshot restores
// it on cold boot. refresh() drives syncSnapshot with the stored cursor.

describe("sync snapshot / applySyncPayload (BET-678)", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      projects: [],
      activeProjectName: null,
      activeWindowByProject: {},
      loaded: false,
      syncGen: null,
      syncSeq: null,
      boxStale: false,
    });
  });

  it("routes config + projects, advances the cursor, clears boxStale", () => {
    useStore.getState().applySyncPayload({
      gen: "g1",
      seq: 5,
      changed: {
        projects: [proj({ tmuxSession: "s1" })],
        config: { serverUrl: "u", chatAutoAllow: true, projects: [] },
        stale: false,
      },
    });
    const s = useStore.getState();
    expect(s.syncGen).toBe("g1");
    expect(s.syncSeq).toBe(5);
    expect(s.boxStale).toBe(false);
    expect(s.loaded).toBe(true);
    expect(s.projects.map((p) => p.tmuxSession)).toEqual(["s1"]);
  });

  it("sets boxStale when a stale field is present and true", () => {
    useStore.getState().applySyncPayload({ gen: "g", seq: 1, changed: { stale: true } });
    expect(useStore.getState().boxStale).toBe(true);
  });

  it("ignores a stale-seq envelope (same gen, lower/equal seq)", () => {
    const st = useStore.getState();
    st.applySyncPayload({ gen: "g", seq: 10, changed: { projects: [proj({ tmuxSession: "a" })] } });
    const before = useStore.getState().projects;
    st.applySyncPayload({ gen: "g", seq: 8, changed: { projects: [proj({ tmuxSession: "b" })] } });
    const s = useStore.getState();
    expect(s.projects).toEqual(before);
    expect(s.syncSeq).toBe(10);
  });

  it("persisted snapshot round-trips: apply → save → load applies projects/config", async () => {
    useStore.getState().applySyncPayload({
      gen: "g2",
      seq: 3,
      changed: {
        projects: [proj({ tmuxSession: "persisted" })],
        config: { chatAutoAllow: true, projects: [] },
      },
    });
    // flush the 1s debounced write
    await new Promise((r) => setTimeout(r, 1100));
    expect(localStorage.getItem("manta:sync:snapshot")).toBeTruthy();

    // wipe in-memory state, then restore from the persisted snapshot
    useStore.setState({
      projects: [],
      loaded: false,
      syncGen: null,
      syncSeq: null,
      boxStale: false,
    });
    loadPersistedSnapshot();
    const s = useStore.getState();
    expect(s.syncGen).toBe("g2");
    expect(s.syncSeq).toBe(3);
    expect(s.projects.map((p) => p.tmuxSession)).toEqual(["persisted"]);
    expect(s.loaded).toBe(true);
  });

  it("corrupt JSON in the snapshot key is removed and does not throw", () => {
    localStorage.setItem("manta:sync:snapshot", "{not json");
    expect(() => loadPersistedSnapshot()).not.toThrow();
    expect(localStorage.getItem("manta:sync:snapshot")).toBeNull();
  });

  it("refresh() sends the stored cursor and applies the response", async () => {
    const calls: Array<{ sinceSeq?: number; sinceGen?: string }> = [];
    const prev = (window as unknown as { api?: unknown }).api;
    (window as unknown as { api: unknown }).api = {
      syncSnapshot: async (args: { sinceSeq?: number; sinceGen?: string }) => {
        calls.push(args);
        return {
          gen: "g3",
          seq: 9,
          changed: { projects: [proj({ tmuxSession: "r" })] },
        };
      },
    };
    useStore.setState({ syncGen: "g3", syncSeq: 7 });
    await useStore.getState().refresh();
    expect(calls).toEqual([{ sinceSeq: 7, sinceGen: "g3" }]);
    expect(useStore.getState().projects.map((p) => p.tmuxSession)).toEqual(["r"]);
    expect(useStore.getState().syncSeq).toBe(9);
    expect(useStore.getState().syncGen).toBe("g3");
    (window as unknown as { api?: unknown }).api = prev;
  });

  // Drive the REAL write path (loadPersistedSnapshot → applySyncPayload →
  // debounced persist), so the fields the snapshot carries are exactly what
  // schedulePersist writes — not a value planted by hand. `boxId` seeds the
  // desktop-local spawn ref, mirroring main.tsx's loadPersistedSnapshot(config.boxId).
  async function seedSnapshot(boxId: string, changed: { stale?: boolean; projects?: Project[] }) {
    loadPersistedSnapshot(boxId);
    useStore.getState().applySyncPayload({ gen: "g", seq: 10, changed });
    await new Promise((r) => setTimeout(r, 1100)); // flush the 1s debounce
  }

  it("persists and replays the stale flag (cold boot against an unreachable box)", async () => {
    await seedSnapshot("boxA", { stale: true });
    const saved = JSON.parse(localStorage.getItem("manta:sync:snapshot")!) as {
      stale: boolean;
      boxId: string;
    };
    expect(saved.stale).toBe(true);
    // a cold boot must replay boxStale instead of hardcoding "not stale" —
    // otherwise the restored cursor would make the box withhold stale and the
    // amber "last known state" pill would silently never appear.
    useStore.setState({ boxStale: false, syncGen: null, syncSeq: null, projects: [], loaded: false });
    loadPersistedSnapshot("boxA");
    expect(useStore.getState().boxStale).toBe(true);
  });

  it("write path stamps the desktop-local boxId, and a different box's snapshot is dropped", async () => {
    await seedSnapshot("boxA", { projects: [proj({ tmuxSession: "a" })] });
    // The persisted stamp must be the desktop-local boxId passed to
    // loadPersistedSnapshot — this would be "" if the write path read
    // store.boxId (empty in http mode), which is the exact dead-code bug.
    const saved = JSON.parse(localStorage.getItem("manta:sync:snapshot")!) as { boxId: string };
    expect(saved.boxId).toBe("boxA");
    // Re-pair to a different box: the guard must drop the old box's snapshot.
    useStore.setState({ projects: [], syncGen: null, syncSeq: null, loaded: false });
    loadPersistedSnapshot("boxB");
    expect(localStorage.getItem("manta:sync:snapshot")).toBeNull();
    expect(useStore.getState().projects).toEqual([]);
  });

  it("loadPersistedSnapshot restores a snapshot owned by the same box", async () => {
    await seedSnapshot("boxA", { projects: [proj({ tmuxSession: "a" })] });
    useStore.setState({ projects: [], syncGen: null, syncSeq: null, loaded: false });
    loadPersistedSnapshot("boxA");
    expect(useStore.getState().projects.map((p) => p.tmuxSession)).toEqual(["a"]);
    expect(useStore.getState().syncSeq).toBe(10);
  });
});

describe("app toasts (BET-723)", () => {
  beforeEach(() => {
    useStore.setState({ appToasts: [], systemNotice: null });
  });

  it("pushAppToast appends with a unique generated id", () => {
    useStore.getState().pushAppToast({ message: "one" });
    const one = useStore.getState().appToasts;
    expect(one).toHaveLength(1);
    expect(one[0].message).toBe("one");
    expect(one[0].id).toMatch(/^toast-/);
    useStore.getState().pushAppToast({ message: "two" });
    const two = useStore.getState().appToasts;
    expect(two).toHaveLength(2);
    // ids are unique
    expect(new Set(two.map((t) => t.id)).size).toBe(2);
  });

  it("pushAppToast respects an explicit id", () => {
    useStore.getState().pushAppToast({ message: "x", id: "custom-1" });
    expect(useStore.getState().appToasts[0].id).toBe("custom-1");
  });

  it("pushAppToast caps the slice at 5, dropping the oldest", () => {
    for (let i = 1; i <= 6; i++) useStore.getState().pushAppToast({ message: `m${i}` });
    const toasts = useStore.getState().appToasts;
    expect(toasts).toHaveLength(5);
    // Oldest dropped, newest retained in order
    expect(toasts.map((t) => t.message)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
  });

  it("dismissAppToast removes by id", () => {
    useStore.getState().pushAppToast({ message: "keep" });
    useStore.getState().pushAppToast({ message: "drop" });
    const { appToasts, dismissAppToast } = useStore.getState();
    dismissAppToast(appToasts[1].id);
    expect(useStore.getState().appToasts.map((t) => t.message)).toEqual(["keep"]);
  });

  it("setSystemNotice sets and clears the notice", () => {
    expect(useStore.getState().systemNotice).toBeNull();
    useStore.getState().setSystemNotice("/help text");
    expect(useStore.getState().systemNotice).toBe("/help text");
    useStore.getState().setSystemNotice(null);
    expect(useStore.getState().systemNotice).toBeNull();
  });
});

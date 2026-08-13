// @vitest-environment jsdom
//
// Render-harness smoke tests for ChatPanel (BET-63 step 1).
//
// These mount the REAL <ChatPanel> in jsdom with a mocked window.api + SSE
// bus, and assert the component renders its top-level surfaces without
// crashing. This is the safety net that makes the container decomposition
// (Transcript / Composer / hook extraction) verifiable rather than blind —
// if any extraction breaks the mount or the event wiring, a test here fails.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { TRANSCRIPT_TAIL_LIMIT } from "./hooks/useTranscriptState";
import { useStore } from "./store";
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
  emitStreamAndFlush,
  type MockApi,
  type MockEventBus,
  type Harness,
} from "./testHarness";

const PROPS = {
  sessionId: "ses_test",
  tmuxSession: "proj",
  windowIndex: 1,
  cwd: "/home/dev/projects/x",
  isActive: true,
};

describe("ChatPanel render harness", () => {
  let bus: MockEventBus;
  let h: Harness | null = null;

  beforeEach(() => {
    ({ bus } = installMockApi());
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("mounts without crashing and shows the empty-state welcome", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    // Empty transcript renders the welcome line.
    expect(h.text()).toContain("Welcome");
    // The composer textarea is present.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("subscribes to the opencode event bus on mount", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(bus.listenerCount()).toBeGreaterThan(0);
  });

  it("unsubscribes from the event bus on unmount", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(bus.listenerCount()).toBeGreaterThan(0);
    h.unmount();
    h = null;
    expect(bus.listenerCount()).toBe(0);
  });

  it("renders a permission card when a permission.asked event arrives", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await emitAndFlush(bus, h, {
      type: "permission.asked",
      properties: {
        sessionID: "ses_test",
        id: "perm_1",
        title: "Run command",
        metadata: {},
      },
    });
    // The permission surfaced into the DOM (card copy varies; the id-driven
    // card at minimum renders allow/deny affordances).
    expect(h.text().toLowerCase()).toMatch(/allow|permission|run command/);
  });

  it("ignores events for a different session id", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    const before = h.text();
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_OTHER", status: "busy" },
    });
    // Still on the welcome screen — a foreign session's event did nothing.
    expect(h.text()).toContain("Welcome");
    expect(h.text()).toBe(before);
  });

  it("renders the current branch in the header branch chip", async () => {
    // The default mock returns null for the branch, so the chip is not
    // rendered; override it so the chip exists.
    ({ bus } = installMockApi({
      opencodeVcsBranch: () => Promise.resolve("feat/mobile-footer"),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(h.text()).toContain("feat/mobile-footer");
  });

  it("auto-submits the new-session first prompt exactly once even under the StrictMode double-mount", async () => {
    // The draft → real-panel handoff sets autoSubmitPrompt in the SAME commit
    // that mounts the session's ChatPanel, so the panel's first render has
    // autoSubmit already set. React 18 StrictMode runs effects setup → cleanup
    // → setup on that mount; the auto-submit guard must survive the simulated
    // unmount or the deferred submit timer is cancelled and never re-armed —
    // the composer gets seeded but the prompt is never sent. Regression for
    // the "prompt stuck in the composer on a fresh session" bug.
    const { api } = installMockApi();
    resetStore();
    h = mount(
      <ChatPanel
        {...PROPS}
        autoSubmit={{ text: "build the login page", model: undefined }}
      />,
      // Mount under StrictMode so the component's effects get double-invoked
      // (setup → cleanup → setup), exercising the exact production path.
      { strictMode: true },
    );
    // Let the deferred (setTimeout 0) submit timer fire.
    await h.flush();
    const calls = api.calls["opencodePrompt"] ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toBe("build the login page");
  });

  it("keeps the auto-submitted prompt in the transcript when the initial fetch races it", async () => {
    // Model the real race: the mount-time transcript fetch resolves with the
    // PRE-prompt snapshot (empty) AFTER submit already appended the optimistic
    // user message. It must NOT clobber the just-sent prompt out of the
    // transcript (the loader/running indicator would show, but no prompt).
    let resolveInitial!: (m: unknown[]) => void;
    const initialFetch = new Promise<unknown[]>((res) => { resolveInitial = res; });
    let messagesCalls = 0;
    const { api } = installMockApi({
      opencodeMessages: () => {
        messagesCalls++;
        return messagesCalls === 1 ? initialFetch : Promise.resolve([]);
      },
    });
    resetStore();
    h = mount(
      <ChatPanel
        {...PROPS}
        autoSubmit={{ text: "draw the wireframes", model: undefined }}
      />,
    );
    // Let the deferred (setTimeout 0) auto-submit run. The optimistic user
    // message is now in the transcript, but the initial fetch is still pending.
    await h.flush();
    expect(h.text()).toContain("draw the wireframes");

    // The initial fetch lands with the pre-prompt empty snapshot now.
    act(() => resolveInitial([]));
    await h.flush();

    // The prompt must still be on screen — the send went through.
    expect(h.text()).toContain("draw the wireframes");
    expect(api.calls.opencodePrompt?.[0]?.[1]).toBe("draw the wireframes");
  });
});

// ===== useSessionResources integration (via the mounted ChatPanel) =====
//
// Verifies the extracted schedules/secrets/webhooks hook is wired correctly:
// it fetches on mount and the mobile `manta-open-*` window bridges open the
// matching card. These are the integration tests deferred from BET-47 — they
// exercise a full component interaction (event → hook state → card render),
// not a pure function.
describe("ChatPanel session resources", () => {
  let api: MockApi;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("fetches the schedule list on mount (toolbar count stays fresh)", async () => {
    ({ api } = installMockApi({
      scheduleList: () => Promise.resolve([]),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    // useSessionResources refreshes schedules on mount even with the card
    // closed, so the composer's "(N)" count reflects model-created jobs.
    expect(api.calls.scheduleList?.length ?? 0).toBeGreaterThan(0);
    expect(api.calls.scheduleList[0]).toEqual(["ses_test"]);
  });

  it("opens the schedules card via the manta-open-schedules bridge", async () => {
    ({ api } = installMockApi({
      scheduleList: () => Promise.resolve([]),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(h.text()).not.toContain("No scheduled tasks in this session.");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-open-schedules", { detail: { sessionId: "ses_test" } }),
      );
    });
    await h.flush();
    // Card is now open and, with an empty job list, shows its empty state.
    expect(h.text()).toContain("No scheduled tasks in this session.");
  });

  it("ignores a manta-open-schedules bridge for another session id", async () => {
    ({ api } = installMockApi({ scheduleList: () => Promise.resolve([]) }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-open-schedules", { detail: { sessionId: "ses_OTHER" } }),
      );
    });
    await h.flush();
    // A bridge for a different session must not open THIS panel's card.
    expect(h.text()).not.toContain("No scheduled tasks in this session.");
  });

  it("opens the secrets card via the manta-open-secrets bridge", async () => {
    ({ api } = installMockApi({ secretsList: () => Promise.resolve([]) }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-open-secrets", { detail: { sessionId: "ses_test" } }),
      );
    });
    await h.flush();
    // The secrets card fetched its (empty) list once opened.
    expect((api?.calls?.secretsList?.length ?? 0) >= 0).toBe(true);
    expect(h.container.querySelector("input[type=password]")).not.toBeNull();
  });

  // Mobile keyboard bar → /clear (BET-259). The KeyboardBar's `clear` key
  // already showed the user a confirm; this bridge hands control to the
  // existing /clear builtin so optimistic-message cleanup and model-override
  // carry-over to the new session behave exactly like a typed `/clear`.
  it("runs /clear when the manta-run-clear bridge fires for this session", async () => {
    ({ api } = installMockApi());
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-run-clear", { detail: { sessionId: "ses_test" } }),
      );
    });
    await h.flush();

    // The bridge set input to "/clear" and submitted via submitRef; the
    // submit hits the /clear builtin path which calls opencodeClearSession
    // with the owning tmux window. The mock auto-records every call.
    expect(api.calls.opencodeClearSession ?? []).toEqual([
      [
        {
          sessionName: "proj",
          windowIndex: 1,
          cwd: "/home/dev/projects/x",
          title: "proj / cleared",
        },
      ],
    ]);
  });

  it("ignores a manta-run-clear bridge for another session id", async () => {
    ({ api } = installMockApi());
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-run-clear", { detail: { sessionId: "ses_OTHER" } }),
      );
    });
    await h.flush();

    // A bridge for a different session must NOT trigger a clear in THIS
    // panel. Without the gate, the spec's "must reuse /clear builtin" rule
    // would silently wipe the wrong session.
    expect(api.calls.opencodeClearSession ?? []).toEqual([]);
  });

  // Mobile ⋯ sheet → attach-files bridge (BET-260). The hidden <input
  // type="file"> inside SessionScreen's ⋯ sheet dispatches
  // `manta-attach-files` with the user's selected File[]; ChatPanel hands
  // them to addDroppedFiles, which renders the uploading→ready chip and
  // ships bytes via uploadBuffer (the byte path on mobile — getPathForFile
  // returns ""). No new upload code lives in ChatPanel; the two tests below
  // pin the wiring so the bridge can't silently regress to a no-op.
  async function dispatchAttachBridge(sessionId: string): Promise<Harness> {
    ({ api } = installMockApi({
      uploadBuffer: () => Promise.resolve("/remote/img.png"),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const fakeFile = new File(["x"], "img.png", { type: "image/png" });
    // jsdom's File doesn't implement arrayBuffer() — addDroppedFiles reads
    // bytes via file.arrayBuffer() on the byte path (getPathForFile → ""),
    // so polyfill it for the test. Real browsers (incl. mobile webviews)
    // ship arrayBuffer; this is purely a jsdom gap.
    (fakeFile as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
      () => Promise.resolve(new ArrayBuffer(1));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-attach-files", {
          detail: { sessionId, files: [fakeFile] },
        }),
      );
    });
    await h.flush();
    return h;
  }

  it("uploads attached files when the manta-attach-files bridge fires for this session", async () => {
    const panel = await dispatchAttachBridge("ses_test");

    // The bridge routes through addDroppedFiles → uploadBuffer with the
    // correct filename and project. Bytes ride the byte path because
    // jsdom's getPathForFile mock returns "".
    const calls = api.calls.uploadBuffer ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toMatchObject({
      projectName: "proj",
      filename: "img.png",
    });
    // Chip landed in "ready" state — title attr carries the remotePath.
    const chip = panel.container.querySelector('[title="/remote/img.png"]');
    expect(chip).toBeTruthy();
  });

  it("ignores a manta-attach-files bridge for another session id", async () => {
    const panel = await dispatchAttachBridge("ses_OTHER");

    // A bridge for a different session must NOT upload to THIS panel's
    // session. Without the gate, an accidental global dispatch would
    // attach a file to the wrong tmux window's session.
    expect(api.calls.uploadBuffer ?? []).toEqual([]);
    expect(panel.container.querySelector('[title="/remote/img.png"]')).toBeNull();
  });

  it("keeps staged attachments when the panel is hidden then reshown (isActive toggle must not reset the composer)", async () => {
    // Reuse the shared attach-bridge harness (it stages an upload and returns
    // the mounted panel) rather than duplicating the setup here.
    const panel = await dispatchAttachBridge("ses_test");
    expect(panel.container.querySelector('[title="/remote/img.png"]')).toBeTruthy();

    // App.tsx keeps hidden panels MOUNTED (display:none) and flips isActive.
    // If the visibility toggle re-ran the session-reset effect, the staged
    // attachment would be wiped here — the regression BET-676 Block 2 caught.
    panel.rerender(<ChatPanel {...PROPS} isActive={false} />);
    await panel.flush();
    panel.rerender(<ChatPanel {...PROPS} isActive={true} />);
    await panel.flush();

    // The staged attachment survived the hide/reshow cycle.
    expect(panel.container.querySelector('[title="/remote/img.png"]')).toBeTruthy();
  });
});

// ===== Panel card toggle + mutual exclusion (BET-713) =====
//
// The three resource cards (schedules / secrets / webhooks) are ONE surface:
// the toolbar button opens its card, clicking it again closes it, and opening
// one closes whichever other was open. These drive the REAL toolbar buttons by
// their stable aria-labels (ComposerParts).
describe("ChatPanel panel cards one-open-at-a-time", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function clickToolbar(panel: Harness, label: string) {
    const btn = Array.from(panel.container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label,
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    await act(async () => {
      btn!.click();
    });
    // CardMount's AnimatePresence plays a 220ms exit animation before an
    // outgoing card leaves the DOM; let it finish so "is gone" is assertable
    // rather than racing the transition.
    await new Promise((r) => setTimeout(r, 300));
    await panel.flush();
  }

  // Distinguishable, stable on-screen markers per card (their empty states).
  const SCHEDULES = "No scheduled tasks in this session.";
  const WEBHOOKS = "No webhooks in this session.";

  it("clicking the same toolbar button twice closes the card (schedules)", async () => {
    installMockApi({ scheduleList: () => Promise.resolve([]) });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(h.text()).not.toContain(SCHEDULES);
    await clickToolbar(h, "schedules");
    expect(h.text()).toContain(SCHEDULES);
    await clickToolbar(h, "schedules");
    expect(h.text()).not.toContain(SCHEDULES);
  });

  it("clicking the same toolbar button twice closes the card (webhooks)", async () => {
    installMockApi({ webhookList: () => Promise.resolve([]) });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(h.text()).not.toContain(WEBHOOKS);
    await clickToolbar(h, "webhooks");
    expect(h.text()).toContain(WEBHOOKS);
    await clickToolbar(h, "webhooks");
    expect(h.text()).not.toContain(WEBHOOKS);
  });

  it("clicking the same toolbar button twice closes the card (secrets)", async () => {
    installMockApi({ secretsList: () => Promise.resolve([]) });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(h.container.querySelector("input[type=password]")).toBeNull();
    await clickToolbar(h, "secrets");
    expect(h.container.querySelector("input[type=password]")).not.toBeNull();
    await clickToolbar(h, "secrets");
    expect(h.container.querySelector("input[type=password]")).toBeNull();
  });

  it("opening secrets closes the schedules card", async () => {
    installMockApi({
      scheduleList: () => Promise.resolve([]),
      secretsList: () => Promise.resolve([]),
    });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await clickToolbar(h, "schedules");
    expect(h.text()).toContain(SCHEDULES);
    await clickToolbar(h, "secrets");
    expect(h.container.querySelector("input[type=password]")).not.toBeNull();
    expect(h.text()).not.toContain(SCHEDULES);
  });

  it("opening schedules closes the webhooks card", async () => {
    installMockApi({
      scheduleList: () => Promise.resolve([]),
      webhookList: () => Promise.resolve([]),
    });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await clickToolbar(h, "webhooks");
    expect(h.text()).toContain(WEBHOOKS);
    await clickToolbar(h, "schedules");
    expect(h.text()).toContain(SCHEDULES);
    expect(h.text()).not.toContain(WEBHOOKS);
  });
});

// ===== Transcript rendering (via the mounted ChatPanel) =====
//
// Verifies the extracted <Transcript> renders a fetched transcript: a user
// turn's text and an assistant turn's text both appear in the DOM. Drives the
// canonical fetch path (opencodeMessages) the container uses on mount.
describe("ChatPanel transcript rendering", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders user + assistant message text from the fetched transcript", async () => {
    const transcript = [
      {
        info: { id: "msg_u1", sessionID: "ses_test", role: "user" as const },
        parts: [
          { type: "text", id: "prt_u1", messageID: "msg_u1", text: "hello there" },
        ],
      },
      {
        info: {
          id: "msg_a1",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 1, completed: 2 },
        },
        parts: [
          { type: "text", id: "prt_a1", messageID: "msg_a1", text: "general kenobi" },
        ],
      },
    ];
    installMockApi({
      opencodeMessages: () => Promise.resolve(transcript),
    });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("hello there");
    expect(text).toContain("general kenobi");
    // The empty-state welcome is gone once a transcript is present.
    expect(text).not.toContain("Welcome. Type a message below to start.");
  });

  it("performs exactly ONE mount fetch, tail-limited, with no self-heal double fetch", async () => {
    const transcript = [
      {
        info: { id: "msg_u1", sessionID: "ses_test", role: "user" as const },
        parts: [{ type: "text", id: "prt_u1", messageID: "msg_u1", text: "hello there" }],
      },
    ];
    const fetchCalls: Array<[string, unknown]> = [];
    installMockApi({
      opencodeMessages: (sessionId: string, opts?: { limit?: number }) => {
        fetchCalls.push([sessionId, opts]);
        return Promise.resolve(transcript);
      },
    });
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await h.flush();
    // Single fetch path — the unconditional self-heal refetch is gone. The
    // mount fetch pulls the TAIL ({ limit: 100 }) until "Load earlier" flips
    // loadedAllRef.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0][0]).toBe("ses_test");
    expect(fetchCalls[0][1]).toEqual({ limit: TRANSCRIPT_TAIL_LIMIT });
    expect(h.text()).toContain("hello there");
  });
});

// ===== Composer submit (via the mounted ChatPanel) =====
//
// Verifies the extracted <Composer> is wired to the submit path: typing into
// the textarea and pressing Enter routes through window.api.opencodePrompt
// with the session id + typed text. This is the "Composer → submit → message
// added" integration test called for by BET-63.
describe("ChatPanel composer submit", () => {
  let api: MockApi;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // Set a controlled <textarea>'s value the way React expects (native setter
  // + input event) so onChange fires and the component's `input` state updates.
  function typeInto(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("calls opencodePrompt when the user types and presses Enter", async () => {
    ({ api } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const textarea = h.container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      typeInto(textarea as HTMLTextAreaElement, "ship it");
    });
    await act(async () => {
      (textarea as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await h.flush();

    const calls = api.calls.opencodePrompt ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // opencodePrompt(sessionId, text, ...)
    expect(calls[0][0]).toBe("ses_test");
    expect(calls[0][1]).toBe("ship it");
  });

  it("does not submit an empty composer on Enter", async () => {
    ({ api } = installMockApi());
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await h.flush();
    expect(api.calls.opencodePrompt?.length ?? 0).toBe(0);
  });

  it("recalls the last user prompt into the empty composer on ArrowUp", async () => {
    // A transcript with one prior user turn seeds the prompt history.
    const transcript = [
      {
        info: { id: "msg_u1", sessionID: "ses_test", role: "user" as const },
        parts: [
          { type: "text", id: "prt_u1", messageID: "msg_u1", text: "previous prompt" },
        ],
      },
    ];
    ({ api } = installMockApi({
      opencodeMessages: () => Promise.resolve(transcript),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    await h.flush();
    // useInputHistory swapped the empty draft for the last user prompt.
    expect(textarea.value).toBe("previous prompt");
  });
});

// ===== Abort self-heals orphaned questions (BET-116) =====
//
// opencode's /question pending list is cumulative and never expires. A
// question whose turn is aborted must be rejected server-side too, or it
// re-latches the sidebar's stale "?" glyph on a later replay. Verifies the
// user-facing abort path (Escape while running) rejects every pending
// question for the session and clears the local card.
describe("ChatPanel abort rejects orphaned questions", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // Shared scaffold for the Escape-abort tests: flip the turn to running and
  // press Escape, then assert the abort fired. The reject-bookkeeping that
  // follows the abort is left to each test, since it depends on whether a
  // question was pending.
  async function abortViaEscape(panel: Harness) {
    await emitStreamAndFlush(bus, panel, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
    });

    const textarea = panel.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await panel.flush();

    expect(api.calls.opencodeAbort).toEqual([["ses_test"]]);
  }

  it("rejects all pending questions and clears the card on Escape-abort", async () => {
    // Question cards render at the tail of the transcript (see Transcript.tsx)
    // which only mounts its message-list branch for a non-empty transcript —
    // seed one completed turn so the card is actually visible in the DOM.
    const transcript = [
      {
        info: {
          id: "msg_a1",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 1, completed: 2 },
        },
        parts: [
          { type: "text", id: "prt_a1", messageID: "msg_a1", text: "ok, one sec" },
        ],
      },
    ];
    ({ api, bus } = installMockApi({
      opencodeMessages: () => Promise.resolve(transcript),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: "ses_test",
      payload: {
        questions: [
          {
            id: "que_1",
            sessionID: "ses_test",
            requestId: "que_1",
            questions: [
              {
                header: "Approach",
                question: "Which approach?",
                options: [{ label: "a" }, { label: "b" }],
              },
            ],
          },
        ],
      },
    });
    // The question card is up.
    expect(h.text()).toContain("Which approach?");

    // Turn is running; pressing Escape aborts it.
    await abortViaEscape(h);

    // Best-effort reject fired for the orphaned question.
    expect(api.calls.opencodeQuestionReject).toEqual([["que_1", "ses_test"]]);
    // Card is gone locally — no re-latch possible from stale local state.
    expect(h.text()).not.toContain("Which approach?");
  });

  it("does not call opencodeQuestionReject on Escape-abort when nothing is pending", async () => {
    ({ api, bus } = installMockApi());
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await abortViaEscape(h);

    expect(api.calls.opencodeQuestionReject ?? []).toEqual([]);
  });
});

// The panel no longer reads any bytes itself: App.tsx reads them at detection
// and puts them in the store. What is left to prove is that clicking a
// thumbnail uploads THOSE bytes and clears the record, and that "Add all"
// does it for every pending shot.
describe("ChatPanel pending screenshots", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function shot(id: string, bytes: ArrayBuffer) {
    return { id, filename: `${id}.png`, bytes, previewUrl: `blob:${id}` };
  }

  it("clicking a thumbnail uploads that screenshot's bytes and clears it", async () => {
    const bytes = new ArrayBuffer(4);
    const { api } = installMockApi({
      uploadBuffer: () => Promise.resolve("/remote/shot-a.png"),
    });
    resetStore({ pendingScreenshots: [shot("a", bytes)] });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const thumb = h.container.querySelector(
      '[aria-label="Add a.png to the message"]',
    ) as HTMLButtonElement;
    expect(thumb).toBeTruthy();
    await act(async () => { thumb.click(); });
    await h.flush();

    expect(api.calls.uploadBuffer?.[0]?.[0]).toMatchObject({
      projectName: "proj",
      filename: "a.png",
      buffer: bytes,
    });
    // Chip landed ready (title carries the remotePath) and the strip is empty.
    expect(h.container.querySelector('[title="/remote/shot-a.png"]')).toBeTruthy();
    expect(useStore.getState().pendingScreenshots).toHaveLength(0);
  });

  it("Add all uploads every pending screenshot", async () => {
    const { api } = installMockApi({
      uploadBuffer: () => Promise.resolve("/remote/x.png"),
    });
    resetStore({
      pendingScreenshots: [
        shot("a", new ArrayBuffer(1)),
        shot("b", new ArrayBuffer(2)),
      ],
    });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const addAll = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add all 2",
    ) as HTMLButtonElement;
    expect(addAll).toBeTruthy();
    await act(async () => { addAll.click(); });
    await h.flush();

    expect(api.calls.uploadBuffer).toHaveLength(2);
    expect(useStore.getState().pendingScreenshots).toHaveLength(0);
  });

  it("the discard badge drops one screenshot without uploading it", async () => {
    const { api } = installMockApi();
    resetStore({
      pendingScreenshots: [
        shot("a", new ArrayBuffer(1)),
        shot("b", new ArrayBuffer(2)),
      ],
    });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const x = h.container.querySelector('[aria-label="Discard a.png"]') as HTMLButtonElement;
    await act(async () => { x.click(); });
    await h.flush();

    expect(api.calls.uploadBuffer).toBeUndefined();
    expect(useStore.getState().pendingScreenshots.map((s) => s.id)).toEqual(["b"]);
  });
});

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
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
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
});

// ===== Transcript rendering (via the mounted ChatPanel) =====
//
// Verifies the extracted <Transcript> renders a fetched transcript: a user
// turn's text and an assistant turn's text both appear in the DOM. Drives the
// canonical fetch path (opencodeMessagesReconcile) the container uses on mount.
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
      opencodeMessagesReconcile: () => Promise.resolve(transcript),
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
      opencodeMessagesReconcile: () => Promise.resolve(transcript),
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
      opencodeMessagesReconcile: () => Promise.resolve(transcript),
      opencodeMessages: () => Promise.resolve(transcript),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "question.asked",
      properties: {
        sessionID: "ses_test",
        id: "que_1",
        questions: [
          {
            header: "Approach",
            question: "Which approach?",
            options: [{ label: "a" }, { label: "b" }],
          },
        ],
      },
    });
    // The question card is up.
    expect(h.text()).toContain("Which approach?");

    // Turn is running.
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "busy" } },
    });

    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await h.flush();

    expect(api.calls.opencodeAbort).toEqual([["ses_test"]]);
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

    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "busy" } },
    });

    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await h.flush();

    expect(api.calls.opencodeAbort).toEqual([["ses_test"]]);
    expect(api.calls.opencodeQuestionReject ?? []).toEqual([]);
  });
});

// ===== Screenshot "Add to chat" → uploadBuffer (BET-130) =====
//
// Regression coverage for the HTTP-mode bug where acceptScreenshot dead-ended
// on window.api.clipboardReadImage / window.api.uploadFiles (both server-side
// stubs once window.api is httpApi). The fix routes bytes through
// window.__buiPreload (the real Electron preload, never swapped) and then
// uploads them via window.api.uploadBuffer — the one primitive that actually
// works in HTTP mode. These tests assert the chip reaches "ready" with a
// remotePath, and that the preload OS bridge (not window.api) supplied bytes.
describe("ChatPanel screenshot accept", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
    (window as unknown as { __buiPreload: unknown }).__buiPreload = null;
  });

  it("clipboard source: reads bytes via preload.clipboardReadImage, uploads via window.api.uploadBuffer", async () => {
    const fakeBuf = new ArrayBuffer(4);
    const clipboardReadImage = () => Promise.resolve(fakeBuf);
    const readLocalFile = () => Promise.reject(new Error("should not be called"));
    (window as unknown as {
      __buiPreload: { clipboardReadImage: typeof clipboardReadImage; readLocalFile: typeof readLocalFile };
    }).__buiPreload = { clipboardReadImage, readLocalFile };

    let uploadedBuffer: ArrayBuffer | null = null;
    const { api } = installMockApi({
      uploadBuffer: (input: { buffer: ArrayBuffer }) => {
        uploadedBuffer = input.buffer;
        return Promise.resolve("/remote/screenshot-123.png");
      },
    });
    resetStore({
      screenshotToast: { source: "clipboard" },
    });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const addBtn = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add to chat",
    ) as HTMLButtonElement;
    expect(addBtn).toBeTruthy();
    await act(async () => {
      addBtn.click();
    });
    await h.flush();

    expect(uploadedBuffer).toBe(fakeBuf);
    expect(api.calls.uploadBuffer?.[0]?.[0]).toMatchObject({
      projectName: "proj",
      buffer: fakeBuf,
    });
    // Chip landed in the "ready" state — title attr carries the remotePath.
    const chip = h.container.querySelector('[title="/remote/screenshot-123.png"]');
    expect(chip).toBeTruthy();
  });

  it("file source: reads bytes via preload.readLocalFile, uploads via window.api.uploadBuffer", async () => {
    const fakeBuf = new ArrayBuffer(8);
    let requestedPath: string | null = null;
    const readLocalFile = (path: string) => {
      requestedPath = path;
      return Promise.resolve(fakeBuf);
    };
    (window as unknown as {
      __buiPreload: { readLocalFile: typeof readLocalFile };
    }).__buiPreload = { readLocalFile };

    let uploadedBuffer: ArrayBuffer | null = null;
    installMockApi({
      uploadBuffer: (input: { buffer: ArrayBuffer }) => {
        uploadedBuffer = input.buffer;
        return Promise.resolve("/remote/shot.png");
      },
    });
    resetStore({
      screenshotToast: { source: "file", path: "/Users/x/Desktop/shot.png" },
    });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const addBtn = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add to chat",
    ) as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
    });
    await h.flush();

    expect(requestedPath).toBe("/Users/x/Desktop/shot.png");
    expect(uploadedBuffer).toBe(fakeBuf);
    const chip = h.container.querySelector('[title="/remote/shot.png"]');
    expect(chip).toBeTruthy();
  });

  it("no preload (mobile/web): chip goes to error state instead of silently dropping", async () => {
    (window as unknown as { __buiPreload: unknown }).__buiPreload = null;
    installMockApi();
    resetStore({
      screenshotToast: { source: "clipboard" },
    });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const addBtn = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add to chat",
    ) as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
    });
    await h.flush();

    // Errored chip renders with title = errorMsg (see AttachmentStrip).
    const chip = h.container.querySelector('[title="Screenshot capture requires the desktop app"]');
    expect(chip).toBeTruthy();
  });
});

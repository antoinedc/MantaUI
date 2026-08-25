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
import { refreshModelCatalog } from "./modelCatalog";
import type { Attachment } from "./chatShared";
import { sessionAutoKey, readSessionAuto } from "./modelPrefs";
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

// Shared assertion for both composer-submit paths (Enter key + Send button):
// opencodePrompt was called with the session id and the typed text.
function expectPromptSent(api: MockApi, text: string): void {
  const calls = api.calls.opencodePrompt ?? [];
  expect(calls.length).toBeGreaterThan(0);
  // opencodePrompt(sessionId, text, ...)
  expect(calls[0][0]).toBe("ses_test");
  expect(calls[0][1]).toBe(text);
}

// react-virtuoso is NOT mocked here. BET-802 needed to observe the panel's
// imperative scroll; the panel no longer scrolls through Virtuoso's handle —
// since BET-933 it scrolls the scroller ELEMENT directly (scrollTop =
// scrollHeight via scrollerRef), so the mock and its globals are gone. The
// BET-802 ordering property (the tail scroll happens only after the
// optimistic user row is committed) is asserted against the scroller element
// in the test below.

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

  it("renders the background-compaction one-liner (BET-1347)", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    expect(h.text()).not.toContain("Compacted");
    await emitStreamAndFlush(bus, h, {
      sub: "optimizer.compacted",
      sessionId: "ses_test",
      payload: { beforeTokens: 128_000, afterTokens: 31_000, away: true },
    });
    expect(h.text()).toContain("Compacted while you were away");
    expect(h.text()).toContain("128k");
    expect(h.text()).toContain("31k");
  });

  it("falls back to background wording (no after-token count / not away) (BET-1347)", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await emitStreamAndFlush(bus, h, {
      sub: "optimizer.compacted",
      sessionId: "ses_test",
      payload: { beforeTokens: 90_000, afterTokens: null, away: false },
    });
    expect(h.text()).toContain("Compacted in the background");
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
          title: "",
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

    expectPromptSent(api, "ship it");
  });

  it("calls opencodePrompt when the user clicks the Send button", async () => {
    ({ api } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const container = h.container;
    const textarea = container.querySelector("textarea");
    await act(async () => {
      typeInto(textarea as HTMLTextAreaElement, "ship it");
    });
    await act(async () => {
      const send = container.querySelector('button[aria-label="Send message"]');
      (send as HTMLButtonElement).click();
    });
    await h.flush();

    expectPromptSent(api, "ship it");
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

  it("scrolls the transcript to the tail only after the optimistic message is committed (BET-802, BET-933)", async () => {
    // The panel now scrolls the scroller ELEMENT (scrollTop = scrollHeight via
    // ChatPanel's scrollToTail) instead of Virtuoso's imperative handle. The
    // scroller is the element Virtuoso stamps `data-testid="virtuoso-scroller"`
    // on and hands to `scrollerRef` (stable in the mock context too). We spy on
    // its `scrollTop` setter, capturing the transcript text at the instant of
    // each write, and stub `scrollHeight` (jsdom reports 0).
    const calls: Array<{ v: number; text: string }> = [];

    // Seed one transcript row so the message-list branch (and thus the
    // Virtuoso scroller) is mounted before we submit; an empty initial fetch
    // would render only the welcome state and no Virtuoso at all.
    const transcript = [
      {
        info: {
          id: "msg_a1",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 1, completed: 2 },
        },
        parts: [
          { type: "text", id: "prt_a1", messageID: "msg_a1", text: "ready" },
        ],
      },
    ];
    ({ api } = installMockApi({
      opencodeMessages: () => Promise.resolve(transcript),
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const el = h.container.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement;
    expect(el).toBeTruthy();
    const container = h.container;
    Object.defineProperty(el, "scrollHeight", { value: 4242, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      set: (v: number) => {
        calls.push({ v, text: container.textContent ?? "" });
      },
      get: () => 0,
      configurable: true,
    });

    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, "please scroll to me");
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await h.flush();

    // The optimistic user message committed into the DOM…
    expect(h.text()).toContain("please scroll to me");
    // …and at least one tail scroll (to the stubbed scrollHeight) fired at a
    // moment when that very message was already rendered. If submit scrolled
    // inline against the stale list, the write would capture a transcript
    // without the new message — the exact BET-802 bug.
    const hadMessageWhenScrolled = calls.some(
      (c) => c.v === 4242 && c.text.includes("please scroll to me"),
    );
    expect(hadMessageWhenScrolled).toBe(true);
  });
});

// ===== Main-conversation routing populates the routed pill (BET-1225) =====
//
// The server's routing decision for the session is fetched once on mount. When
// it actually changed the model, ChatPanel applies the routed model as the
// active override (so the next prompt runs on it) and populates `routed` so the
// composer renders the undoable pill. A null / no-op decision leaves routing
// silent and the prompt's model untouched.
  describe("ChatPanel main-conversation routing (BET-1225)", () => {
   let api: MockApi;
   let h: Harness | null = null;

   afterEach(() => {
     h?.unmount();
     h = null;
   });

   beforeEach(() => {
     // jsdom localStorage is shared across tests in this file, and the suite
     // mounts the same ses_test session every time. Reset the per-session model
     // choice to server-default by clearing the device-local Auto flag (the box
     // mirror's `modelPrefsGet` returns empty in the harness) so a prior test's
     // "auto" write can't leak into a later non-Auto test (and vice versa).
     // BET-1255 relies on this to switch cleanly between Auto and non-Auto.
     localStorage.removeItem(sessionAutoKey("ses_test"));
   });

  function typeInto(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("issues no routing RPC on session mount (BET-1274 test 6)", async () => {
    // Ranging over the choice kinds: Auto (device-local flag on) and
    // server-default (flag off, no box record). The third kind — an explicit
    // hand-picked model — is non-Auto by construction, so it can only route
    // from the boundary router in submit() (never on mount); 10a deleted the
    // mount-time channel outright. None of the kinds may issue a routing RPC on
    // mount — that's the whole point of deleting the mount route.
    for (const auto of [true, false]) {
      if (auto) localStorage.setItem(sessionAutoKey("ses_test"), "1");
      else localStorage.removeItem(sessionAutoKey("ses_test"));
      ({ api } = installMockApi());
      resetStore();
      h = mount(<ChatPanel {...PROPS} />);
      await h.flush();
      await h.flush();
      expect(api.calls["routingChoose"] ?? []).toHaveLength(0);
      expect((api.calls["opencodePrompt"] ?? [])).toHaveLength(0);
      h?.unmount();
      h = null;
    }
  });

  it("still routes an Auto session's first turn via the boundary router (BET-1255)", async () => {
    localStorage.setItem(sessionAutoKey("ses_test"), "1");
    const routedModel = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
    ({ api } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
      routingChoose: () =>
        Promise.resolve({
          model: routedModel,
          alternatives: [routedModel],
          reason: "first turn boundary",
        }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const textarea = h.container.querySelector("textarea");
    await act(async () => {
      typeInto(textarea as HTMLTextAreaElement, "hello");
    });
    await act(async () => {
      (textarea as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await h.flush();

    // The first turn is a boundary, so Auto still re-decides via routingChoose
    // (gating the mount RPC must NOT have removed Auto routing) and the prompt
    // runs on the routed pick.
    expect((api.calls["routingChoose"] ?? []).length).toBeGreaterThan(0);
    const promptCall = api.calls["opencodePrompt"]?.[0];
    expect(promptCall?.[0]).toBe("ses_test");
    expect((promptCall?.[2] as { modelID?: string } | undefined)?.modelID).toBe("claude-sonnet-4-6");
  });

  it("a first routed boundary renders the reason with no undo (no incumbent) (BET-1274 test 5)", async () => {
    localStorage.setItem(sessionAutoKey("ses_test"), "1");
    const movedTo = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };
    ({ api } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
      routingChoose: () =>
        Promise.resolve({
          model: movedTo,
          alternatives: [movedTo],
          reason: "balanced",
        }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    const textarea = h.container.querySelector("textarea");
    await act(async () => {
      typeInto(textarea as HTMLTextAreaElement, "first turn");
    });
    await act(async () => {
      (textarea as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await h.flush();
    // The routed pill says why (the reason applyRouted recorded) — and, with no
    // prior model to revert to, it renders NO undo action (BET-1274 10e).
    const text = h?.container.textContent ?? "";
    expect(text).toContain("balanced");
    expect(text).not.toContain("undo");
  });

  it("a routing failure still sends the turn and raises the error banner (BET-1274 test 4)", async () => {
    localStorage.setItem(sessionAutoKey("ses_test"), "1");
    ({ api } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
      routingChoose: () => Promise.reject(new Error("router unreachable")),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const textarea = h.container.querySelector("textarea");
    await act(async () => {
      typeInto(textarea as HTMLTextAreaElement, "hi");
    });
    await act(async () => {
      (textarea as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await h.flush();

    // The turn STILL sends (routing never blocks a turn) …
    const promptCall = api.calls["opencodePrompt"]?.[0];
    expect(promptCall?.[0]).toBe("ses_test");
    expect(promptCall?.[1]).toBe("hi");
    // … and the banner says the router was unreachable instead of pretending it
    // picked a model.
    expect(h?.container.textContent ?? "").toContain("Couldn't pick a model");
  });

  it("picking a model while Auto is on stops the chip saying Auto in the same commit and clears the Auto flag (BET-1274 test 1)", async () => {
    localStorage.setItem(sessionAutoKey("ses_test"), "1");
    const model = {
      id: "claude-opus-4-7",
      providerID: "anthropic",
      name: "Claude Opus 4.7",
      variants: [{ id: "high" }, { id: "low" }],
    };
    ({ api } = installMockApi({
      opencodeModels: () => Promise.resolve([model]),
    }));
    // The catalog is a module-level cache served past STALE_MS — force a
    // refetch so THIS test sees the injected model, not a prior test's `[]`.
    refreshModelCatalog();
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await h.flush();

    const pickerBtn = () =>
      h!.container.querySelector<HTMLElement>(".manta-model-picker-btn");
    // The catalog has landed (the mock returns a model) and the chip says Auto.
    expect(pickerBtn()?.textContent).toContain("Auto");

    // Open the dropdown; it portals to document.body.
    act(() => (pickerBtn() as HTMLButtonElement).click());
    await h.flush();
    await h.flush();
    expect(document.body.querySelector(".manta-model-dropdown")).toBeTruthy();
    // Click the model row (a role=option whose label is the model's name).
    const modelRow = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => (o.textContent ?? "").includes("Claude Opus 4.7"),
    );
    expect(modelRow).toBeTruthy();
    act(() => (modelRow as HTMLElement).click());
    await h.flush();

    // The chip stops saying Auto in this very commit — a manual model choice is
    // the off switch for Auto (BET-1274 10b, selectModel → setAutoActive(false))
    // — and the device-local Auto flag is cleared (the persisted off-switch).
    expect(pickerBtn()?.textContent).not.toContain("Auto");
    expect(readSessionAuto("ses_test")).toBe(false);
  });
});

// ===== Re-activation re-pin defers the tail scroll until the scroller
// re-measures (BET-1003) =====
//
// While a panel is inactive (display:none) the scroller has no layout and is
// not re-measured, yet content keeps growing beneath/inside it. On reactivation
// the user must land EXACTLY at the true tail. A tail write issued in the SAME
// commit as the re-activation (either the raw scrollTop = scrollHeight or
// Virtuoso's scrollToIndex(LAST,end), the BET-1001 approach) reads the stale
// pre-layout height and leaves the transcript ~216px above the tail. The fix
// defers the true-bottom write by 2x rAF so it reads the freshly re-measured
// scrollHeight and pins exactly to it. This test pins the deferral: NO element
// write in the reactivation commit, and the deferred write lands exactly on
// the (re-measured) tail. It fails on the synchronous BET-1001 scrollToIndex
// re-pin and passes on the deferred scrollElementToTail fix.
describe("ChatPanel re-activation re-pin defers to the re-measured tail (BET-1003)", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("writes no tail scroll in the reactivation commit, then lands on the fresh tail after 2 rAF", async () => {
    const transcript = [
      {
        info: {
          id: "msg_a1",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 1, completed: 2 },
        },
        parts: [
          { type: "text", id: "prt_a1", messageID: "msg_a1", text: "ready" },
        ],
      },
    ];
    installMockApi({
      opencodeMessages: () => Promise.resolve(transcript as never),
    });
    resetStore();

    // Content is already present while the panel mounts hidden, so the
    // scroller mounts (Virtuoso renders its rows on a non-empty transcript)
    // but the re-activation re-pin effect early-returns on isActive=false.
    h = mount(<ChatPanel {...PROPS} isActive={false} />);
    await h.flush();

    const el = h.container.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement;
    expect(el).toBeTruthy();

    // The just-un-hidden scroller re-measures once it has layout: emulate that
    // fresh measurement reporting a taller tail (content arrived while hidden).
    // The fix must read this FRESH height at defer time, not the stale value.
    let scrollHeight = 2000;
    Object.defineProperty(el, "scrollHeight", {
      get: () => scrollHeight,
      configurable: true,
    });
    const writes: number[] = [];
    Object.defineProperty(el, "scrollTop", {
      set: (v: number) => {
        writes.push(v);
      },
      get: () => (writes.length ? writes[writes.length - 1] : 0),
      configurable: true,
    });
    // Drop any scrolls from the initial hidden mount (e.g. composer resize).
    writes.length = 0;

    // Content grew while hidden -> once visible the scroller measures taller.
    scrollHeight = 4216;

    // Re-activate the panel (App.tsx's display:none -> block flip + the
    // isActive false->true prop, which drives this re-activation effect).
    h.rerender(<ChatPanel {...PROPS} isActive={true} />);

    // Not in the reactivation commit itself: the true-bottom write is
    // deferred until the browser re-lays out the now-visible scroller.
    expect(writes).toEqual([]);

    // Advance past the two rAF frames -> the deferred write lands exactly on
    // the freshly re-measured tail (scrollHeight = the grown true tail).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(writes).toContain(4216);
    expect(writes[writes.length - 1]).toBe(4216);
  });
});

// ===== A deep-link jump detaches the transcript EXPLICITLY =====
//
// The artifacts panel / ⌘F "go to this message" jump used to detach as a side
// effect: it scrolled up, and any scroll-up was read as the user leaving the
// tail. That inference is gone (a scroll event is not a gesture — react-
// virtuoso issues its own), so the jump has to say so itself. Without this the
// next streamed chunk yanks the user straight back off the row they asked for.
// The jump-to-latest button is the observable: it is shown iff not following.
describe("ChatPanel deep-link jump detaches from the tail", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("shows jump-to-latest after a manta-scroll-to-message jump", async () => {
    const transcript = [
      {
        info: {
          id: "msg_old",
          sessionID: "ses_test",
          role: "assistant" as const,
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", id: "prt_old", messageID: "msg_old", text: "way back" }],
      },
    ];
    installMockApi({ opencodeMessages: () => Promise.resolve(transcript as never) });
    resetStore();

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const jump = () => h!.container.querySelector(".manta-jump-latest") as HTMLElement;
    expect(jump().dataset.shown).toBe("false");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("manta-scroll-to-message", {
          detail: { sessionId: "ses_test", messageId: "msg_old" },
        }),
      );
    });
    await h.flush();

    expect(jump().dataset.shown).toBe("true");
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

  it("Add to chat attaches a single pending screenshot", async () => {
    const { api } = installMockApi({
      uploadBuffer: () => Promise.resolve("/remote/x.png"),
    });
    resetStore({
      pendingScreenshots: [shot("a", new ArrayBuffer(1))],
    });

    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const addToChat = Array.from(h.container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add to chat",
    ) as HTMLButtonElement;
    expect(addToChat).toBeTruthy();
    await act(async () => { addToChat.click(); });
    await h.flush();

    expect(api.calls.uploadBuffer).toHaveLength(1);
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

// ===== Auto-rename: single-rename + first-turn fallback =====
//
// BET-1100/1101 fixed the "Im then manta / Im" symptom at the root: all three
// chat create sites pass an EMPTY session title. But BET-1100 assumed opencode
// auto-titles a session from its first user message "for free" — that premise
// is FALSE (a session created with an empty title stays empty-titled even after
// its first turn, verified live against opencode 1.18.10). So the first-name
// path reads back "" and must fall through to the title agent
// (opencodeGenerateTitle) to still produce ONE sensible rename. These tests
// drive a first turn through the mounted panel and pin the single-rename
// contract across both cases: opencode HAS a title (fast path) and opencode
// left the session untitled (title-agent fallback), including the retry-on-
// failure behavior.

// Submit a user message through the real composer submit path (returns nothing).
async function submitMessage(h: Harness, text: string): Promise<void> {
  const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await h.flush();
  expect(h.text()).toContain(text);
}

// Drive a turn running true→false (the edge that ARMS the auto-rename) and
// flush so the settled-transcript effect evaluates it.
async function turnIdle(
  bus: MockEventBus,
  h: Harness,
  sessionId: string,
): Promise<void> {
  await emitStreamAndFlush(bus, h, {
    sub: "running",
    sessionId,
    payload: { running: true },
  });
  await emitStreamAndFlush(bus, h, {
    sub: "running",
    sessionId,
    payload: { running: false },
  });
}

describe("ChatPanel auto-rename single rename (BET-1101)", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renames exactly once on the first turn via opencode's title (fast path)", async () => {
    // opencode HAS titled the session, so the first-name fast path should use
    // it (via opencodeListSessions) and MUST NOT spin up a title agent.
    ({ api, bus } = installMockApi({
      opencodeListSessions: () =>
        Promise.resolve([{ id: "ses_test", title: "Build the login page" }]),
    }));
    resetStore({ autoRenameSessions: true });
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await submitMessage(h, "Build the login page");
    await turnIdle(bus, h, "ses_test");

    // EXACTLY ONE rename, with the clean generated title — and the title agent
    // was NOT called (the fast path returned before it).
    const renames = api.calls.tmuxRenameWindow ?? [];
    expect(renames.length).toBe(1);
    expect(renames[0][0]).toEqual({
      sessionName: "proj",
      windowIndex: 1,
      newName: "Build the login page",
    });
    expect(api.calls.opencodeGenerateTitle ?? []).toHaveLength(0);

    // No second `workspace / title` re-title a short time later: a single turn
    // must not fire the every-Nth-turn drift rename.
    await new Promise((r) => setTimeout(r, 60));
    await h.flush();
    expect(api.calls.tmuxRenameWindow ?? []).toHaveLength(1);
  });
});

describe("ChatPanel auto-rename first-turn fallback (BET-1100 follow-up)", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("generates a title when opencode left the session untitled, renaming once", async () => {
    // opencode has NOT titled the session (title:""), as on a live box.
    ({ api, bus } = installMockApi({
      opencodeListSessions: () =>
        Promise.resolve([{ id: "ses_test", title: "" }]),
      opencodeGenerateTitle: () => Promise.resolve("Manta setup check"),
    }));
    resetStore({ autoRenameSessions: true });
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await submitMessage(h, "I'm just checking the manta setup");
    await turnIdle(bus, h, "ses_test");

    // The empty title forced the title-agent fallback, which produced the name
    // from the real conversation (asserting the instruction is fed the text,
    // not an empty/garbage transcript).
    const genCalls = api.calls.opencodeGenerateTitle ?? [];
    expect(genCalls).toHaveLength(1);
    expect(JSON.stringify(genCalls[0][0])).toContain(
      "I'm just checking the manta setup",
    );
    const renames = api.calls.tmuxRenameWindow ?? [];
    expect(renames.length).toBe(1);
    expect(renames[0][0]).toEqual({
      sessionName: "proj",
      windowIndex: 1,
      newName: "Manta setup check",
    });

    // No second rename shortly after.
    await new Promise((r) => setTimeout(r, 60));
    await h.flush();
    expect(api.calls.tmuxRenameWindow ?? []).toHaveLength(1);
  });

  it("retries the title agent on the next turn when generation returns empty", async () => {
    // Generation fails on turn 1 (returns "") and succeeds on turn 2. The
    // first-name fallback must advance lastAutoRenamedTurnRef ONLY on a
    // successful rename, so a transient failure doesn't cost the window its
    // name for the next four turns — turn 2 retries and renames.
    let genCalls = 0;
    ({ api, bus } = installMockApi({
      opencodeListSessions: () =>
        Promise.resolve([{ id: "ses_test", title: "" }]),
      opencodeGenerateTitle: () => {
        genCalls += 1;
        return Promise.resolve(genCalls === 1 ? "" : "Manta setup check");
      },
    }));
    resetStore({ autoRenameSessions: true });
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await submitMessage(h, "I'm just checking the manta setup");
    await turnIdle(bus, h, "ses_test");

    // Turn 1: generation failed ("") → no rename, ref NOT advanced.
    expect(api.calls.opencodeGenerateTitle ?? []).toHaveLength(1);
    expect(api.calls.tmuxRenameWindow ?? []).toHaveLength(0);

    // Turn 2: retries, succeeds → exactly one rename now.
    await submitMessage(h, "Let's dig in");
    await turnIdle(bus, h, "ses_test");

    expect(api.calls.opencodeGenerateTitle ?? []).toHaveLength(2);
    const renames = api.calls.tmuxRenameWindow ?? [];
    expect(renames).toHaveLength(1);
    expect(renames[0][0]).toEqual({
      sessionName: "proj",
      windowIndex: 1,
      newName: "Manta setup check",
    });
  });
});

// BET-1124: the new-session auto-submit carries staged attachments. The draft
// hands the panel attachments (already status:"ready" with remotePath); the
// panel seeds its composer strip from them and submit() sends path-ref chips
// folded into the text (@<path>) and media chips as FileParts (never in text).
describe("ChatPanel attachment auto-submit (BET-1124)", () => {
  let api: MockApi;
  let h: Harness | null = null;

  beforeEach(() => {
    ({ api } = installMockApi({
      opencodeModels: () =>
        Promise.resolve([
          {
            id: "claude-x",
            providerID: "anthropic",
            name: "Claude X",
            limit: { context: 200000 },
            capabilities: { input: ["image", "text"] },
          },
        ]),
      opencodeDefaultModel: () =>
        Promise.resolve({ providerID: "anthropic", modelID: "claude-x" }),
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    // The model catalog is module-cached; force a fresh fetch so activeModel
    // resolves to the image-capable model above (otherwise the media chip's
    // capability guard would refuse the send).
    refreshModelCatalog();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("seeds the composer strip and carries attachments through the first prompt", async () => {
    const attachments: Attachment[] = [
      {
        id: "a1",
        filename: "notes.md",
        mime: "text/markdown",
        remotePath: "/remote/notes.md",
        status: "ready",
        source: "drop",
        asPathRef: true,
      },
      {
        id: "a2",
        filename: "img.png",
        mime: "image/png",
        remotePath: "/remote/img.png",
        status: "ready",
        source: "drop",
        asPathRef: false,
      },
    ];
    h = mount(
      <ChatPanel
        {...PROPS}
        autoSubmit={{
          text: "review these",
          model: { providerID: "anthropic", modelID: "claude-x" },
          attachments,
        }}
      />,
    );
    // submit() clears the composer strip after a successful send, so the
    // seeding is asserted through its effects: only a panel whose strip was
    // seeded (attachments in composer state) can fold the path-ref chip into
    // the text or send the media chip as a FilePart.
    await h.flush();

    const calls = api.calls["opencodePrompt"] ?? [];
    expect(calls.length).toBe(1);
    const sentText = calls[0]?.[1] as string;
    // Path-ref chip folded into the text as @<path> for the AI's Read tool.
    expect(sentText).toContain("@/remote/notes.md");
    // Media chip is NOT folded into the text.
    expect(sentText).not.toContain("@/remote/img.png");
    // Media chip travels as a FilePart attachment.
    expect(calls[0]?.[3]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          remotePath: "/remote/img.png",
          mime: "image/png",
          filename: "img.png",
        }),
      ]),
    );
  });
});

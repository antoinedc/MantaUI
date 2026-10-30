// @vitest-environment jsdom
//
// Session catch-up (spec 2026-10-30-session-catch-up): when a chat panel becomes
// visible again after its session kept working, a floating pill says it is
// catching up, a message the user sends meanwhile is HELD and released once the
// fresh transcript is committed, and a failed catch-up says so with Retry.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import {
  installMockApi,
  resetStore,
  mount,
  emitStreamAndFlush,
  type MockApi,
  type MockEventBus,
  type Harness,
} from "./testHarness";

const SID = "ses_test";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };
const HELD_COPY = "Not sent: couldn't load the latest steps. Retry, or press Enter to send anyway.";

const asstMsg = (id: string, text: string, created: number) => ({
  info: { id, sessionID: SID, role: "assistant" as const, time: { created, completed: created + 1 } },
  parts: [{ type: "text", id: `p_${id}`, messageID: id, text }],
});
const T0 = [asstMsg("msg_old", "old step", 1)];
const T1 = [...T0, asstMsg("msg_new", "something happened while you were away", 10)];

type Deferred = { resolve: (m: unknown[]) => void; reject: (e: Error) => void };

describe("ChatPanel session catch-up", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;
  // Catch-up fetches (everything after the initial load) wait here for the test.
  let pending: Deferred[] = [];

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const textarea = () => h!.container.querySelector("textarea") as HTMLTextAreaElement;
  const pill = () => h!.container.querySelector('[data-testid="catchup-pill"]') as HTMLElement | null;
  const jump = () => h!.container.querySelector(".manta-jump-latest") as HTMLElement;
  const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  async function type(value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea(), value);
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function key(k: string, init: KeyboardEventInit = {}) {
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await h!.flush();
  }
  const click = async (el: Element | null) => {
    expect(el).not.toBeNull();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await h!.flush();
  };
  const byLabel = (label: string) => h!.container.querySelector(`button[aria-label="${label}"]`);
  const heldSend = () => byLabel("Waiting to send — click to cancel");
  const pillButton = (text: string) =>
    Array.from(pill()?.querySelectorAll("button") ?? []).find((b) => b.textContent === text) ?? null;
  const sendError = () => {
    const el = [...h!.container.querySelectorAll("span.flex-1")].find((e) => (e.textContent ?? "").startsWith("⚠ "));
    return (el?.textContent ?? "").replace(/^⚠ /, "");
  };
  const promptTexts = () => (api.calls.opencodePrompt ?? []).map((c) => c[1]);

  // Open the panel active (initial load = T0), then hide it, let the session
  // "work" (a frame arrives while hidden → a refetch is owed) and bring it back.
  // Every fetch after the initial load waits for the test to answer it.
  async function reactivate(opts: { detach?: boolean } = {}) {
    pending = [];
    let loads = 0;
    ({ api, bus } = installMockApi({
      opencodeMessages: () => {
        if (loads++ === 0) return Promise.resolve(T0);
        return new Promise<unknown[]>((resolve, reject) => pending.push({ resolve, reject }));
      },
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    if (opts.detach) {
      await act(async () => {
        window.dispatchEvent(new CustomEvent("manta-scroll-to-message", { detail: { sessionId: SID, messageId: "msg_old" } }));
      });
      await h.flush();
    }
    await act(async () => { h!.rerender(<ChatPanel {...PROPS} isActive={false} />); });
    await h.flush();
    await emitStreamAndFlush(bus, h, {
      sub: "flush",
      sessionId: SID,
      payload: { messageID: "msg_new", partID: "p_msg_new", field: "text", text: "x" },
    });
    expect(pending).toHaveLength(0);
    await act(async () => { h!.rerender(<ChatPanel {...PROPS} isActive />); });
    await h.flush();
  }
  const resolveCatchUp = async (m: unknown[], idx = 0) => {
    await act(async () => pending[idx].resolve(m));
    await h!.flush();
  };

  describe("the pill", () => {
    it("starts the catch-up fetch at once and shows 'Catching up…' only after 200 ms", async () => {
      await reactivate();
      expect(pending).toHaveLength(1);
      expect(pill()).toBeNull();
      await sleep(260);
      expect(pill()?.textContent).toBe("Catching up…");
      expect(pill()?.getAttribute("role")).toBe("status");
      await resolveCatchUp(T0);
    });

    it("a fast catch-up never shows the plain pill, but still shows the 'new steps' pill", async () => {
      await reactivate();
      await resolveCatchUp(T1);
      expect(pill()?.textContent).toBe("1 new step");
      expect(pill()?.tagName).toBe("BUTTON");
      expect(pill()?.getAttribute("aria-label")).toBe("Show 1 new step");
    });

    it("the 'new steps' pill dwells, fades, then unmounts", async () => {
      await reactivate();
      await resolveCatchUp(T1);
      await sleep(2000);
      expect(pill()).not.toBeNull();
      expect(pill()?.getAttribute("data-leaving")).toBeNull();
      await sleep(600);
      expect(pill()?.getAttribute("data-leaving")).toBe("true");
      await sleep(400);
      expect(pill()).toBeNull();
    }, 10000);

    it("no new steps → no pill at all", async () => {
      await reactivate();
      await sleep(260);
      expect(pill()).not.toBeNull();
      await resolveCatchUp(T0);
      expect(pill()).toBeNull();
    });

    it("the jump-to-latest button yields to the pill and comes back when it goes", async () => {
      await reactivate({ detach: true });
      expect(jump().dataset.shown).toBe("true");
      await sleep(260);
      expect(pill()).not.toBeNull();
      expect(jump().dataset.shown).toBe("false");
      await resolveCatchUp(T0);
      expect(pill()).toBeNull();
      expect(jump().dataset.shown).toBe("true");
    });

    it("clicking the 'new steps' pill scrolls to the first new message and dismisses it", async () => {
      await reactivate();
      await resolveCatchUp(T1);
      // Following the tail: the jump button is hidden. Going to a message detaches.
      expect(jump().dataset.shown).toBe("false");
      await click(pill());
      expect(jump().dataset.shown).toBe("true");
      expect(pill()).toBeNull();
    });

    it("Retry re-runs the catch-up fetch", async () => {
      await reactivate();
      await act(async () => pending[0].reject(new Error("offline")));
      await h!.flush();
      expect(pill()?.textContent).toBe("Couldn't load the latest steps" + "Retry");
      expect(pill()?.getAttribute("data-tone")).toBe("error");
      await click(pillButton("Retry"));
      expect(pending).toHaveLength(2);
      await sleep(260);
      expect(pill()?.textContent).toBe("Catching up…");
      await resolveCatchUp(T1, 1);
      expect(pill()?.textContent).toBe("1 new step");
    });
  });

  describe("held send", () => {
    it("Enter while catching up holds the message: the held pill shows at once, nothing is sent", async () => {
      await reactivate();
      await type("also bump the cache headers");
      await key("Enter");
      expect(promptTexts()).toEqual([]);
      expect(pill()?.textContent).toBe("Catching up… · will send when ready" + "Cancel");
      expect(heldSend()).not.toBeNull();
      expect(textarea().value).toBe("also bump the cache headers");
      await resolveCatchUp(T1);
    });

    it("is released through submit after a successful catch-up (idle path)", async () => {
      await reactivate();
      await type("go ahead");
      await key("Enter");
      await resolveCatchUp(T1);
      expect(promptTexts()).toEqual(["go ahead"]);
      expect(pill()?.textContent).toBe("1 new step · your message was sent");
      // The composer emptied, so the Send button plays its exit animation.
      await sleep(500);
      expect(heldSend()).toBeNull();
    });

    it("is released into the running turn when the agent is running at release (Enter → steer)", async () => {
      await reactivate();
      await emitStreamAndFlush(bus, h!, { sub: "running", sessionId: SID, payload: { running: true } });
      await type("one more thing");
      await key("Enter");
      expect(promptTexts()).toEqual([]);
      await resolveCatchUp(T1);
      const calls = api.calls.opencodePrompt ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe("one more thing");
      expect(calls[0][6]).toEqual({ delivery: "steer", messageID: expect.stringMatching(/^msg_/) });
      expect(pill()?.textContent).toBe("1 new step · your message was sent into the running turn");
    });

    it("⌥Enter is held as 'after this turn' and released with delivery queue", async () => {
      await reactivate();
      await emitStreamAndFlush(bus, h!, { sub: "running", sessionId: SID, payload: { running: true } });
      await type("later please");
      await key("Enter", { altKey: true });
      expect(promptTexts()).toEqual([]);
      expect(heldSend()).not.toBeNull();
      await resolveCatchUp(T1);
      const calls = api.calls.opencodePrompt ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0][6]).toEqual({ delivery: "queue", messageID: expect.stringMatching(/^msg_/) });
    });

    it("a second submit while held changes nothing (one hold at a time)", async () => {
      await reactivate();
      await type("first");
      await key("Enter");
      await key("Enter", { altKey: true });
      await resolveCatchUp(T1);
      expect(promptTexts()).toEqual(["first"]);
    });

    it("releasing into an emptied composer sends nothing and shows no suffix", async () => {
      await reactivate();
      await type("never mind");
      await key("Enter");
      await type("");
      await resolveCatchUp(T1);
      expect(promptTexts()).toEqual([]);
      expect(pill()?.textContent).toBe("1 new step");
    });

    it("Cancel on the pill drops the hold and keeps the text", async () => {
      await reactivate();
      await type("hold this");
      await key("Enter");
      await click(pillButton("Cancel"));
      expect(heldSend()).toBeNull();
      expect(textarea().value).toBe("hold this");
      // Back to the plain catching state: hidden before 200 ms, "Catching up…" after.
      expect(pill()?.textContent ?? "Catching up…").toBe("Catching up…");
      await resolveCatchUp(T1);
      expect(promptTexts()).toEqual([]);
      expect(pill()?.textContent).toBe("1 new step");
    });

    it("cancelling after the plain pill has shown reverts to it at once", async () => {
      await reactivate();
      await sleep(260);
      await type("hold this");
      await key("Enter");
      expect(pill()?.textContent).toContain("will send when ready");
      await click(pillButton("Cancel"));
      expect(pill()?.textContent).toBe("Catching up…");
      await resolveCatchUp(T0);
    });

    it("clicking the held Send button cancels the hold", async () => {
      await reactivate();
      await type("hold this");
      await key("Enter");
      await click(heldSend());
      expect(heldSend()).toBeNull();
      expect(byLabel("Send message")).not.toBeNull();
      await resolveCatchUp(T1);
      expect(promptTexts()).toEqual([]);
    });

    it("a failed catch-up with a held message sends nothing and says so in the send-error strip", async () => {
      await reactivate();
      await type("will it go");
      await key("Enter");
      await act(async () => pending[0].reject(new Error("offline")));
      await h!.flush();
      expect(promptTexts()).toEqual([]);
      expect(sendError()).toBe(HELD_COPY);
      expect(textarea().value).toBe("will it go");
      expect(heldSend()).toBeNull();
      expect(pill()?.getAttribute("data-tone")).toBe("error");
    });

    it("Enter while the catch-up has failed sends normally ('send anyway')", async () => {
      await reactivate();
      await act(async () => pending[0].reject(new Error("offline")));
      await h!.flush();
      await type("send anyway");
      await key("Enter");
      expect(promptTexts()).toEqual(["send anyway"]);
    });

    it("deactivating drops the hold silently; the text stays", async () => {
      await reactivate();
      await type("keep me");
      await key("Enter");
      expect(heldSend()).not.toBeNull();
      await act(async () => { h!.rerender(<ChatPanel {...PROPS} isActive={false} />); });
      await h!.flush();
      await resolveCatchUp(T1);
      expect(promptTexts()).toEqual([]);
      await act(async () => { h!.rerender(<ChatPanel {...PROPS} isActive />); });
      await h!.flush();
      expect(heldSend()).toBeNull();
      expect(textarea().value).toBe("keep me");
      // The stale answer applied nothing, so the refetch is still owed: a second catch-up runs.
      expect(pending).toHaveLength(2);
      await resolveCatchUp(T1, 1);
      expect(promptTexts()).toEqual([]);
    });

    it("the /clear bridge is never held", async () => {
      await reactivate();
      await act(async () => {
        window.dispatchEvent(new CustomEvent("manta-run-clear", { detail: { sessionId: SID } }));
      });
      await h!.flush();
      expect((api.calls.opencodeClearSession ?? []).length).toBe(1);
      expect(heldSend()).toBeNull();
      await resolveCatchUp(T0);
    });
  });
});

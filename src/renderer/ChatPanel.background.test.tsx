// @vitest-environment jsdom
//
// OpenCode V2 v2-next Stage B (desktop): a valid slash command is highlighted,
// "Run in background" appears for opencode commands / skills, a background send
// is its own path (never steers the turn), and the running / uncertain / failed
// / finished cards come from the job store + the N4 background-result part.
// Every action reports both outcomes (AGENTS.md "never stub a control").

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { useStore } from "./store";
import { writePlanSaved } from "./chatShared";
import { refreshAgentCatalog } from "./agentCatalog";
import { installMockApi, resetStore, mount, emitStreamAndFlush, type MockApi, type MockEventBus, type Harness } from "./testHarness";

// Count how many times the finished card renders its body (memo-chain check).
const mdRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./MarkdownBody", async (orig) => {
  const real = await orig<typeof import("./MarkdownBody")>();
  return {
    ...real,
    renderMarkdown: (text: string) => {
      if (text.includes("RESULT_MARK")) mdRenders.count += 1;
      return real.renderMarkdown(text);
    },
  };
});

const REAL_ACTIONS = {
  activateWindow: useStore.getState().activateWindow,
  refresh: useStore.getState().refresh,
};

const SID = "ses_test";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };

const COMMANDS = [
  { name: "review", description: "review changes" },
  { name: "init", description: "setup" },
  { name: "impeccable", description: "skill", source: "skill" },
  { name: "deploy", description: "ships it", background: true },
];

const job = (over: Record<string, unknown> = {}) => ({
  id: "job1",
  name: "/review HEAD~1",
  prompt: "",
  model: null,
  parentSessionID: SID,
  parentDirectory: "/x",
  childSessionID: "ses_c1",
  tmuxSession: "proj",
  windowIndex: 4,
  worktree: null,
  branch: null,
  baseSha: null,
  status: "running",
  activity: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  result: null,
  error: null,
  filesChanged: null,
  origin: "command",
  completionOwner: "manta",
  launchState: "running",
  ...over,
});

const resultMessage = (part: Record<string, unknown> = {}) => ({
  info: { id: "msg_bg1", sessionID: SID, role: "assistant" as const, time: { created: 5 }, background: true },
  parts: [
    {
      id: "msg_bg1:bg",
      messageID: "msg_bg1",
      type: "background-result",
      childSessionId: "ses_c1",
      jobId: "job1",
      state: "completed",
      name: "/review HEAD~1",
      text: "RESULT_MARK: backoff has no upper bound",
      ...part,
    },
  ],
});

describe("ChatPanel background slash commands (Stage B)", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
    mdRenders.count = 0;
    useStore.setState({ ...REAL_ACTIONS, jobs: {} });
  });

  async function open(
    overrides: Record<string, unknown> = {},
    opts: { running?: boolean; store?: Record<string, unknown>; props?: Record<string, unknown> } = {},
  ) {
    ({ api, bus } = installMockApi({ opencodeCommands: () => Promise.resolve(COMMANDS), ...overrides }));
    resetStore({ jobs: {}, ...(opts.store ?? {}) } as never);
    h = mount(<ChatPanel {...PROPS} {...opts.props} />);
    await h.flush();
    if (opts.running) {
      await emitStreamAndFlush(bus, h, { sub: "running", sessionId: SID, payload: { running: true } });
    }
    // Prime the command list the way the composer does.
    await type("/");
    await h.flush();
    await type("");
    return h;
  }
  const textarea = () => h!.container.querySelector("textarea") as HTMLTextAreaElement;
  async function type(value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea(), value);
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await h!.flush();
  }
  async function key(k: string, init: KeyboardEventInit = {}) {
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await h!.flush();
  }
  const q = <T extends Element = HTMLElement>(sel: string) => h!.container.querySelector<T>(sel);
  const box = () => q('[data-testid="background-run-box"]');
  const checkbox = () => q<HTMLInputElement>('[data-testid="background-run-box"] input[type="checkbox"]');
  const token = () => q('[data-testid="slash-token"]');
  const sendError = () => {
    const el = [...h!.container.querySelectorAll("span.flex-1")].find((e) => (e.textContent ?? "").startsWith("⚠ "));
    return (el?.textContent ?? "").replace(/^⚠ /, "");
  };
  async function tick() {
    await act(async () => {
      checkbox()!.click();
    });
    await h!.flush();
  }

  describe("highlight", () => {
    it("loads the session's command list with its directory (P1)", async () => {
      await open();
      expect(api.calls.opencodeCommands.every(([arg]) => (arg as { directory?: string })?.directory === "/x")).toBe(true);
    });

    it("a valid command's /name is coloured; its arguments are not; the overlay mirrors the text exactly", async () => {
      await open();
      await type("/review HEAD~1");
      expect(token()?.textContent).toBe("/review");
      expect(q('[data-testid="slash-highlight"]')?.textContent?.replace("\u200b", "")).toBe("/review HEAD~1");
      // The textarea stays the input.
      expect(textarea().value).toBe("/review HEAD~1");
      expect(q('[data-testid="slash-highlight"]')?.getAttribute("aria-hidden")).toBe("true");
    });

    it("a skill and a Manta built-in are highlighted too", async () => {
      await open();
      await type("/impeccable polish");
      expect(token()?.textContent).toBe("/impeccable");
      await type("/fork");
      expect(token()?.textContent).toBe("/fork");
    });

    it("unknown, partial, leading-space and mid-text slashes are not highlighted", async () => {
      await open();
      for (const text of ["/revie", "/nope x", " /review", "please run /review", "hello"]) {
        await type(text);
        expect(token(), text).toBeNull();
      }
    });
  });

  describe("the Run in background box", () => {
    it("shows for an opencode command or skill, not for a Manta built-in or non-commands", async () => {
      await open();
      await type("/review");
      expect(box()).not.toBeNull();
      await type("/impeccable x");
      expect(box()).not.toBeNull();
      await type("/fork");
      await h!.flush();
      await vi.waitFor(() => expect(box()).toBeNull());
      await type("/nope");
      expect(box()).toBeNull();
    });

    it("ticking it shows the helper text and relabels Send; it resets when the box disappears", async () => {
      await open();
      await type("/review HEAD~1");
      expect(checkbox()!.checked).toBe(false);
      expect(q('button[aria-label="Send message"]')).not.toBeNull();
      await tick();
      expect(checkbox()!.checked).toBe(true);
      expect(q('[data-testid="background-run-helper"]')?.className).toContain("visible");
      expect(q('[data-testid="background-run-helper"]')?.className).not.toContain("invisible");
      expect(q('button[aria-label="Run in background"]')?.textContent).toBe("Run in background");
      // Stop being a valid command: the box goes and the tick is forgotten …
      await type("/revie");
      await vi.waitFor(() => expect(box()).toBeNull());
      // … so the same command typed again is unticked.
      await type("/review HEAD~1");
      expect(checkbox()!.checked).toBe(false);
    });

    it("stays ticked while the text changes between two valid commands", async () => {
      await open();
      await type("/review");
      await tick();
      await type("/init");
      expect(checkbox()!.checked).toBe(true);
    });

    it("an always-background command shows it checked + disabled with the explanation", async () => {
      await open();
      await type("/deploy now");
      expect(checkbox()!.checked).toBe(true);
      expect(checkbox()!.disabled).toBe(true);
      expect(q('[data-testid="background-run-box"] [title="This command always runs in the background"]')).not.toBeNull();
      expect(q('button[aria-label="Run in background"]')).not.toBeNull();
    });
  });

  describe("sending with the box ticked", () => {
    it("idle: one background run with the composer's model — never a delivery, never a prompt; composer cleared", async () => {
      await open({}, { store: { defaultModel: { providerID: "anthropic", modelID: "claude-sonnet" } } });
      await type("/review HEAD~1");
      await tick();
      await key("Enter");
      expect(api.calls.opencodeRunCommand).toHaveLength(1);
      const [input] = api.calls.opencodeRunCommand[0] as [Record<string, unknown>];
      expect(input).toMatchObject({
        sessionId: SID,
        command: "review",
        arguments: "HEAD~1",
        attachments: [],
        background: true,
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
      });
      expect("delivery" in input).toBe(false);
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
      expect(textarea().value).toBe("");
      // the box goes with the text
      await vi.waitFor(() => expect(box()).toBeNull());
    });

    it("carries the plan agent when plan mode is on", async () => {
      writePlanSaved(SID, true);
      await open({ opencodeAgents: () => Promise.resolve([{ name: "plan", mode: "primary" }, { name: "build", mode: "primary" }]) });
      await act(async () => refreshAgentCatalog());
      await h!.flush();
      await type("/review");
      await tick();
      await key("Enter");
      const [input] = api.calls.opencodeRunCommand[0] as [Record<string, unknown>];
      expect(input.agent).toBe("plan");
      writePlanSaved(SID, false);
    });

    it("busy: Enter and ⌥Enter both run it in the background, with NO delivery, and leave the turn running", async () => {
      await open({}, { running: true });
      await type("/review a");
      await tick();
      await key("Enter");
      await type("/review b");
      await tick();
      await key("Enter", { altKey: true });
      expect(api.calls.opencodeRunCommand).toHaveLength(2);
      for (const [input] of api.calls.opencodeRunCommand as Array<[Record<string, unknown>]>) {
        expect(input.background).toBe(true);
        expect("delivery" in input).toBe(false);
      }
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
      expect(q('button[aria-label="Stop the running turn"]')).not.toBeNull();
      expect(textarea().value).toBe("");
    });

    it("an always-background command is sent through the same path", async () => {
      await open({}, { running: true });
      await type("/deploy now");
      await key("Enter");
      const [input] = api.calls.opencodeRunCommand[0] as [Record<string, unknown>];
      expect(input).toMatchObject({ command: "deploy", arguments: "now", background: true });
      expect("delivery" in input).toBe(false);
    });

    it("unticked, the same command is an ordinary foreground run (no background flag)", async () => {
      await open();
      await type("/review HEAD~1");
      await key("Enter");
      const [input] = api.calls.opencodeRunCommand[0] as [Record<string, unknown>];
      expect(input.background).toBeUndefined();
    });

    it("a refusal shows the box's message and keeps the draft and the tick", async () => {
      await open({ opencodeRunCommand: () => Promise.reject(new Error("5 background jobs are already running")) });
      await type("/review HEAD~1");
      await tick();
      await key("Enter");
      expect(sendError()).toContain("5 background jobs are already running");
      expect(textarea().value).toBe("/review HEAD~1");
      expect(checkbox()!.checked).toBe(true);
    });

    it("a second Enter while the run is in flight is ignored", async () => {
      let release!: (v: { jobId: string }) => void;
      await open({ opencodeRunCommand: () => new Promise((res) => (release = res as typeof release)) });
      await type("/review");
      await tick();
      await key("Enter");
      await key("Enter");
      expect(api.calls.opencodeRunCommand).toHaveLength(1);
      await act(async () => release({ jobId: "job1" }));
      await h!.flush();
      expect(textarea().value).toBe("");
    });

    it("newer text typed while the run is in flight is not cleared", async () => {
      let release!: (v: { jobId: string }) => void;
      await open({ opencodeRunCommand: () => new Promise((res) => (release = res as typeof release)) });
      await type("/review");
      await tick();
      await key("Enter");
      await type("/review more");
      await act(async () => release({ jobId: "job1" }));
      await h!.flush();
      expect(textarea().value).toBe("/review more");
    });
  });

  describe("cards", () => {
    it("a running job of this session shows 'Running in background' with its name and Open session", async () => {
      await open({}, { store: { jobs: { ses_c1: job() } } });
      const card = q('[data-testid="background-card"]')!;
      expect(card.getAttribute("data-kind")).toBe("running");
      expect(card.textContent).toContain("Running in background:");
      expect(card.textContent).toContain("/review HEAD~1");
      expect(card.querySelector('[data-testid="background-open-session"]')?.textContent).toBe("Open session");
    });

    it("another session's job, and a finished job with nothing owed, show nothing", async () => {
      await open({}, { store: { jobs: { a: job({ parentSessionID: "ses_other", childSessionID: "a" }), b: job({ id: "j2", childSessionID: "b", status: "done" }) } } });
      expect(q('[data-testid="background-card"]')).toBeNull();
    });

    it("an uncertain launch says it couldn't confirm — not a spinner", async () => {
      await open({}, { store: { jobs: { ses_c1: job({ launchState: "uncertain" }) } } });
      const card = q('[data-testid="background-card"]')!;
      expect(card.getAttribute("data-kind")).toBe("uncertain");
      expect(card.textContent).toContain("Couldn't confirm this started — open the session to check");
      expect(card.querySelector('[data-testid="background-open-session"]')).not.toBeNull();
      expect(card.querySelector(".animate-spin")).toBeNull();
    });

    it("a job that failed before its child ran is a failure card with the error", async () => {
      await open({}, { store: { jobs: { ses_c1: job({ status: "failed", launchState: "submitting", error: "the box refused it" }) } } });
      const card = q('[data-testid="background-card"]')!;
      expect(card.getAttribute("data-kind")).toBe("failed");
      expect(card.textContent).toContain("the box refused it");
      expect(card.querySelector(".animate-spin")).toBeNull();
    });

    it("a finished N4 result renders the result card with its text, state and Open session →", async () => {
      await open({ opencodeMessages: () => Promise.resolve([resultMessage()]) });
      const card = q('[data-testid="background-result-card"]')!;
      expect(card).not.toBeNull();
      expect(card.textContent).toContain("Background");
      expect(card.textContent).toContain("/review HEAD~1");
      expect(card.textContent).toContain("done");
      expect(card.textContent).toContain("RESULT_MARK: backoff has no upper bound");
      expect(card.querySelector('[data-testid="background-open-session"]')?.textContent).toBe("Open session →");
    });

    it("a failed result is tinted as a failure; a task subagent (no jobId, no name) is still a card", async () => {
      await open({
        opencodeMessages: () =>
          Promise.resolve([
            resultMessage({ state: "failed", text: "it blew up" }),
            { ...resultMessage({ jobId: undefined, name: undefined, agent: "general", childSessionId: "ses_task", text: "found it" }), info: { id: "msg_bg2", sessionID: SID, role: "assistant", time: { created: 6 }, background: true } },
          ]),
      });
      const cards = [...h!.container.querySelectorAll('[data-testid="background-result-card"]')];
      expect(cards).toHaveLength(2);
      expect(cards[0].getAttribute("data-state")).toBe("failed");
      expect(cards[1].textContent).toContain("general subagent");
      // No job record is known for the subagent's child → nothing to open, so no control.
      expect(cards[1].querySelector('[data-testid="background-open-session"]')).toBeNull();
    });

    it("the running card is REPLACED by its result — paired by jobId", async () => {
      await open({ opencodeMessages: () => Promise.resolve([resultMessage()]) }, { store: { jobs: { ses_c1: job() } } });
      expect(q('[data-testid="background-card"]')).toBeNull();
      expect(h!.container.querySelectorAll('[data-testid="background-result-card"]')).toHaveLength(1);
    });

    it("… and by childSessionId when the result carries no jobId", async () => {
      await open(
        { opencodeMessages: () => Promise.resolve([resultMessage({ jobId: undefined })]) },
        { store: { jobs: { ses_c1: job() } } },
      );
      expect(q('[data-testid="background-card"]')).toBeNull();
      const card = q('[data-testid="background-result-card"]')!;
      // The open link resolves its job through the child id.
      expect(card.querySelector('[data-testid="background-open-session"]')).not.toBeNull();
    });

    it("a card appears live when the job store gains a job", async () => {
      await open();
      expect(q('[data-testid="background-card"]')).toBeNull();
      await act(async () => {
        useStore.getState().setJobs([job()] as never);
      });
      await h!.flush();
      expect(q('[data-testid="background-card"]')).not.toBeNull();
    });

    it("typing in the composer does not re-render a finished card (memo chain intact)", async () => {
      await open({ opencodeMessages: () => Promise.resolve([resultMessage()]) });
      const before = mdRenders.count;
      expect(before).toBeGreaterThan(0);
      await type("a");
      await type("ab");
      await type("abc");
      expect(mdRenders.count).toBe(before);
    });
  });

  describe("Open session reports both outcomes", () => {
    async function openFinished(overrides: Record<string, unknown>) {
      const activateWindow = vi.fn().mockResolvedValue(undefined);
      const refresh = vi.fn().mockResolvedValue(undefined);
      await open({ opencodeMessages: () => Promise.resolve([resultMessage()]), ...overrides }, { store: { activateWindow, refresh } as never });
      return { activateWindow, refresh };
    }
    const press = async () => {
      await act(async () => {
        q<HTMLButtonElement>('[data-testid="background-open-session"]')!.click();
      });
      await h!.flush();
    };

    it("success selects the returned window", async () => {
      const { activateWindow, refresh } = await openFinished({
        delegateOpenSession: () => Promise.resolve({ ok: true, tmuxSession: "proj", windowIndex: 4 }),
      });
      await press();
      expect(api.calls.delegateOpenSession).toEqual([[{ jobId: "job1" }]]);
      expect(refresh).toHaveBeenCalled();
      expect(activateWindow).toHaveBeenCalledWith("proj", 4);
      expect(q('[data-testid="background-open-error"]')).toBeNull();
    });

    it("a refusal shows the box's error on the card and selects nothing", async () => {
      const { activateWindow } = await openFinished({
        delegateOpenSession: () => Promise.resolve({ ok: false, error: "That session no longer exists" }),
      });
      await press();
      expect(q('[data-testid="background-open-error"]')?.textContent).toBe("That session no longer exists");
      expect(activateWindow).not.toHaveBeenCalled();
    });

    it("a throw shows an error too — and so does an unexpected answer", async () => {
      await openFinished({ delegateOpenSession: () => Promise.reject(new Error("unknown rpc channel: delegate:open-session")) });
      await press();
      expect(q('[data-testid="background-open-error"]')?.textContent).toContain("unknown rpc channel");
      h!.unmount();
      h = null;
      await openFinished({ delegateOpenSession: () => Promise.resolve(undefined) });
      await press();
      expect(q('[data-testid="background-open-error"]')).not.toBeNull();
    });

    it("works from a running card too", async () => {
      const activateWindow = vi.fn().mockResolvedValue(undefined);
      await open(
        { delegateOpenSession: () => Promise.resolve({ ok: true, tmuxSession: "proj", windowIndex: 9 }) },
        { store: { jobs: { ses_c1: job() }, activateWindow, refresh: vi.fn().mockResolvedValue(undefined) } as never },
      );
      await press();
      expect(activateWindow).toHaveBeenCalledWith("proj", 9);
    });
  });
});

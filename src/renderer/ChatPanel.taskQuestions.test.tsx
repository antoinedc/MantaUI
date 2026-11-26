// @vitest-environment jsdom
//
// A running agent task's question inside the real <ChatPanel> (agent screens spec §4.4): merged into the chat as the
// UNCHANGED question card, routed by the `tq_` id prefix to the agents channels, awaited, a refusal on the existing send-error
// line, and the open-question count on the task's run card.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { DelegateJob, TaskQuestion } from "../shared/types";
import { ChatPanel } from "./ChatPanel";
import { resetPackageAgentsForTest } from "./packageAgents";
import { installMockApi, mount, resetStore, type Harness, type MockApi, type MockEventBus } from "./testHarness";

const SID = "ses_p";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true, projectName: "proj", winName: "chat-1", mode: "chat" as const };

const tq = (id: string, over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id,
  rootJobId: "job1",
  jobId: "job1",
  parentSessionID: SID,
  agentSlug: "seo",
  agentName: "SEO",
  project: null,
  taskName: "Check the page",
  questions: [
    {
      question: "Which pages first?",
      options: [
        { label: "Pricing (Recommended)", description: "" },
        { label: "Home", description: "" },
      ],
      multiple: false,
    },
  ],
  state: "open",
  askedAt: 1,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  ...over,
});

const seoJob = (): DelegateJob =>
  ({
    id: "job1",
    rootJobId: "job1",
    name: "Check the page",
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
    agent: "agent-seo",
    agentName: "SEO",
    request: "@seo check the page",
  }) as unknown as DelegateJob;

// A chat that owns a task has talked already: the question cards live in the transcript tail, which an empty chat doesn't draw.
const assistantMsg = {
  info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1, completed: 2 } },
  parts: [{ id: "m1-t", messageID: "m1", type: "text", text: "I asked the SEO agent." }],
};

describe("ChatPanel — task questions", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let bus: MockEventBus;
  let list: TaskQuestion[];
  let hint: ((p: { id: string; parentSessionID: string; rootJobId: string; state: string }) => void) | null;

  beforeEach(() => {
    localStorage.clear();
    list = [tq("tq_1")];
    hint = null;
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(overrides: Record<string, unknown> = {}, store: Record<string, unknown> = {}) {
    ({ api, bus } = installMockApi({
      agentsList: () => Promise.resolve([]),
      opencodeMessages: () => Promise.resolve([assistantMsg]),
      agentsQuestions: () => Promise.resolve(list),
      onTaskQuestion: (cb: typeof hint) => {
        hint = cb;
        return () => {
          hint = null;
        };
      },
      ...overrides,
    }));
    resetPackageAgentsForTest();
    resetStore({ projects: [{ tmuxSession: "proj", defaultCwd: "/x", windows: [{ index: 1, name: "chat-1", opencodeSessionId: SID }] }], ...store } as never);
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await h.flush();
    return h;
  }
  const byText = (text: string) =>
    [...h!.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(text)) as HTMLButtonElement | undefined;
  const sendErrorText = () =>
    [...h!.container.querySelectorAll("span.flex-1")].map((e) => e.textContent ?? "").find((t) => t.startsWith("⚠ "))?.replace(/^⚠ /, "") ?? "";
  async function click(el: Element | undefined | null) {
    expect(el, "expected the control").toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  it("shows a task's open question in the chat that owns it, as the question card titled '<Agent> asks you'", async () => {
    await open();
    expect(api.calls.agentsQuestions?.[0]).toEqual([{ sessionID: SID }]);
    expect(h!.text()).toContain("SEO asks you");
    expect(h!.text()).toContain("Which pages first?");
    expect(byText("Submit")).toBeTruthy();
    expect(byText("Dismiss")).toBeTruthy();
  });

  it("Submit answers through the agents channel (never the session's own question channel), awaited", async () => {
    await open({ agentsQuestionAnswer: () => Promise.resolve(tq("tq_1", { state: "answered" })) });
    await click(byText("Submit"));
    // the recommended option is preselected
    expect(api.calls.agentsQuestionAnswer).toEqual([[{ id: "tq_1", answers: [["Pricing (Recommended)"]] }]]);
    expect(api.calls.opencodeQuestionReply ?? []).toHaveLength(0);
    expect(sendErrorText()).toBe("");
  });

  it("the card leaves when the hint refetch no longer lists the question", async () => {
    await open({ agentsQuestionAnswer: () => Promise.resolve(tq("tq_1", { state: "answered" })) });
    list = [];
    await click(byText("Submit"));
    expect(h!.text()).not.toContain("Which pages first?");
  });

  it("a question another event adds shows up on the hint", async () => {
    list = [];
    await open();
    expect(h!.text()).not.toContain("SEO asks you");
    list = [tq("tq_9")];
    await act(async () => hint!({ id: "tq_9", parentSessionID: SID, rootJobId: "job1", state: "open" }));
    await h!.flush();
    expect(h!.text()).toContain("SEO asks you");
  });

  it("Dismiss goes to the agents channel and a refusal is shown on the send-error line", async () => {
    await open({ agentsQuestionDismiss: () => Promise.reject(new Error("That question no longer exists.")) });
    await click(byText("Dismiss"));
    expect(api.calls.agentsQuestionDismiss).toEqual([[{ id: "tq_1" }]]);
    expect(api.calls.opencodeQuestionReject ?? []).toHaveLength(0);
    expect(sendErrorText()).toBe("That question no longer exists.");
  });

  it("a refused answer keeps the card on screen and says why", async () => {
    await open({ agentsQuestionAnswer: () => Promise.reject(new Error("Already sending your answer")) });
    await click(byText("Submit"));
    expect(sendErrorText()).toBe("Already sending your answer");
    expect(h!.text()).toContain("Which pages first?");
  });

  it("an ordinary session question still goes to the opencode channels, next to a task's", async () => {
    await open();
    await act(async () =>
      bus.emitStream({
        sub: "questions",
        sessionId: SID,
        payload: {
          questions: [
            {
              id: "call_1",
              requestId: "que_1",
              sessionID: SID,
              questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "main", description: "" }], multiple: false }],
            },
          ],
        },
      }),
    );
    await h!.flush();
    expect(h!.text()).toContain("Which branch?");
    expect(h!.text()).toContain("Which pages first?");
    // the session question's own card: its Dismiss rejects it on the session channel, not the agents one
    const dismiss = [...h!.container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Dismiss");
    expect(dismiss).toHaveLength(2);
    await click(dismiss[0]);
    expect(api.calls.opencodeQuestionReject).toEqual([["que_1", SID]]);
    expect(api.calls.agentsQuestionDismiss ?? []).toHaveLength(0);
  });

  it("the task's run card shows how many questions it has open", async () => {
    await open({}, { jobs: { ses_c1: seoJob() } });
    const chip = h!.container.querySelector('[data-testid="background-questions"]');
    expect(chip?.textContent).toBe("· 1 question");
  });

  it("nothing is asked of the box in a chat that has no open task question", async () => {
    list = [];
    await open();
    expect(h!.text()).not.toContain("asks you");
  });
});

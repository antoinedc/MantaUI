// @vitest-environment jsdom
//
// The open questions of the tasks a chat started (agent screens spec §4.4): subscribe to the `taskQuestion` hint BEFORE
// the first read, refetch on a hint for this chat and on the stream's resync frame, never swallow a newer list.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { TaskQuestion } from "../../shared/types";
import { useTaskQuestions } from "./useTaskQuestions";
import { installMockApi, mount, type Harness, type MockApi, type MockEventBus } from "../testHarness";

const tq = (id: string, over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id,
  rootJobId: "job1",
  jobId: "job1",
  parentSessionID: "ses_p",
  agentSlug: "architect",
  agentName: "Architect",
  project: null,
  taskName: "New agent",
  questions: [{ question: "Separate agent?", options: [{ label: "Yes", description: "" }], multiple: false }],
  state: "open",
  askedAt: 1,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  ...over,
});

function Probe({ sessionId }: { sessionId: string | null }) {
  const { questions } = useTaskQuestions(sessionId);
  return <div data-testid="ids">{questions.map((q) => q.id).join(",")}</div>;
}

describe("useTaskQuestions", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let bus: MockEventBus;
  let hint: ((p: { id: string; parentSessionID: string; rootJobId: string; state: string }) => void) | null = null;
  let list: TaskQuestion[] = [];
  let order: string[] = [];
  let fail = false;

  beforeEach(() => {
    list = [tq("tq_a")];
    order = [];
    fail = false;
    hint = null;
    ({ api, bus } = installMockApi({
      onTaskQuestion: (cb: typeof hint) => {
        order.push("subscribe");
        hint = cb;
        return () => {
          hint = null;
        };
      },
      agentsQuestions: () => {
        order.push("read");
        return fail ? Promise.reject(new Error("offline")) : Promise.resolve(list);
      },
    }));
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const ids = () => h!.container.querySelector('[data-testid="ids"]')?.textContent;

  it("subscribes before the first read and lists this chat's open questions", async () => {
    h = mount(<Probe sessionId="ses_p" />);
    await h.flush();
    expect(order.slice(0, 2)).toEqual(["subscribe", "read"]);
    expect(api.calls.agentsQuestions).toEqual([[{ sessionID: "ses_p" }]]);
    expect(ids()).toBe("tq_a");
  });

  it("refetches on a hint for this chat and ignores a hint for another chat", async () => {
    h = mount(<Probe sessionId="ses_p" />);
    await h.flush();
    list = [tq("tq_a"), tq("tq_b")];
    await act(async () => hint!({ id: "tq_x", parentSessionID: "ses_other", rootJobId: "j", state: "open" }));
    await h.flush();
    expect(api.calls.agentsQuestions).toHaveLength(1);
    await act(async () => hint!({ id: "tq_b", parentSessionID: "ses_p", rootJobId: "job1", state: "open" }));
    await h.flush();
    expect(api.calls.agentsQuestions).toHaveLength(2);
    expect(ids()).toBe("tq_a,tq_b");
  });

  it("refetches after a reconnect (the stream's resync frame)", async () => {
    h = mount(<Probe sessionId="ses_p" />);
    await h.flush();
    list = [];
    await act(async () => bus.emitStream({ sub: "resync", sessionId: "", payload: {} }));
    await h.flush();
    expect(api.calls.agentsQuestions).toHaveLength(2);
    expect(ids()).toBe("");
  });

  it("keeps the list it has when a refetch fails", async () => {
    h = mount(<Probe sessionId="ses_p" />);
    await h.flush();
    fail = true;
    await act(async () => bus.emitStream({ sub: "resync", sessionId: "", payload: {} }));
    await h.flush();
    expect(ids()).toBe("tq_a");
  });

  it("an unknown channel (older box) is an empty list", async () => {
    installMockApi({ agentsQuestions: () => Promise.reject(new Error("unknown rpc channel: agents:questions")) });
    h = mount(<Probe sessionId="ses_p" />);
    await h.flush();
    expect(ids()).toBe("");
  });

  it("does nothing without a chat", async () => {
    h = mount(<Probe sessionId={null} />);
    await h.flush();
    expect(api.calls.agentsQuestions).toBeUndefined();
    expect(ids()).toBe("");
  });
});

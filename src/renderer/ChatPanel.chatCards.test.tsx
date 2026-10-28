// @vitest-environment jsdom
//
// WS02 server-first, desktop side: the chat cards that render the BOX's answers —
// the read-only background-job bar (delegate:job-for-session) and the background-job
// approval card's refusal. The retry / compaction / send-error copy is covered in
// ChatPanel.harness.test.tsx, the inbox gate in ChatPanel.busySend.test.tsx.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { installMockApi, resetStore, mount, type Harness, type MockApi } from "./testHarness";
import type { DelegateJobView } from "../shared/types";

const SID = "ses_job";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/home/dev/projects/x", isActive: true };

const view = (over: Partial<DelegateJobView> = {}): DelegateJobView => ({
  id: "job1",
  status: "running",
  statusLabel: "running",
  headline: "BOX-HEADLINE read-only",
  statusLine: "BOX-STATUS editing auth.ts",
  parentLine: "BOX-PARENT It reports to main.",
  stoppable: true,
  parent: { sessionId: "ses_parent", name: "main", project: "proj", windowIndex: 0 },
  ...over,
});

describe("ChatPanel — read-only background job (the box decides)", () => {
  let api: MockApi;
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  beforeEach(() => localStorage.clear());

  async function open(overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi(overrides));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await h.flush();
    return h;
  }
  const byText = (text: string) => [...h!.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));

  it("renders the box's headline / parent line / status line verbatim and replaces the composer", async () => {
    await open({ delegateJobForSession: () => Promise.resolve({ readOnly: true, job: view() }) });
    const text = h!.text();
    expect(text).toContain("BOX-HEADLINE read-only");
    expect(text).toContain("BOX-PARENT It reports to main.");
    expect(h!.container.querySelector('[data-testid="read-only-job-status"]')?.textContent).toBe("BOX-STATUS editing auth.ts");
    expect(h!.container.querySelector("textarea")).toBeNull();
  });

  it("asks the box about THIS session", async () => {
    await open({ delegateJobForSession: () => Promise.resolve({ readOnly: false }) });
    expect(api.calls.delegateJobForSession?.[0]).toEqual([SID]);
  });

  it("an ordinary session (readOnly:false) keeps its composer", async () => {
    await open({ delegateJobForSession: () => Promise.resolve({ readOnly: false }) });
    expect(h!.container.querySelector('[data-testid="read-only-job-bar"]')).toBeNull();
    expect(h!.container.querySelector("textarea")).not.toBeNull();
  });

  it("Stop shows only when the box says the job is stoppable; Go to parent only with a parent", async () => {
    await open({ delegateJobForSession: () => Promise.resolve({ readOnly: true, job: view({ stoppable: false, parent: null }) }) });
    expect(byText("Stop")).toBeUndefined();
    expect(byText("Go to parent")).toBeUndefined();
    h!.unmount();
    await open({ delegateJobForSession: () => Promise.resolve({ readOnly: true, job: view() }) });
    expect(byText("Stop")).toBeDefined();
    expect(byText("Go to parent")).toBeDefined();
  });

  it("Stop calls the box, then re-asks it; a refusal is shown, not swallowed", async () => {
    await open({
      delegateJobForSession: () => Promise.resolve({ readOnly: true, job: view() }),
      delegateStop: () => Promise.resolve({ ok: false, error: "BOX: already finished" }),
    });
    await act(async () => byText("Stop")!.click());
    await h!.flush();
    expect(api.calls.delegateStop).toEqual([["job1"]]);
    expect(h!.text()).toContain("BOX: already finished");
  });

  it("an older box (no chat-cards-1): the session opens as an ordinary one and the box is not asked", async () => {
    await open({
      getServerVersion: () => Promise.resolve({ version: "1", minClient: "0", opencodeVersion: "1" }),
      delegateJobForSession: () => Promise.resolve({ readOnly: true, job: view() }),
    });
    expect(api.calls.delegateJobForSession ?? []).toEqual([]);
    expect(h!.container.querySelector('[data-testid="read-only-job-bar"]')).toBeNull();
    expect(h!.container.querySelector("textarea")).not.toBeNull();
  });

  it("a failing lookup never flips the session read-only", async () => {
    await open({ delegateJobForSession: () => Promise.reject(new Error("offline")) });
    expect(h!.container.querySelector('[data-testid="read-only-job-bar"]')).toBeNull();
    expect(h!.container.querySelector("textarea")).not.toBeNull();
  });
});

describe("ChatPanel — background-job approval refusal", () => {
  let api: MockApi;
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  beforeEach(() => localStorage.clear());

  const approval = { id: "a1", parentSessionID: SID, name: "fix-login", prompt: "do it", tools: [{ permission: "bash", pattern: "npm *" }], createdAt: 1 };
  async function open(overrides: Record<string, unknown>) {
    ({ api } = installMockApi({ delegatePendingApprovals: () => Promise.resolve([approval]), ...overrides }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await h.flush();
  }
  const start = () => [...h!.container.querySelectorAll("button")].find((b) => b.textContent === "Start job")!;

  it("ok:false WITH an error: the card stays and shows the box's reason", async () => {
    await open({ delegateApprove: () => Promise.resolve({ ok: false, error: "E-box" }) });
    expect(h!.text()).toContain("Background job approval");
    await act(async () => start().click());
    await h!.flush();
    expect(h!.text()).toContain("Background job approval");
    expect(h!.container.querySelector('[data-testid="delegate-approval-error"]')?.textContent).toBe("E-box");
    expect(api.calls.delegateApprove).toHaveLength(1);
  });

  it("an unreachable box keeps the card with a retryable message", async () => {
    await open({ delegateApprove: () => Promise.reject(new Error("offline")) });
    await act(async () => start().click());
    await h!.flush();
    expect(h!.text()).toContain("Background job approval");
    expect(h!.container.querySelector('[data-testid="delegate-approval-error"]')?.textContent).toBe("Couldn't reach your box — try again");
  });

  it("ok:true removes the card", async () => {
    await open({
      delegateApprove: () => Promise.resolve({ ok: true }),
      // the box no longer lists it once approved
    });
    await act(async () => start().click());
    await h!.flush();
    expect(h!.container.querySelector('[data-testid="delegate-approval-error"]')).toBeNull();
  });
});

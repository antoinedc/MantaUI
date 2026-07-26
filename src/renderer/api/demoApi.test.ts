// demoApi.test.ts — smoke tests for the demo transport (BET-302).
//
// The demo build replaces httpApi with a Proxy that reads from
// demoFixture.ts. These tests pin:
//   1. The agreed project names (ethernal / marketing / infra) are present
//      and there are no real-looking names that would leak into the
//      marketing surface.
//   2. The fixture has the required session-state variety (running, idle,
//      pending question, pending permission, subagent count > 0).
//   3. The transcript contains the required part types (user turn,
//      assistant turn, read, edit with +38 −4 diff, bash with multi-line
//      output, todo checklist with one item in_progress).
//   4. A pending question + a pending permission both live on the active
//      session so both cards render without interaction.
//   5. The Proxy fallback returns benign no-ops (Promise<null> for methods,
//      `() => {}` for subscriptions).
//
// `grep` for the project names is also part of the acceptance criteria —
// the test mirrors that check so future edits can't silently drop a name.

import { describe, it, expect } from "vitest";
import { demoState } from "./demoFixture.js";
import { demoApi } from "./demoApi.js";

// The three fictional project names. Mirrors the shot list in
// `docs/specs/website-readme-revamp.md` section 6 — every screenshot /
// video frame renders the same brand.
const PROJECT_NAMES = ["ethernal", "marketing", "infra"] as const;

describe("demo fixture — project + session structure", () => {
  it("contains exactly the three agreed fictional project names", () => {
    const names = demoState.projects.map((p) => p.tmuxSession);
    expect(names).toEqual([...PROJECT_NAMES]);
  });

  it("has six or seven sessions total across the three projects", () => {
    const total = demoState.projects.reduce(
      (n, p) => n + p.windows.length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(6);
    expect(total).toBeLessThanOrEqual(7);
  });

  it("exhibits at least one running session, one idle, one pending question, one pending permission", () => {
    const allStatuses = Object.values(demoState.status).flatMap(
      (byWindow) => Object.values(byWindow),
    );
    const runningCount = allStatuses.filter((s) => s.running).length;
    const idleAttentionCount = allStatuses.filter(
      (s) => !s.running && s.attention && (s.attentionKind ?? "idle") === "idle",
    ).length;
    const questionAttentionCount = allStatuses.filter(
      (s) => s.attentionKind === "question",
    ).length;
    const permissionAttentionCount = allStatuses.filter(
      (s) => s.attentionKind === "permission",
    ).length;
    expect(runningCount).toBeGreaterThanOrEqual(1);
    expect(idleAttentionCount).toBeGreaterThanOrEqual(1);
    expect(questionAttentionCount).toBeGreaterThanOrEqual(1);
    expect(permissionAttentionCount).toBeGreaterThanOrEqual(1);
  });

  it("has at least one session showing a non-zero subagent count", () => {
    const hasSubagents = Object.values(demoState.status).some((byWindow) =>
      Object.values(byWindow).some((s) => s.subagents > 0),
    );
    expect(hasSubagents).toBe(true);
  });
});

describe("demo fixture — transcript", () => {
  // Narrow the parts list to tool parts only — typed as the wider OpencodePart
  // shape, then cast through `unknown` so the per-tool fields (state, tool,
  // metadata) are reachable in the assertions below.
  const toolParts = demoState.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool") as unknown as Array<{
    tool: string;
    state: {
      input?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  }>;

  it("includes a user turn and an assistant turn", () => {
    const roles = demoState.messages.map((m) => m.info.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  it("includes a read tool call", () => {
    expect(toolParts.some((p) => p.tool === "read")).toBe(true);
  });

  it("includes an edit tool call with a +38 / −4 diff", () => {
    const edits = toolParts.filter((p) => p.tool === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const diff = edits[0].state.metadata?.filediff as
      | { additions?: number; deletions?: number }
      | undefined;
    expect(diff?.additions).toBe(38);
    expect(diff?.deletions).toBe(4);
  });

  it("includes a bash tool call with multi-line output", () => {
    const bashes = toolParts.filter((p) => p.tool === "bash");
    expect(bashes.length).toBeGreaterThanOrEqual(1);
    const liveOutput = bashes[0].state.metadata?.output;
    expect(typeof liveOutput).toBe("string");
    expect((liveOutput as string).split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("includes a todowrite with at least one item in_progress", () => {
    const todos = toolParts.find((p) => p.tool === "todowrite")?.state
      .input as { todos?: Array<{ status?: string }> };
    expect(todos?.todos).toBeDefined();
    const inProgress = (todos?.todos ?? []).filter(
      (t) => t.status === "in_progress",
    );
    expect(inProgress.length).toBeGreaterThanOrEqual(1);
  });
});

describe("demo fixture — visible cards", () => {
  it("has a pending permission on the active session", () => {
    expect(demoState.permission.sessionID).toBe(demoState.activeSessionId);
    expect(demoState.permission.id).toBeTruthy();
    expect(demoState.permission.permission).toBeTruthy();
  });

  it("has a pending question on the active session with a usable requestId", () => {
    expect(demoState.question.sessionID).toBe(demoState.activeSessionId);
    // Without requestId the QuestionCard's reply path is unanswerable.
    expect(typeof demoState.question.requestId).toBe("string");
    expect(demoState.question.requestId).toBeTruthy();
  });
});

describe("demo fixture — config (transport-mode resolver lands on 'http')", () => {
  it("carries a valid 32-hex boxToken so resolveTransportMode returns 'http'", () => {
    expect(demoState.config.boxToken).toMatch(/^[0-9a-f]{32}$/);
    expect(demoState.config.boxId).toMatch(/^[0-9a-f]{32}$/);
    expect(demoState.config.serverUrl).toMatch(/^https:\/\/.+\.boxes\.mantaui\.com$/);
  });

  it("leaves chatAutoAllow off so the permission card stays visible (no bypass banner)", () => {
    // The App.tsx shell renders the bypass-permissions banner only when
    // chatAutoAllow is true. The demo must keep it false.
    expect(demoState.config.chatAutoAllow).toBe(false);
  });
});

describe("demoApi — Proxy fallback", () => {
  it("explicit methods return the fixture values", async () => {
    expect(await demoApi.configGet()).toBe(demoState.config);
    expect(await demoApi.tmuxList()).toEqual(demoState.projects);
    const messages = await demoApi.opencodeMessages(demoState.activeSessionId);
    expect(messages).toBe(demoState.messages);
    expect(await demoApi.opencodeQuestions(demoState.activeSessionId)).toEqual([
      demoState.question,
    ]);
    expect(await demoApi.opencodePermissions(demoState.activeSessionId)).toEqual([
      demoState.permission,
    ]);
    expect(await demoApi.opencodeVcsBranch("/tmp")).toBe(demoState.branch);
  });

  it("subscriptions return a no-op unsubscribe", () => {
    expect(demoApi.onStatusEvent(() => {})()).toBeUndefined();
    expect(demoApi.onOpencodeEvent(() => {})()).toBeUndefined();
    expect(demoApi.onAgentFileReady(() => {})()).toBeUndefined();
    expect(demoApi.onDesktopNotify(() => {})()).toBeUndefined();
    expect(demoApi.onScreenshotDetected(() => {})()).toBeUndefined();
    expect(demoApi.onServerUpdateAvailable(() => {})()).toBeUndefined();
  });

  it("unknown methods resolve to null without throwing", async () => {
    // Methods not in the explicit set fall through the Proxy. They must
    // return a benign Promise<null> so destructuring / .catch(() => {})
    // guards stay quiet across every renderer call site.
    expect(await (demoApi as unknown as { tmuxKillSession(s: string): Promise<unknown> }).tmuxKillSession("foo")).toBeNull();
    expect(
      await (demoApi as unknown as { opencodePrompt(s: string, t: string): Promise<unknown> }).opencodePrompt("s", "t"),
    ).toBeNull();
    // onStatusEvent fires the callback once with the fixture batch — verify
    // it doesn't throw on the unknown-method code path.
    expect(() =>
      (demoApi as unknown as { onWhatever(cb: () => void): () => void }).onWhatever(() => {}),
    ).not.toThrow();
  });
});

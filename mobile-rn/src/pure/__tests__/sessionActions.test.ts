// sessionActions.test.ts — pure new/clear/fork/compact decision logic:
// which channel + payload each action maps to, and availability gating.

import { describe, expect, it } from "vitest";

import type { SessionRowVM } from "../sessionList";
import {
  availableActions,
  isActionAvailable,
  resolveSessionAction,
  type ClearSessionPayload,
  type CompactSessionPayload,
  type ForkSessionPayload,
} from "../sessionActions";

const chatRow: SessionRowVM = {
  key: "better-ui:0",
  project: "better-ui",
  windowIndex: 0,
  title: "main",
  kind: "chat",
  status: "idle",
  opencodeSessionId: "sess_abc",
};

const terminalRow: SessionRowVM = {
  key: "better-ui:1",
  project: "better-ui",
  windowIndex: 1,
  title: "term",
  kind: "terminal",
  status: "idle",
  opencodeSessionId: null,
};

describe("isActionAvailable / availableActions", () => {
  it("allows all opencode actions on a chat row", () => {
    for (const k of ["new", "clear", "fork", "compact"] as const) {
      expect(isActionAvailable(k, chatRow)).toBe(true);
    }
    expect(availableActions(chatRow)).toEqual(["new", "fork", "compact"]);
  });

  it("blocks every action on a terminal row (no opencode session)", () => {
    for (const k of ["new", "clear", "fork", "compact"] as const) {
      expect(isActionAvailable(k, terminalRow)).toBe(false);
    }
    expect(availableActions(terminalRow)).toEqual([]);
  });

  it("treats a chat row with a missing session id as unavailable", () => {
    const broken = { ...chatRow, opencodeSessionId: null };
    expect(availableActions(broken)).toEqual([]);
  });
});

describe("resolveSessionAction", () => {
  it("maps new/clear to opencode:clear-session with the window payload", () => {
    for (const kind of ["new", "clear"] as const) {
      const req = resolveSessionAction(kind, chatRow, { title: "Fresh" });
      expect(req?.channel).toBe("opencode:clear-session");
      const payload = req?.payload as ClearSessionPayload;
      expect(payload).toMatchObject({
        sessionName: "better-ui",
        windowIndex: 0,
        title: "Fresh",
      });
    }
  });

  it("maps fork to opencode:fork-session carrying the source session id", () => {
    const req = resolveSessionAction("fork", chatRow, { messageID: "msg_9" });
    expect(req?.channel).toBe("opencode:fork-session");
    const payload = req?.payload as ForkSessionPayload;
    expect(payload).toMatchObject({
      sessionId: "sess_abc",
      sessionName: "better-ui",
      windowName: "main",
      messageID: "msg_9",
    });
  });

  it("maps compact to opencode:compact-session with the raw session id", () => {
    const req = resolveSessionAction("compact", chatRow);
    expect(req?.channel).toBe("opencode:compact-session");
    const payload = req?.payload as CompactSessionPayload;
    expect(payload).toEqual({ sessionId: "sess_abc" });
  });

  it("returns null for any action on a terminal row", () => {
    for (const k of ["new", "clear", "fork", "compact"] as const) {
      expect(resolveSessionAction(k, terminalRow)).toBeNull();
    }
  });

  it("omits optional fields when not provided", () => {
    const req = resolveSessionAction("new", chatRow);
    const payload = req?.payload as ClearSessionPayload;
    expect(payload.title).toBeUndefined();
    expect(payload.cwd).toBeUndefined();
  });
});

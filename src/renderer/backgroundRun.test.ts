import { describe, expect, it, vi } from "vitest";
import type { OpencodeMessage } from "../shared/types";
import { MANTA_BUILTIN_NAMES, computeLiveTurn, computeTurnInfo } from "./chatUtils";
import {
  backgroundBoxVisible,
  backgroundRequested,
  collectFinishedKeys,
  deriveBackgroundCards,
  isBackgroundResultMessage,
  isCardCandidate,
  openJobSession,
  overlaySegments,
  parseSlashToken,
  resultStateLabel,
  resultTitle,
  resultTone,
  sameBackgroundCards,
  splitSlashText,
  type BackgroundJob,
} from "./backgroundRun";

const COMMANDS = [
  { name: "review" },
  { name: "init" },
  { name: "impeccable" }, // a skill — listed with the commands
  { name: "deploy", background: true as const },
  { name: "clear" }, // an opencode command that shares a Manta built-in's name
];

const token = (text: string) => parseSlashToken(text, COMMANDS, MANTA_BUILTIN_NAMES);

describe("parseSlashToken (the highlight validity matrix)", () => {
  it("a known opencode command is valid, with or without arguments", () => {
    expect(token("/review")).toEqual({ kind: "opencode", name: "review", end: 7, alwaysBackground: false });
    expect(token("/review HEAD~1")).toEqual({ kind: "opencode", name: "review", end: 7, alwaysBackground: false });
    expect(token("/review\n  two lines")?.end).toBe(7);
  });
  it("a skill is valid (it arrives in the same list)", () => {
    expect(token("/impeccable polish this")?.kind).toBe("opencode");
  });
  it("a Manta built-in is valid but is not an opencode command (wins over a same-named opencode one)", () => {
    expect(token("/fork")).toEqual({ kind: "manta", name: "fork", end: 5, alwaysBackground: false });
    expect(token("/compact now")?.kind).toBe("manta");
    expect(token("/clear")?.kind).toBe("manta");
  });
  it("an unknown name, a partial name or an unknown-until-loaded list is not valid", () => {
    expect(token("/revie")).toBeNull();
    expect(token("/reviewx")).toBeNull();
    expect(token("/")).toBeNull();
    expect(parseSlashToken("/review", null, MANTA_BUILTIN_NAMES)).toBeNull();
    expect(parseSlashToken("/review", undefined, MANTA_BUILTIN_NAMES)).toBeNull();
  });
  it("the slash must be the first character: a leading space or mid-text slash is not valid", () => {
    expect(token(" /review")).toBeNull();
    expect(token("please run /review")).toBeNull();
    expect(token("hello\n/review")).toBeNull();
    expect(token("")).toBeNull();
  });
  it("names are exact (case-sensitive), like the send path", () => {
    expect(token("/Review")).toBeNull();
  });
  it("a command the box proved background is flagged alwaysBackground", () => {
    expect(token("/deploy now")).toEqual({ kind: "opencode", name: "deploy", end: 7, alwaysBackground: true });
  });
});

describe("the Run in background box", () => {
  it("is offered for opencode commands and skills only — never a Manta built-in, never plain text", () => {
    expect(backgroundBoxVisible(token("/review x"))).toBe(true);
    expect(backgroundBoxVisible(token("/impeccable"))).toBe(true);
    expect(backgroundBoxVisible(token("/fork"))).toBe(false);
    expect(backgroundBoxVisible(token("/nope"))).toBe(false);
    expect(backgroundBoxVisible(token("hello"))).toBe(false);
    expect(backgroundBoxVisible(null)).toBe(false);
  });
  it("a send is a background run only when the box is open AND ticked, or the command is locked", () => {
    expect(backgroundRequested(token("/review"), false)).toBe(false);
    expect(backgroundRequested(token("/review"), true)).toBe(true);
    expect(backgroundRequested(token("/deploy"), false)).toBe(true);
    // A stale tick can never survive the box closing.
    expect(backgroundRequested(token("/fork"), true)).toBe(false);
    expect(backgroundRequested(token("please /review"), true)).toBe(false);
    expect(backgroundRequested(null, true)).toBe(false);
  });
});

describe("overlaySegments (alignment)", () => {
  const samples = ["/review", "/review HEAD~1", "/review\nsecond line  ", "/review\n", "/impeccable   spaced   args"];
  it("the segments always concatenate to exactly the text — the overlay never drifts from the textarea", () => {
    for (const text of samples) {
      const segs = overlaySegments(text, token(text));
      expect(segs.map((s) => s.text).join("")).toBe(text);
    }
    expect(overlaySegments("plain", null).map((s) => s.text).join("")).toBe("plain");
  });
  it("only the /name token is marked; arguments stay plain", () => {
    expect(overlaySegments("/review HEAD~1", token("/review HEAD~1"))).toEqual([
      { text: "/review", command: true },
      { text: " HEAD~1", command: false },
    ]);
    expect(overlaySegments("/review", token("/review"))).toEqual([{ text: "/review", command: true }]);
    expect(overlaySegments("nothing here", null)).toEqual([{ text: "nothing here", command: false }]);
  });
});

describe("splitSlashText", () => {
  it("splits name and arguments the way the send path does", () => {
    expect(splitSlashText("/review HEAD~1 --deep")).toEqual({ name: "review", args: "HEAD~1 --deep" });
    expect(splitSlashText("/init")).toEqual({ name: "init", args: "" });
    expect(splitSlashText("hello")).toBeNull();
  });
});

const job = (over: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "job1",
  name: "/review HEAD~1",
  parentSessionID: "ses_p",
  childSessionID: "ses_c1",
  status: "running",
  error: null,
  createdAt: 1,
  ...over,
});
const none = { jobIds: new Set<string>(), childIds: new Set<string>() };

describe("deriveBackgroundCards (N5)", () => {
  it("a running or paused job of this session gets a running card", () => {
    expect(deriveBackgroundCards([job()], "ses_p", none)).toEqual([
      { kind: "running", key: "job1", jobId: "job1", name: "/review HEAD~1", paused: false },
    ]);
    expect(deriveBackgroundCards([job({ status: "paused" })], "ses_p", none)[0]).toMatchObject({
      kind: "running",
      paused: true,
    });
  });
  it("another session's jobs and terminal jobs with nothing owed get no card", () => {
    expect(deriveBackgroundCards([job({ parentSessionID: "ses_other" })], "ses_p", none)).toEqual([]);
    expect(deriveBackgroundCards([job({ status: "done" })], "ses_p", none)).toEqual([]);
    expect(deriveBackgroundCards([job({ status: "stopped" })], "ses_p", none)).toEqual([]);
    // A job that failed AFTER it ran reports through its result message, not a card.
    expect(deriveBackgroundCards([job({ status: "failed", launchState: "running", error: "x" })], "ses_p", none)).toEqual([]);
  });
  it("an uncertain launch is the 'couldn't confirm' card, never a running one", () => {
    expect(deriveBackgroundCards([job({ launchState: "uncertain" })], "ses_p", none)).toEqual([
      { kind: "uncertain", key: "job1", jobId: "job1", name: "/review HEAD~1" },
    ]);
  });
  it("a job that failed before its child ran becomes a failure card carrying the error", () => {
    const failed = job({ status: "failed", launchState: "submitting", error: "the box is at its limit" });
    expect(deriveBackgroundCards([failed], "ses_p", none)).toEqual([
      { kind: "failed", key: "job1", jobId: "job1", name: "/review HEAD~1", error: "the box is at its limit" },
    ]);
    expect(deriveBackgroundCards([job({ status: "failed", launchState: "creating", error: null })], "ses_p", none)[0]).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("failed"),
    });
  });
  it("a Manta-owned job whose result is still on its way keeps a card until the result lands", () => {
    const j = job({ status: "done", launchState: "running", completionOwner: "manta", completionDelivery: "pending" });
    expect(deriveBackgroundCards([j], "ses_p", none)[0]).toMatchObject({ kind: "settling" });
    expect(deriveBackgroundCards([{ ...j, completionDelivery: "delivered" }], "ses_p", none)).toEqual([]);
    expect(deriveBackgroundCards([{ ...j, completionOwner: "opencode" }], "ses_p", none)).toEqual([]);
  });
  it("is replaced by its finished card — paired by jobId, falling back to the child session id — never shown twice", () => {
    expect(deriveBackgroundCards([job()], "ses_p", { jobIds: new Set(["job1"]), childIds: new Set() })).toEqual([]);
    expect(deriveBackgroundCards([job()], "ses_p", { jobIds: new Set(), childIds: new Set(["ses_c1"]) })).toEqual([]);
    // Another job's result does not hide this one.
    expect(deriveBackgroundCards([job()], "ses_p", { jobIds: new Set(["other"]), childIds: new Set(["ses_zzz"]) })).toHaveLength(1);
  });
  it("lists several jobs oldest first", () => {
    const cards = deriveBackgroundCards(
      [job({ id: "b", createdAt: 5 }), job({ id: "a", createdAt: 2, childSessionID: "ses_c2" })],
      "ses_p",
      none,
    );
    expect(cards.map((c) => c.jobId)).toEqual(["a", "b"]);
  });
});

describe("isCardCandidate", () => {
  it("is the cheap pre-filter for deriveBackgroundCards", () => {
    expect(isCardCandidate(job(), "ses_p")).toBe(true);
    expect(isCardCandidate(job({ status: "done" }), "ses_p")).toBe(false);
    expect(isCardCandidate(job({ parentSessionID: "x" }), "ses_p")).toBe(false);
    expect(isCardCandidate(job({ status: "failed", launchState: "creating" }), "ses_p")).toBe(true);
    expect(isCardCandidate(job({ status: "done", completionOwner: "manta", completionDelivery: "pending" }), "ses_p")).toBe(true);
  });
});

const resultMsg = (id: string, part: Record<string, unknown>): OpencodeMessage => ({
  info: { id, sessionID: "ses_p", role: "assistant", time: { created: 10 }, background: true } as OpencodeMessage["info"],
  parts: [{ id: `${id}:bg`, messageID: id, type: "background-result", state: "completed", text: "ok", childSessionId: "ses_c1", ...part }],
});

describe("collectFinishedKeys / sameBackgroundCards", () => {
  it("reads both pairing keys off the background-result parts", () => {
    const keys = collectFinishedKeys([
      resultMsg("m1", { jobId: "job1", childSessionId: "ses_c1" }),
      resultMsg("m2", { childSessionId: "ses_c9" }),
      { info: { id: "m3", sessionID: "ses_p", role: "user" }, parts: [{ id: "p", messageID: "m3", type: "text", text: "hi" }] },
    ]);
    expect([...keys.jobIds]).toEqual(["job1"]);
    expect([...keys.childIds].sort()).toEqual(["ses_c1", "ses_c9"]);
    expect(collectFinishedKeys(null).jobIds.size).toBe(0);
  });
  it("compares card lists field for field", () => {
    const a = deriveBackgroundCards([job()], "ses_p", none);
    expect(sameBackgroundCards(a, deriveBackgroundCards([job()], "ses_p", none))).toBe(true);
    expect(sameBackgroundCards(a, deriveBackgroundCards([job({ status: "paused" })], "ses_p", none))).toBe(false);
    expect(sameBackgroundCards(a, [])).toBe(false);
  });
});

describe("finished-card copy", () => {
  it("maps a state to a tone and a label", () => {
    expect(resultTone("completed")).toBe("ok");
    expect(resultTone("failed")).toBe("danger");
    expect(resultTone("cancelled")).toBe("neutral");
    expect(resultStateLabel("completed")).toBe("done");
    expect(resultStateLabel("failed")).toBe("failed");
    expect(resultStateLabel("")).toBe("finished");
  });
  it("names the card after the command, else the agent, else plainly", () => {
    expect(resultTitle({ name: "/review HEAD~1", agent: "general" })).toBe("/review HEAD~1");
    expect(resultTitle({ agent: "general" })).toBe("general subagent");
    expect(resultTitle({})).toBe("Background session");
  });
});

describe("openJobSession (both outcomes are reported)", () => {
  it("success selects the returned window and reports ok", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    const r = await openJobSession("job1", {
      open: vi.fn().mockResolvedValue({ ok: true, tmuxSession: "proj", windowIndex: 3 }),
      select,
    });
    expect(r).toEqual({ ok: true });
    expect(select).toHaveBeenCalledWith("proj", 3);
  });
  it("a refusal reports the box's message and selects nothing", async () => {
    const select = vi.fn();
    const r = await openJobSession("job1", {
      open: vi.fn().mockResolvedValue({ ok: false, error: "the session no longer exists" }),
      select,
    });
    expect(r).toEqual({ ok: false, error: "the session no longer exists" });
    expect(select).not.toHaveBeenCalled();
  });
  it("a throw, a malformed answer and a failing selection are each an error", async () => {
    const select = vi.fn();
    const thrown = await openJobSession("job1", { open: vi.fn().mockRejectedValue(new Error("unknown rpc channel")), select });
    expect(thrown).toEqual({ ok: false, error: "Couldn't open the session: unknown rpc channel" });
    const malformed = await openJobSession("job1", { open: vi.fn().mockResolvedValue(undefined), select });
    expect(malformed.ok).toBe(false);
    const missingWindow = await openJobSession("job1", { open: vi.fn().mockResolvedValue({ ok: true, tmuxSession: "p" }), select });
    expect(missingWindow.ok).toBe(false);
    expect(select).not.toHaveBeenCalled();
    const selectFails = await openJobSession("job1", {
      open: vi.fn().mockResolvedValue({ ok: true, tmuxSession: "p", windowIndex: 0 }),
      select: vi.fn().mockRejectedValue(new Error("tmux is down")),
    });
    expect(selectFails).toEqual({ ok: false, error: "Couldn't switch to the session: tmux is down" });
  });
});

describe("a finished background run is a turn boundary", () => {
  const user = (id: string, created: number): OpencodeMessage => ({
    info: { id, sessionID: "ses_p", role: "user", time: { created } },
    parts: [{ id: `${id}:t`, messageID: id, type: "text", text: "go" }],
  });
  const asst = (id: string, created: number, completed: number): OpencodeMessage => ({
    info: { id, sessionID: "ses_p", role: "assistant", time: { created, completed } },
    parts: [{ id: `${id}:t`, messageID: id, type: "text", text: "done" }],
  });

  it("recognises the N4 message", () => {
    expect(isBackgroundResultMessage(resultMsg("m", {}))).toBe(true);
    expect(isBackgroundResultMessage(asst("a", 1, 2))).toBe(false);
  });
  it("the earlier turn keeps its footer; the reply to the result gets its own", () => {
    const msgs = [user("u1", 0), asst("a1", 1, 5000), resultMsg("r1", {}), asst("a2", 600_000, 604_000)];
    const info = computeTurnInfo(msgs, false);
    expect(info.get("a1")?.turnDurationMs).toBe(4999);
    expect(info.has("r1")).toBe(false);
    // The reply's duration is its own, not a span back across the idle gap.
    expect(info.get("a2")?.turnDurationMs).toBe(4000);
  });
  it("the live turn after a result starts at the reply, not at the old user message", () => {
    const msgs = [user("u1", 0), asst("a1", 1, 5000), resultMsg("r1", {}), asst("a2", 600_000, 604_000)];
    expect(computeLiveTurn(msgs)).toMatchObject({ startedAt: 600_000, verbSeedId: "a2" });
    expect(computeLiveTurn([user("u1", 0), asst("a1", 1, 5000), resultMsg("r1", {})])).toMatchObject({ startedAt: 10 });
  });
});

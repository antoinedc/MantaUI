// WS11 D11 receiver-level tests for the per-connection run state: the epoch the LATEST connection announced, the connection
// counter that retires answers issued before a reconnect, and the tracked transcript fetches that feed the run map.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "./store";
import {
  getRunMap,
  ingestRunFrame,
  ingestRunMessages,
  onRunConnection,
  onRunEpoch,
  opencodeMessagesTracked,
  resetRunEpochState,
} from "./runEpoch";
import type { OpencodeMessage, RunView, StreamToolRunsPayload } from "../shared/types";

const run = (id: string, label: string, rev: Partial<RunView["rev"]> = {}): RunView => ({
  id,
  ownerMessageId: "m1",
  label,
  calls: 1,
  failed: 0,
  tone: "ok",
  live: null,
  rev: { epoch: "E1", gen: 1, seq: 1, ...rev },
});
const msgWith = (...runs: RunView[]): OpencodeMessage =>
  ({ info: { id: "m1", sessionID: "s", role: "assistant" }, parts: [], view: { runs } }) as unknown as OpencodeMessage;
const frame = (runs: RunView[], extra: Partial<StreamToolRunsPayload> = {}): StreamToolRunsPayload => ({
  epoch: "E1",
  full: false,
  gen: 1,
  layout: [],
  runs,
  closed: [],
  parts: [],
  ...extra,
});

beforeEach(() => {
  resetRunEpochState();
  useStore.setState({ runEpoch: { epoch: null, connGen: 0 } });
});

describe("run epoch + connection counter", () => {
  it("each (re)connect bumps connGen and forgets the epoch until the new runningSet", () => {
    onRunConnection();
    expect(useStore.getState().runEpoch).toEqual({ epoch: null, connGen: 1 });
    onRunEpoch("E1");
    expect(useStore.getState().runEpoch).toEqual({ epoch: "E1", connGen: 1 });
    onRunConnection();
    expect(useStore.getState().runEpoch).toEqual({ epoch: null, connGen: 2 });
  });

  it("a chat opened AFTER the snapshot reads the stored epoch (no per-chat subscription)", () => {
    onRunConnection();
    onRunEpoch("E1");
    // A chat that mounts now has never seen the runningSet frame, yet its first answer applies at once.
    ingestRunMessages("chat-late", [msgWith(run("A", "one"))], 1);
    expect(getRunMap("chat-late").runs.get("A")?.label).toBe("one");
  });

  it("writes before the first runningSet are queued, then applied through the same rules", () => {
    onRunConnection();
    ingestRunMessages("s", [msgWith(run("A", "early"))], 1);
    expect(getRunMap("s").runs.size).toBe(0);
    onRunEpoch("E1");
    expect(getRunMap("s").runs.get("A")?.label).toBe("early");
  });

  it("E1 fetch issued → E2 reconnect + snapshot → the E1 answer resolves: E2's values stay", async () => {
    onRunConnection();
    onRunEpoch("E1");
    let resolveE1: (m: OpencodeMessage[]) => void = () => {};
    vi.stubGlobal("window", {
      api: { opencodeMessages: () => new Promise<OpencodeMessage[]>((r) => (resolveE1 = r)) },
    });
    const pending = opencodeMessagesTracked("s", { view: true });
    // The connection drops and comes back on a restarted box.
    onRunConnection();
    onRunEpoch("E2");
    ingestRunFrame("s", frame([run("A", "from E2", { epoch: "E2", seq: 3 })], { epoch: "E2", full: true }));
    resolveE1([msgWith(run("A", "from E1", { epoch: "E1", seq: 99 }))]);
    await pending;
    expect(getRunMap("s").runs.get("A")?.label).toBe("from E2");
    vi.unstubAllGlobals();
  });

  it("a rebuilt frame deletes the retired run, and tells the caller to refetch once", () => {
    onRunConnection();
    onRunEpoch("E1");
    ingestRunFrame("s", frame([run("A", "a"), run("B", "b")]));
    const refetch = ingestRunFrame("s", frame([run("A", "merged", { gen: 2, seq: 5 })], { rebuilt: true, retired: ["B"], gen: 2, full: true }));
    expect(refetch).toBe(true);
    expect(getRunMap("s").runs.has("B")).toBe(false);
    expect(getRunMap("s").runs.get("A")?.label).toBe("merged");
    // A gen-1 value arriving afterwards is rejected.
    ingestRunFrame("s", frame([run("B", "back", { gen: 1, seq: 50 })]));
    expect(getRunMap("s").runs.has("B")).toBe(false);
  });

  it("a response carrying a membership older than minGen asks for a refetch (and an old connection's does not)", () => {
    onRunConnection();
    onRunEpoch("E1");
    ingestRunFrame("s", frame([run("A", "a", { gen: 2 })], { gen: 2, rebuilt: true, retired: [] }));
    const stale = { info: { id: "m", sessionID: "s", role: "assistant" }, parts: [{ id: "t", type: "tool", view: { runId: "A", gen: 1 } }] } as unknown as OpencodeMessage;
    expect(ingestRunMessages("s", [stale], 1)).toBe(true);
    onRunConnection();
    expect(ingestRunMessages("s", [stale], 1)).toBe(false);
  });
});

// @vitest-environment jsdom
// WS11 D11 review (NIT): useRunMap re-renders only for ITS session, not on every session's `toolRuns` frame.

import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "./store";
import { ingestRunFrame, onRunConnection, onRunEpoch, resetRunEpochState, useRunMap } from "./runEpoch";
import type { RunView, StreamToolRunsPayload } from "../shared/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (id: string, label: string): RunView => ({
  id,
  ownerMessageId: "m1",
  label,
  calls: 1,
  failed: 0,
  tone: "ok",
  live: null,
  rev: { epoch: "E1", gen: 1, seq: 1 },
});
const frame = (runs: RunView[]): StreamToolRunsPayload => ({ epoch: "E1", full: false, gen: 1, layout: [], runs, closed: [], parts: [] });

beforeEach(() => {
  resetRunEpochState();
  useStore.setState({ runEpoch: { epoch: null, connGen: 0 } });
});

describe("useRunMap", () => {
  it("re-renders only for its own session", () => {
    onRunConnection();
    onRunEpoch("E1");
    let renders = 0;
    let latest: ReturnType<typeof useRunMap> | null = null;
    function Probe() {
      renders++;
      latest = useRunMap("mine");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Probe />));
    const first = latest;
    const base = renders;
    act(() => void ingestRunFrame("other", frame([run("O", "other")])));
    expect(renders).toBe(base);
    expect(latest).toBe(first);
    act(() => void ingestRunFrame("mine", frame([run("M", "mine")])));
    expect(renders).toBe(base + 1);
    expect((latest as unknown as { runs: Map<string, RunView> }).runs.get("M")?.label).toBe("mine");
    act(() => root.unmount());
  });
});

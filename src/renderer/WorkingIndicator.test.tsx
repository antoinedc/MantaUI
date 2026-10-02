// @vitest-environment jsdom
//
// Component tests for WorkingIndicator (BET-694). The row is a real status
// line while a turn runs — loader + present-tense verb + live elapsed + token
// count — and it mounts/unmounts (animated by CardMount) instead of reserving
// a permanent slot, so idle renders NO row. We assert the rendered text, not
// pixels.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { WorkingIndicator } from "./Transcript";
import { presentVerbFor } from "./chatShared";
import type { LiveTurn } from "./chatUtils";
import { pinDemoClock } from "./clock";
import { useStore } from "./store";
import type { ToolGroup } from "./toolActivity";
import type { OpencodePart } from "../shared/types";

// A fixed clock anchor; the elapsed label is a function of this, not the wall
// clock. startedAt is 103s before the anchor so formatDuration renders "1m43s".
const T0 = 1_700_000_000_000;

function makeLiveTurn(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return { startedAt: T0 - 103_000, tokens: 432, verbSeedId: "msg_1", ...overrides };
}

describe("WorkingIndicator", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    useStore.setState({ videoRenderNow: null });
  });

  it("renders the present verb, live elapsed, and token count while running", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn();
    h = mount(<WorkingIndicator running liveTurn={liveTurn} />);
    const expected = `${presentVerbFor(liveTurn.verbSeedId)}… · 1m43s · 432 tokens`;
    // Collapse whitespace: the row interleaves segments as separate text
    // nodes within a flex span, so text() joins without the " · " separators
    // except where they are literal strings. Match on a normalized form.
    expect(h!.text().replace(/\s+/g, " ").trim()).toContain(expected);
    // The loader is still there (existing assertion).
    expect(h!.container.querySelector("svg")).toBeTruthy();
  });

  it("renders NO token segment when tokens is 0", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn({ tokens: 0 });
    h = mount(<WorkingIndicator running liveTurn={liveTurn} />);
    const text = h!.text();
    expect(text).toContain(`${presentVerbFor(liveTurn.verbSeedId)}… · 1m43s`);
    expect(text).not.toContain("tokens");
  });

  it("falls back to the loader + label when running but liveTurn is null", () => {
    h = mount(<WorkingIndicator running liveTurn={null} />);
    expect(h!.text()).toContain("Working…");
    expect(h!.container.querySelector("svg")).toBeTruthy();
    expect(h!.text()).not.toContain("NaN");
    expect(h!.text()).not.toContain("undefined");
  });

  it("renders no row when idle — no reserved slot above the composer", () => {
    h = mount(<WorkingIndicator running={false} liveTurn={null} />);
    expect(h!.container.querySelector(".manta-working-indicator")).toBeNull();
  });

  it("owns no vertical margin — the tail container's gap does the spacing", () => {
    h = mount(<WorkingIndicator running liveTurn={makeLiveTurn()} />);
    const row = h!.container.querySelector(".manta-working-indicator") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.marginTop).toBe("");
    expect(row.style.marginBottom).toBe("");
  });

  it("renders the working progress label as a headline + faint meta tail (BET-791 [C8])", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn();
    const progress = {
      sessionID: "s1",
      label: "Running integration tests",
      step: 3,
      total: 5,
      state: "working" as const,
      detail: "",
      updatedAt: 0,
    };
    h = mount(<WorkingIndicator running liveTurn={liveTurn} progress={progress} />);
    const label = h!.container.querySelector(".text-text.font-medium");
    expect(label?.textContent).toBe("Running integration tests");
    const meta = h!.container.querySelector(".text-text-faint.text-meta");
    expect(meta?.textContent).toBe("· 3/5 · 1m43s · 432 tokens");
  });

  it("does NOT split out a blocked progress label — it yields to the blocked card", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn();
    const progress = {
      sessionID: "s1",
      label: "Running integration tests",
      step: 3,
      total: 5,
      state: "blocked" as const,
      detail: "decide",
      updatedAt: 0,
    };
    h = mount(<WorkingIndicator running liveTurn={liveTurn} progress={progress} />);
    expect(h!.container.querySelector(".text-text.font-medium")).toBeNull();
    const meta = h!.container.querySelector(".text-text-faint.text-meta");
    expect(meta?.textContent).toBe(`${presentVerbFor(liveTurn.verbSeedId)}… · 1m43s · 432 tokens`);
  });

  // ----- Tool run at the tail (collapsed tool activity) -----

  let n = 0;
  const tool = (name: string, input: Record<string, unknown>, status = "completed") =>
    ({ id: `t${++n}`, messageID: "m", type: "tool", tool: name, state: { status, input } }) as OpencodePart;
  const group = (...items: OpencodePart[]): ToolGroup => ({ id: items[0].id, items });
  const headline = () => h!.container.querySelector(".text-text.font-medium")?.textContent;
  const meta = () => h!.container.querySelector(".text-text-faint.text-meta")?.textContent;
  const workingProgress = {
    sessionID: "s1",
    label: "Step 3/5: wiring the handler",
    step: 3,
    total: 5,
    state: "working" as const,
    detail: "",
    updatedAt: 0,
  };

  it("headlines the LIVE tool with its meta run (count, elapsed, tokens)", () => {
    pinDemoClock(T0);
    const g = group(
      tool("read", { filePath: "/a/x.ts" }),
      tool("read", { filePath: "/a/y.ts" }),
      tool("edit", { filePath: "/src/Transcript.tsx" }, "running"),
    );
    h = mount(<WorkingIndicator running liveTurn={makeLiveTurn()} toolGroup={g} />);
    expect(headline()).toBe("Editing Transcript.tsx…");
    expect(meta()).toBe("· 3 tools · 1m43s · 432 tokens");
    expect(h.container.querySelector("button")).toBeTruthy(); // clickable
  });

  it("omits 'N tools' for a single tool, and treats a pending tool as live", () => {
    pinDemoClock(T0);
    const g = group(tool("bash", { description: "Run the tests" }, "pending"));
    h = mount(<WorkingIndicator running liveTurn={makeLiveTurn()} toolGroup={g} />);
    expect(headline()).toBe("Run the tests…");
    expect(meta()).toBe("· 1m43s · 432 tokens");
  });

  it("shows the red failed count after the meta", () => {
    pinDemoClock(T0);
    const g = group(
      tool("bash", { description: "a" }, "error"),
      tool("bash", { description: "b" }, "running"),
    );
    h = mount(<WorkingIndicator running liveTurn={makeLiveTurn()} toolGroup={g} />);
    const failed = h.container.querySelector(".text-danger");
    expect(failed?.textContent).toBe("· 1 failed");
  });

  it("between tools: keeps today's verb and moves the run summary into the meta", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn();
    const g = group(
      tool("read", { filePath: "/a/x.ts" }),
      tool("read", { filePath: "/a/y.ts" }),
      tool("bash", { command: "ls" }),
    );
    h = mount(<WorkingIndicator running liveTurn={liveTurn} toolGroup={g} />);
    expect(headline()).toBeUndefined();
    expect(meta()).toBe(
      `${presentVerbFor(liveTurn.verbSeedId)}… · Read 2 files, ran a command · 1m43s · 432 tokens`,
    );
  });

  it("progress label + live tool: the tool wins the headline, the label moves into the meta", () => {
    pinDemoClock(T0);
    const g = group(
      tool("write", { filePath: "/a/h.mjs" }),
      tool("edit", { filePath: "/a/i.mjs" }),
      tool("bash", { description: "Typecheck" }, "running"),
    );
    h = mount(
      <WorkingIndicator running liveTurn={makeLiveTurn()} progress={workingProgress} toolGroup={g} />,
    );
    expect(headline()).toBe("Typecheck…");
    expect(meta()).toBe("· Step 3/5: wiring the handler · 3 tools · 1m43s · 432 tokens");
  });

  it("progress label, no running tool: today's progress rendering is kept", () => {
    pinDemoClock(T0);
    const g = group(tool("read", { filePath: "/a/x.ts" }));
    h = mount(
      <WorkingIndicator running liveTurn={makeLiveTurn()} progress={workingProgress} toolGroup={g} />,
    );
    expect(headline()).toBe("Step 3/5: wiring the handler");
    expect(meta()).toBe("· 3/5 · 1m43s · 432 tokens");
  });

  it("no tail run: no button, no chevron — exactly today's line", () => {
    pinDemoClock(T0);
    h = mount(<WorkingIndicator running liveTurn={makeLiveTurn()} toolGroup={null} />);
    expect(h.container.querySelector("button")).toBeNull();
  });
});

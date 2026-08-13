// @vitest-environment jsdom
//
// Pure-rendering tests for tool part rendering. The `TaskBody` cases
// below need jsdom because they mount a real React subtree via
// `./testHarness`.

import { act, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { AssistantPart, ToolCall, formatFileDiff } from "./ToolCall";
import {
  installMockApi,
  mount,
  type Harness,
} from "./testHarness";
import { TaskCard } from "./TaskCard";
import { TaskContext, type TaskContextValue, type ToolState } from "./chatShared";
import { TRANSCRIPT_TAIL_LIMIT } from "./hooks/useTranscriptState";
import type { OpencodePart, OpencodeMessage } from "../shared/types";

// Tool-call cards start COLLAPSED. Mounting a <ToolCall> hides its body until
// the disclosure is clicked, so tests that assert on the body expand first.
// The click flips internal expanded state, so it must run inside act() for the
// re-render to flush before the next synchronous assertion.
function expandAll(container: Element) {
  for (const b of Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'))) {
    act(() => b.click());
  }
}

// A minimal task tool part that extractSubagentInfo accepts (it requires
// state.metadata.sessionId to be present, otherwise it returns null and the
// TaskBody card doesn't render at all).
function taskPart(input: Record<string, unknown> = {}): OpencodePart {
  return {
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      input,
      metadata: { sessionId: "ses_child" },
      time: { start: 0, end: 18000 },
    },
  } as unknown as OpencodePart;
}

describe("formatFileDiff", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders +N in ok and −N in danger when both are present", () => {
    installMockApi();
    h = mount(<>{formatFileDiff(38, 4)}</>);
    const text = h.text() ?? "";
    expect(text).toContain("+38");
    expect(text).toContain("−4");
    const ok = h.container.querySelector(".text-ok");
    const danger = h.container.querySelector(".text-danger");
    expect(ok?.textContent).toBe("+38");
    expect(danger?.textContent).toBe("−4");
  });

  it("omits the −N count when deletions are zero", () => {
    installMockApi();
    h = mount(<>{formatFileDiff(20, 0)}</>);
    expect(h.text()).toContain("+20");
    expect(h.text()).not.toContain("−");
  });

  it("omits the +N count when additions are zero", () => {
    installMockApi();
    h = mount(<>{formatFileDiff(0, 3)}</>);
    expect(h.text()).toContain("−3");
    expect(h.text()).not.toContain("+");
  });

  it("renders nothing when both are zero", () => {
    installMockApi();
    h = mount(<>{formatFileDiff(0, 0)}</>);
    expect(h.text() ?? "").toBe("");
  });
});

describe("tool card chrome", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // An unrecognized tool falls through to ToolOutput, which is where the
  // nested-scroller bug lived: the well was given `max-h-64 overflow-y-auto`
  // AND the <pre> inside it declared the same cap, so the card carried two
  // vertical scrollbars over one body.
  function outputPart(output: string): OpencodePart {
    return {
      type: "tool",
      tool: "plugins_plugin_list",
      state: { status: "completed", output },
    } as unknown as OpencodePart;
  }

  it("gives a tool output body exactly ONE scroll container", () => {
    installMockApi();
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    h = mount(<ToolCall part={outputPart(long)} verbose={false} />);
    // The card is collapsed by default; expand it to render the body.
    expandAll(h.container);
    const scrollers = h.container.querySelectorAll(".overflow-y-auto");
    expect(scrollers.length).toBe(1);
    // …and it is the <pre>, because that is the element the pin-to-bottom
    // effect measures.
    expect(scrollers[0].tagName).toBe("PRE");
  });

  it("does not pad the card with blank rows for a command's trailing newlines", () => {
    installMockApi();
    // `git push` (and pytest, and most commands) end their output with one or
    // more newlines; each was rendering as a full-height blank row inside the
    // well, which read as a padding bug at the bottom of the card.
    const part = {
      type: "tool",
      tool: "bash",
      state: { status: "completed", output: "To github.com\n  main -> main\n\n\n" },
    } as unknown as OpencodePart;
    h = mount(<ToolCall part={part} verbose={false} />);
    expandAll(h.container);
    const rows = Array.from(h.container.querySelectorAll("div.whitespace-pre-wrap"));
    expect(rows.map((r) => r.textContent)).toEqual(["To github.com", "  main -> main"]);
  });

  it("puts the copy button in the card header, not floating over the body", () => {
    installMockApi();
    h = mount(<ToolCall part={outputPart("hello")} verbose={false} />);
    const copy = h.container.querySelector('[aria-label="Copy"]');
    expect(copy).toBeTruthy();
    // The header is the card shell's first child; the copy button must be
    // inside it (and therefore not absolutely positioned over the output).
    const header = h.container.firstElementChild?.firstElementChild;
    expect(header?.contains(copy!)).toBe(true);
    expect(copy!.className).not.toContain("absolute");
  });

  it("does not nest a copy button inside a disclosure header (invalid HTML)", () => {
    installMockApi();
    // The tool card's disclosure header is a <button>; a copy button inside it
    // would be unclickable and invalid markup — copy and chevron are its
    // siblings instead.
    h = mount(<ToolCall part={taskPart({ subagent_type: "explore" })} verbose={false} />);
    for (const btn of Array.from(h.container.querySelectorAll("button"))) {
      expect(btn.querySelector("button")).toBeNull();
    }
  });

  it("renders tool cards collapsed by default and shows the body only when expanded", () => {
    installMockApi();
    h = mount(<ToolCall part={outputPart("visible after expand")} verbose={false} />);
    // Collapsed: the output body is absent from the DOM.
    expect(h.text()).not.toContain("visible after expand");
    const toggle = h.container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    act(() => toggle.click());
    expect(h.text()).toContain("visible after expand");
  });

  it("shows both the copy button and the collapse chevron in the header of a standard tool card", () => {
    installMockApi();
    h = mount(<ToolCall part={outputPart("copyable output")} verbose={false} />);
    expect(h.container.querySelector('[aria-label="Copy"]')).toBeTruthy();
    expect(h.container.querySelector('button[aria-expanded="false"]')).toBeTruthy();
  });
});

describe("non-tool assistant parts", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // patch / file / unknown parts used to render as bare `⎿ …` mono rows on the
  // page background, which read as tool output that had escaped its card.
  it("renders a patch part as a card, not a bare ⎿ row", () => {
    installMockApi();
    h = mount(
      <AssistantPart
        part={{ type: "patch", files: ["/a/b.py", "/c/d.ts"] } as unknown as OpencodePart}
        showThinking={false}
      />,
    );
    // AssistantPart always wraps its body in a stable slide-wrapper div now, so
    // the card shell is the wrapper's child rather than the container's first
    // element — query for it directly.
    expect(h.container.querySelector(".border-border-subtle")).toBeTruthy();
    expect(h.text()).toContain("Patch");
    expect(h.text()).toContain("2 files");
    expect(h.text() ?? "").not.toContain("⎿");
  });

  // A patch card is collapsible + collapsed by default like every other
  // machine-action card — no minimum-lines gate; even a one-file patch starts
  // collapsed behind a chevron.
  it("renders a patch part collapsed by default with a working chevron", () => {
    installMockApi();
    h = mount(
      <AssistantPart
        part={{ type: "patch", files: ["/a/b.py", "/c/d.ts"] } as unknown as OpencodePart}
        showThinking={false}
      />,
    );
    // Chevron present, body hidden initially.
    const toggle = h.container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(h.text()).not.toContain("/a/b.py");
    // Expanding reveals the file list.
    act(() => toggle.click());
    expect(h.text()).toContain("/a/b.py");
    expect(h.text()).toContain("/c/d.ts");
  });

  it("renders a single-file patch collapsed too (no size threshold to collapse)", () => {
    installMockApi();
    h = mount(
      <AssistantPart
        part={{ type: "patch", files: ["/only/one.ts"] } as unknown as OpencodePart}
        showThinking={false}
      />,
    );
    const toggle = h.container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(h.text()).not.toContain("/only/one.ts");
    act(() => toggle.click());
    expect(h.text()).toContain("/only/one.ts");
  });

  // A file part is header-only: filename + mime IS the whole card. It gets NO
  // chevron on purpose — same rule as the unrecognized-part fallback. A
  // disclosure whose expanded state repeats its own header is worse than none.
  it("renders a file part as a header-only card with no chevron", () => {
    installMockApi();
    h = mount(
      <AssistantPart
        part={{ type: "file", filename: "report.pdf", mime: "application/pdf" } as unknown as OpencodePart}
        showThinking={false}
      />,
    );
    expect(h.container.querySelector(".border-border-subtle")).toBeTruthy();
    expect(h.text()).toContain("report.pdf");
    expect(h.text() ?? "").not.toContain("⎿");
    expect(h.container.querySelector("button[aria-expanded]")).toBeNull();
  });
});

describe("TaskBody subagent row", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the agent name once, on the chevron line (no duplicate in meta row)", () => {
    // The harness installs a mock window.api so any module-level access from
    // ToolCall's transitive imports doesn't blow up.
    installMockApi();
    h = mount(
      <ToolCall
        part={taskPart({ description: "Find where skills are loaded", subagent_type: "explore" })}
        verbose={false}
      />,
    );
    // The outer tool card is collapsed by default; expand it to mount TaskCard.
    expandAll(h.container);
    const text = h.text();
    const matches = text.match(/explore/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("still renders the agent name when description is empty (row is unconditional)", () => {
    installMockApi();
    h = mount(
      <ToolCall
        part={taskPart({ subagent_type: "explore" })}
        verbose={false}
      />,
    );
    expandAll(h.container);
    expect(h.text()).toContain("explore");
  });

  it("falls back to 'subagent' when subagent_type is absent (from extractSubagentInfo)", () => {
    installMockApi();
    h = mount(
      <ToolCall
        part={taskPart({ description: "Find where skills are loaded" })}
        verbose={false}
      />,
    );
    expandAll(h.container);
    // The extractSubagentInfo fallback in chatUtils.ts is the literal
    // string "subagent"; the badge text is the only place that string can
    // appear when subagent_type is absent.
    expect(h.text()).toContain("subagent");
  });
});

// ===== TaskCard child-transcript "Load earlier" header (BET-683) =====
//
// Once a child's tail-first fetch fills the expanded card (>= TRANSCRIPT_TAIL_LIMIT)
// and the full history hasn't been pulled, TaskCard renders the shared
// LoadEarlierHeader above the first child message. Clicking it calls
// loadEarlierChild(childId); the header hides once the full fetch resolves
// (childLoadedAllRef flips true). This drives TaskCard directly via a
// TaskContext.Provider with controlled values.
describe("TaskCard child 'Load earlier' header", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function childMsg(i: number): OpencodeMessage {
    return {
      info: {
        id: `cmsg_${i}`,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: i, completed: i + 1 },
      },
      parts: [
        { type: "text", id: `prt_${i}`, messageID: `cmsg_${i}`, text: `child message ${i}` },
      ],
    } as OpencodeMessage;
  }

  // A TailHarness owns the childMessages + loadedAll ref so a test can flip the
  // "full history loaded" state and watch the header appear/disappear.
  function TailHarness({
    load,
  }: {
    load: (id: string) => void;
  }) {
    const [msgs, setMsgs] = useState<OpencodeMessage[]>(() =>
      Array.from({ length: TRANSCRIPT_TAIL_LIMIT }, (_, i) => childMsg(i)),
    );
    const [loadedAll] = useState<{ current: Map<string, boolean> }>(() => ({
      current: new Map<string, boolean>(),
    }));
    const ctx: TaskContextValue = {
      expanded: new Set(["ses_child"]),
      toggle: () => {},
      childMessages: new Map([["ses_child", msgs]]),
      childLoadedAllRef: loadedAll,
      loadEarlierChild: (id) => {
        load(id);
        loadedAll.current.set(id, true);
        // Force a re-render so the header re-evaluates (full history resolved).
        setMsgs((prev) => prev.slice());
      },
      loadingChildEarlier: new Set(),
      liveStatus: new Map(),
      showThinking: false,
    };
    return (
      <TaskContext.Provider value={ctx}>
        <TaskCard state={taskPart({ description: "subagent", subagent_type: "explore" }).state as ToolState} />
      </TaskContext.Provider>
    );
  }

  it("shows the header on a full tail, calls loadEarlierChild on click, and hides it when the full fetch resolves", async () => {
    const load = vi.fn();
    installMockApi();
    h = mount(<TailHarness load={load} />);
    await h.flush();

    // Tail fill (>= TRANSCRIPT_TAIL_LIMIT) + not loaded-all → header renders.
    expect(h.text()).toContain("Load earlier messages");

    const btn = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Load earlier"),
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    act(() => btn.click());
    await h.flush();

    // Clicking calls loadEarlierChild with the child's session id.
    expect(load).toHaveBeenCalledWith("ses_child");
    // Full history resolved → the header disappears.
    expect(h.text()).not.toContain("Load earlier messages");
  });

  it("does not render the header for a child transcript under the tail limit", async () => {
    // A sub-tail child transcript (no "Load earlier" affordance).
    function UnderLimitHarness() {
      const msgs = Array.from({ length: 3 }, (_, i) => childMsg(i));
      const ctx: TaskContextValue = {
        expanded: new Set(["ses_child"]),
        toggle: () => {},
        childMessages: new Map([["ses_child", msgs]]),
        childLoadedAllRef: { current: new Map<string, boolean>() },
        loadEarlierChild: () => {},
        loadingChildEarlier: new Set(),
        liveStatus: new Map(),
        showThinking: false,
      };
      return (
        <TaskContext.Provider value={ctx}>
          <TaskCard state={taskPart({ description: "subagent", subagent_type: "explore" }).state as ToolState} />
        </TaskContext.Provider>
      );
    }
    installMockApi();
    h = mount(<UnderLimitHarness />);
    await h.flush();
    expect(h.text()).not.toContain("Load earlier messages");
  });
});

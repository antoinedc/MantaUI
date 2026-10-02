// @vitest-environment jsdom
//
// ToolGroupRow (the collapsed line) and MessageRow's stand-alone layout, which
// is what a subagent transcript (TaskCard's plain .map) relies on.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ToolGroupRow } from "./ToolGroup";
import { MessageRow } from "./MessageRow";
import type { ToolGroup } from "./toolActivity";
import type { OpencodeMessage, OpencodePart } from "../shared/types";

let n = 0;
const tool = (name: string, input: Record<string, unknown>, status = "completed") =>
  ({
    id: `t${++n}`,
    messageID: "m",
    type: "tool",
    tool: name,
    state: { status, input, output: "OUT" },
  }) as OpencodePart;
const group = (...items: OpencodePart[]): ToolGroup => ({ id: items[0].id, items });

describe("ToolGroupRow", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const line = () => h!.container.querySelector(".manta-tool-group") as HTMLElement;

  it("renders the summary line collapsed, with no cards", () => {
    h = mount(
      <ToolGroupRow
        group={group(tool("read", { filePath: "a" }), tool("bash", { command: "ls" }))}
        showThinking={false}
      />,
    );
    expect(line().textContent).toContain("Read a file, ran a command");
    expect(line().getAttribute("aria-expanded")).toBe("false");
    expect(h.container.querySelectorAll("button")).toHaveLength(1);
  });

  it("reports failures in red and uses the warn dot", () => {
    h = mount(
      <ToolGroupRow
        group={group(tool("read", { filePath: "a" }, "error"), tool("read", { filePath: "b" }))}
        showThinking={false}
      />,
    );
    expect(line().querySelector(".text-danger")?.textContent).toBe("· 1 failed");
    expect(line().querySelector(".bg-warn")).toBeTruthy();
  });

  it("uses the running dot while a call is unfinished", () => {
    h = mount(
      <ToolGroupRow group={group(tool("read", { filePath: "a" }, "running"))} showThinking={false} />,
    );
    expect(line().querySelector(".bg-accent")).toBeTruthy();
  });

  it("expands to the tool cards behind a left rule", () => {
    h = mount(
      <ToolGroupRow
        group={group(tool("read", { filePath: "a" }), tool("read", { filePath: "b" }))}
        showThinking={false}
      />,
    );
    act(() => line().click());
    expect(h.container.querySelector(".border-l.border-border-subtle")).toBeTruthy();
    expect(h.container.querySelectorAll("button[aria-expanded]")).toHaveLength(3);
  });

  it("only pops in (data-motion) when the owning message is entering", () => {
    const g = group(tool("read", { filePath: "a" }));
    h = mount(<ToolGroupRow group={g} showThinking={false} />);
    expect(h.container.querySelector('[data-motion="part"]')).toBeNull();
    h.unmount();
    h = mount(<ToolGroupRow group={g} showThinking={false} entering />);
    expect(h.container.querySelector('[data-motion="part"]')).toBeTruthy();
  });
});

describe("MessageRow without a layout (subagent transcripts)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  const row = (parts: OpencodePart[], extra: Record<string, unknown> = {}) => {
    const msg = {
      info: { id: "a1", sessionID: "s", role: "assistant", time: { created: 1 } },
      parts,
    } as unknown as OpencodeMessage;
    return (
      <MessageRow
        msg={msg}
        showThinking={false}
        turnDurationMs={null}
        turnTokens={null}
        verbSeedId={null}
        truncation={null}
        commandInfo={null}
        {...extra}
      />
    );
  };

  it("lays itself out alone: text plus a collapsed line, no cards", () => {
    h = mount(
      row([
        { id: "x", messageID: "a1", type: "text", text: "Hello" } as OpencodePart,
        tool("read", { filePath: "a" }),
        tool("read", { filePath: "b" }),
      ]),
    );
    expect(h.text()).toContain("Hello");
    expect(h.container.querySelectorAll(".manta-tool-group")).toHaveLength(1);
    expect(h.text()).toContain("Read 2 files");
    expect(h.container.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
  });

  it("an absorbed message (explicit empty blocks) renders nothing", () => {
    h = mount(row([tool("read", { filePath: "a" })], { blocks: [] }));
    expect(h.container.querySelector("[data-message-id]")).toBeNull();
  });

  it("an empty message with a turn footer still renders the footer", () => {
    h = mount(row([], { blocks: [], turnDurationMs: 5000 }));
    expect(h.container.querySelector("[data-message-id]")).toBeTruthy();
    expect(h.text()).toContain("5s");
  });
});

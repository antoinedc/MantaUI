// @vitest-environment jsdom
//
// WS11 D8: the truncation badge shows the BOX's words — label always, the explanation only when the box sent one
// (an older box's live frame has none, and the badge then has no tooltip rather than a client-worded one).

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MessageRow } from "./MessageRow";
import type { OpencodeMessage, TruncationView } from "../shared/types";

describe("MessageRow truncation badge", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const render = (truncation: TruncationView | null) => {
    const msg = {
      info: { id: "a1", sessionID: "s", role: "assistant", time: { created: 1, completed: 2 } },
      parts: [{ id: "p1", messageID: "a1", type: "text", text: "Hello" }],
    } as unknown as OpencodeMessage;
    h = mount(
      <MessageRow msg={msg} showThinking={false} turnDurationMs={null} turnTokens={null} verbSeedId={null} truncation={truncation} commandInfo={null} />,
    );
  };

  it("renders the box's label and hint", () => {
    render({ kind: "output-cap", label: "truncated (output limit)", hint: "Response hit the per-turn output cap." });
    expect(h!.text()).toContain("truncated (output limit)");
    const badge = [...h!.container.querySelectorAll("span")].find((s) => s.textContent?.includes("truncated (output limit)"));
    expect(badge?.getAttribute("title")).toBe("Response hit the per-turn output cap.");
  });

  it("an older box's frame has no hint: the label shows and there is no explanation", () => {
    render({ kind: "context-wall", label: "truncated (context full)" });
    expect(h!.text()).toContain("truncated (context full)");
    const badge = [...h!.container.querySelectorAll("span")].find((s) => s.textContent?.includes("truncated (context full)"));
    expect(badge?.hasAttribute("title")).toBe(false);
  });

  it("no truncation, no badge", () => {
    render(null);
    expect(h!.text()).not.toContain("truncated");
  });
});

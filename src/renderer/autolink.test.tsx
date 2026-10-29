// @vitest-environment jsdom
//
// Every URL in the transcript is clickable: prose (schemeless), inline code, the
// user's bubble, tool output, and the WebFetch header — and one click opens it
// externally without toggling whatever card / row it sits in.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { MarkdownBody } from "./MarkdownBody";
import { MessageRow } from "./MessageRow";
import { BashBody, WebFetchBody } from "./ToolBodies";
import { Linkified } from "./Linkified";
import type { OpencodeMessage } from "../shared/types";

const anchors = (h: Harness) => Array.from(h.container.querySelectorAll("a"));
const hrefs = (h: Harness) => anchors(h).map((a) => a.getAttribute("href"));

describe("MarkdownBody autolinking", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("links a bare schemeless address in prose", () => {
    h = mount(<MarkdownBody text="Download from mantaui.com/downloads today." />);
    expect(hrefs(h)).toEqual(["https://mantaui.com/downloads"]);
    expect(anchors(h)[0].textContent).toBe("mantaui.com/downloads");
  });

  it("links a URL inside inline code and keeps the <code>", () => {
    h = mount(<MarkdownBody text="Open `https://docs.x.com/a` first" />);
    const code = h.container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.className).toBe("");
    expect(code!.querySelector("a")?.getAttribute("href")).toBe("https://docs.x.com/a");
  });

  it("links a schemeless host in inline code only when it is the whole span", () => {
    h = mount(<MarkdownBody text="Use `mantaui.com` or `curl mantaui.com` here" />);
    const codes = Array.from(h.container.querySelectorAll("code"));
    expect(codes[0].querySelector("a")?.getAttribute("href")).toBe("https://mantaui.com");
    expect(codes[1].querySelector("a")).toBeNull();
  });

  it("leaves markdown links and gfm autolinks as a single anchor each", () => {
    h = mount(<MarkdownBody text="[docs](https://a.com/x) and https://b.com/y and www.c.com" />);
    expect(hrefs(h)).toEqual(["https://a.com/x", "https://b.com/y", "http://www.c.com"]);
    expect(h.container.querySelectorAll("a a")).toHaveLength(0);
    expect(anchors(h)[0].textContent).toBe("docs");
  });

  it("keeps mailto markdown links as anchors", () => {
    h = mount(<MarkdownBody text="[x](mailto:a@b.co)" />);
    expect(hrefs(h)).toEqual(["mailto:a@b.co"]);
  });

  it("does not put react-markdown's node prop on the DOM", () => {
    h = mount(<MarkdownBody text="[a](https://a.com) and `x`" />);
    expect(h.html()).not.toContain("node=");
    expect(h.html()).not.toContain("[object Object]");
  });

  it("does not linkify fenced code", () => {
    h = mount(<MarkdownBody text={"```\ncurl https://a.com/x mantaui.com\n```"} />);
    expect(anchors(h)).toHaveLength(0);
    expect(h.text()).toContain("https://a.com/x");
  });

  it("does not link file names", () => {
    h = mount(<MarkdownBody text="Edit install.sh and README.md" />);
    expect(anchors(h)).toHaveLength(0);
  });

  it("linkifies the oversized plain fallback", () => {
    h = mount(<MarkdownBody text={"x ".repeat(30_000) + "https://a.com/big"} />);
    expect(hrefs(h)).toEqual(["https://a.com/big"]);
  });
});

describe("Linkified surfaces", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    (window as unknown as { __mantaPreload: unknown }).__mantaPreload = null;
  });

  it("links URLs in the user's message bubble", () => {
    const msg = {
      info: { id: "u1", sessionID: "s", role: "user", time: { created: 1 } },
      parts: [{ id: "p1", messageID: "u1", type: "text", text: "check https://a.com/x and mantaui.com" }],
    } as unknown as OpencodeMessage;
    h = mount(
      <MessageRow msg={msg} showThinking={false} turnDurationMs={null} turnTokens={null} verbSeedId={null} truncation={null} commandInfo={null} />,
    );
    expect(hrefs(h)).toEqual(["https://a.com/x", "https://mantaui.com"]);
  });

  it("links URLs in tool output lines", () => {
    h = mount(<BashBody state={{ output: "Server at https://a.com/x\nplain line" }} verbose={false} />);
    expect(hrefs(h)).toEqual(["https://a.com/x"]);
    expect(h.text()).toContain("plain line");
  });

  it("makes the WebFetch header URL a link", () => {
    h = mount(<WebFetchBody state={{ input: { url: "https://a.com/page" }, output: "" }} />);
    expect(hrefs(h)).toEqual(["https://a.com/page"]);
  });

  it.each([["javascript:alert(1)"], ["file:///etc/passwd"]])("renders no anchor for the WebFetch URL %s", (url) => {
    h = mount(<WebFetchBody state={{ input: { url }, output: "" }} />);
    expect(anchors(h)).toHaveLength(0);
    expect(h.text()).toContain(url);
  });

  it("opens an auto link externally and stops the click from propagating", () => {
    const openExternal = vi.fn();
    (window as unknown as { __mantaPreload: unknown }).__mantaPreload = { openExternal };
    const onParent = vi.fn();
    h = mount(
      <div onClick={onParent}>
        <Linkified text="see https://a.com/x" />
      </div>,
    );
    const a = anchors(h)[0];
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      a.dispatchEvent(ev);
    });
    expect(openExternal).toHaveBeenCalledWith("https://a.com/x");
    expect(ev.defaultPrevented).toBe(true);
    expect(onParent).not.toHaveBeenCalled();
  });

  it("without the preload it leaves the browser default but still does not propagate", () => {
    const onParent = vi.fn();
    h = mount(
      <div onClick={onParent}>
        <Linkified text="see https://a.com/x" />
      </div>,
    );
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      anchors(h!)[0].dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(onParent).not.toHaveBeenCalled();
  });
});

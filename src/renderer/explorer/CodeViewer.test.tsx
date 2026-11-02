// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import { applyTheme } from "../theme";
import { CodeViewer, languageDescriptionFor, minimalChange, targetExtension } from "./CodeViewer";

// jsdom has no layout: give CodeMirror the measuring APIs it probes.
beforeAll(() => {
  const rects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  const box = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Range.prototype.getClientRects = rects;
  Range.prototype.getBoundingClientRect = box;
  Element.prototype.scrollIntoView = () => {};
});

describe("minimalChange", () => {
  it("replaces only what differs", () => {
    const from = "line one\nline two\nline three\n";
    const to = "line one\nline 2!\nline three\n";
    const c = minimalChange(from, to);
    expect(from.slice(0, c.from) + c.insert + from.slice(c.to)).toBe(to);
    expect(c.from).toBe("line one\nline ".length);
    expect(c.to - c.from).toBeLessThan(from.length / 2);
  });

  it("handles pure insertions, deletions and no-ops", () => {
    expect(minimalChange("abc", "abXc")).toEqual({ from: 2, to: 2, insert: "X" });
    expect(minimalChange("abXc", "abc")).toEqual({ from: 2, to: 3, insert: "" });
    expect(minimalChange("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
    expect(minimalChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
  });
});

describe("languageDescriptionFor", () => {
  it("matches by filename", () => {
    expect(languageDescriptionFor("peek.mjs")?.name).toBe("JavaScript");
    expect(languageDescriptionFor("notes.md")?.name).toBe("Markdown");
    expect(languageDescriptionFor("README")).toBeNull();
  });
});

describe("targetExtension", () => {
  it("builds an extension for a line range", () => {
    const doc = Text.of(["a", "b", "c", "d"]);
    expect(targetExtension(doc, 2, 3)).toBeTruthy();
  });
});

describe("CodeViewer", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

  it("renders the text read-only, with line numbers", async () => {
    h = mount(<CodeViewer text={text} filename="a.txt" />);
    await h.flush();
    const content = h.container.querySelector(".cm-content") as HTMLElement;
    expect(content.textContent).toContain("line 1");
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(h.container.querySelector(".cm-lineNumbers")).toBeTruthy();
  });

  it("highlights the target lines and marks their gutter", async () => {
    h = mount(<CodeViewer text={text} filename="a.txt" line={3} endLine={4} />);
    await h.flush();
    const marked = Array.from(h.container.querySelectorAll(".cm-manta-target")).map((e) => e.textContent);
    expect(marked).toEqual(["line 3", "line 4"]);
    expect(h.container.querySelectorAll(".cm-manta-target-gutter").length).toBeGreaterThan(0);
  });

  it("moves the highlight when the target changes and clears it without one", async () => {
    h = mount(<CodeViewer text={text} filename="a.txt" line={3} />);
    await h.flush();
    h.rerender(<CodeViewer text={text} filename="a.txt" line={7} />);
    await h.flush();
    expect(Array.from(h.container.querySelectorAll(".cm-manta-target")).map((e) => e.textContent)).toEqual(["line 7"]);
    h.rerender(<CodeViewer text={text} filename="a.txt" />);
    await h.flush();
    expect(h.container.querySelectorAll(".cm-manta-target").length).toBe(0);
  });

  it("applies refreshed text in place", async () => {
    h = mount(<CodeViewer text={text} filename="a.txt" />);
    await h.flush();
    h.rerender(<CodeViewer text={text.replace("line 2\n", "line TWO\n")} filename="a.txt" />);
    await h.flush();
    const content = h.container.querySelector(".cm-content") as HTMLElement;
    expect(content.textContent).toContain("line TWO");
    expect(content.textContent).not.toContain("line 2line");
  });

  it("loads the language for the filename lazily", async () => {
    h = mount(<CodeViewer text={"const a = 1;\n"} filename="a.js" />);
    await h.flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    // The JavaScript grammar produces highlighted token spans.
    expect(h.container.querySelectorAll(".cm-line span").length).toBeGreaterThan(0);
  });

  it("re-themes the syntax colours live when the app theme flips", async () => {
    applyTheme("dark");
    h = mount(<CodeViewer text={"const a = 1;\n"} filename="a.js" />);
    await h.flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const classes = () => Array.from(h!.container.querySelectorAll(".cm-line span")).map((e) => e.className).join("|");
    const dark = classes();
    expect(dark).not.toBe("");
    await act(async () => applyTheme("light"));
    await h.flush();
    const light = classes();
    expect(light).not.toBe("");
    expect(light).not.toBe(dark);
    await act(async () => applyTheme("dark"));
  });
});

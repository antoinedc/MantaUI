import { describe, it, expect } from "vitest";
import { findLinks } from "./linkify";

const texts = (s: string, o?: Parameters<typeof findLinks>[1]) => findLinks(s, o).map((l) => l.text);

describe("findLinks", () => {
  it("returns [] for empty and link-free input", () => {
    expect(findLinks("")).toEqual([]);
    expect(findLinks("just some words here")).toEqual([]);
  });

  it("detects schemeful URLs and keeps them as written", () => {
    const [l] = findLinks("see https://example.com/a?b=1&c=2 now");
    expect(l).toEqual({ start: 4, end: 33, text: "https://example.com/a?b=1&c=2", href: "https://example.com/a?b=1&c=2" });
    expect(findLinks("http://localhost:3000/x")[0].href).toBe("http://localhost:3000/x");
  });

  it("detects www. and normalises the href to https", () => {
    expect(findLinks("go to www.example.com/x")).toEqual([
      { start: 6, end: 23, text: "www.example.com/x", href: "https://www.example.com/x" },
    ]);
    expect(texts("www.foo.sh")).toEqual(["www.foo.sh"]);
  });

  it.each([
    ["mantaui.com"],
    ["cto.useronda.com"],
    ["mantaui.com/downloads"],
    ["app.tryethernal.com/docs/api"],
    ["foo.app/x"],
    ["foo.ai/x"],
  ])("links schemeless %s", (s) => {
    const [l] = findLinks(`open ${s} please`);
    expect(l.text).toBe(s);
    expect(l.href).toBe(`https://${s}`);
  });

  it.each([
    ["install.sh"],
    ["main.py"],
    ["lib.rs"],
    ["README.md"],
    ["package.json"],
    ["x.ts"],
    ["MantaUI.app"],
    ["logo.ai"],
    ["/home/dev/foo.com"],
    ["src/a.io"],
    ["user@x.com"],
    ["http://localhost:<port>"],
    ["https://{host}/x"],
    ["http://localhost:$PORT/x"],
    ["https://x.com/<path>"],
    ["ftp://x.com"],
    ["mailto:a@b.com"],
    ["//foo.com"],
    ["~/foo.com"],
    ["--foo.com"],
    ["1.2.3.4"],
  ])("does not link %s", (s) => {
    expect(findLinks(`see ${s} ok`)).toEqual([]);
  });

  it("drops trailing sentence punctuation but keeps balanced parentheses", () => {
    expect(texts("https://github.com/a/b/pull/1.")).toEqual(["https://github.com/a/b/pull/1"]);
    expect(texts("visit mantaui.com, then mantaui.org!")).toEqual(["mantaui.com", "mantaui.org"]);
    expect(texts("(see https://a.com/x)")).toEqual(["https://a.com/x"]);
    expect(texts("https://a.com/a_(b)")).toEqual(["https://a.com/a_(b)"]);
    expect(texts("(see mantaui.com/x)")).toEqual(["mantaui.com/x"]);
  });

  it("finds several links with correct offsets", () => {
    const s = "a https://x.com and mantaui.com/y";
    const ls = findLinks(s);
    expect(ls.map((l) => s.slice(l.start, l.end))).toEqual(["https://x.com", "mantaui.com/y"]);
  });

  it("sees through raw markdown wrappers", () => {
    expect(texts("`https://a.com/b`")).toEqual(["https://a.com/b"]);
    expect(texts("**https://a.com/b**")).toEqual(["https://a.com/b"]);
    expect(texts("BASE_URL=https://a.com/b")).toEqual(["https://a.com/b"]);
    expect(texts("`mantaui.com`")).toEqual(["mantaui.com"]);
  });

  it("schemeless:false keeps only http(s) and www", () => {
    expect(texts("mantaui.com https://a.com www.b.com", { schemeless: false })).toEqual(["https://a.com", "www.b.com"]);
  });

  it('schemeless:"whole" links a schemeless host only when it is the whole span', () => {
    expect(texts("mantaui.com/downloads", { schemeless: "whole" })).toEqual(["mantaui.com/downloads"]);
    expect(texts("  mantaui.com  ", { schemeless: "whole" })).toEqual(["mantaui.com"]);
    expect(texts("curl mantaui.com", { schemeless: "whole" })).toEqual([]);
    expect(texts("curl https://a.com -o b.com", { schemeless: "whole" })).toEqual(["https://a.com"]);
  });
});

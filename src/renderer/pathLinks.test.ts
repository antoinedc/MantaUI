import { describe, it, expect } from "vitest";
import {
  displayPath,
  findPaths,
  findWholePath,
  lineSuffix,
  parsePathRef,
  toolArgPath,
} from "./pathLinks";

const raws = (text: string) => findPaths(text).map((m) => m.raw);

describe("findPaths — forms", () => {
  it("finds absolute, home and relative paths", () => {
    expect(raws("see /home/dev/a.ts and ~/notes/x.md and src/server/peek.mjs")).toEqual([
      "/home/dev/a.ts",
      "~/notes/x.md",
      "src/server/peek.mjs",
    ]);
    expect(raws("run ./x.ts then ../y/z.md")).toEqual(["./x.ts", "../y/z.md"]);
  });

  it("needs a slash: a bare filename in prose is not a path", () => {
    expect(raws("open AGENTS.md and package.json")).toEqual([]);
  });

  it("returns start/end/path for each match", () => {
    const text = "edit src/a.ts now";
    const [m] = findPaths(text);
    expect(text.slice(m.start, m.end)).toBe("src/a.ts");
    expect(m.path).toBe("src/a.ts");
    expect(m.line).toBeUndefined();
  });

  it("ignores things that merely contain slashes", () => {
    expect(raws("1/2 and 10/11/2026 and // comment and a / b")).toEqual([]);
  });

  it("keeps a trailing slash (a folder)", () => {
    expect(raws("look in src/server/ please")).toEqual(["src/server/"]);
  });

  it("handles paths wrapped in markdown / brackets / quotes", () => {
    expect(raws("(src/a.ts) **src/b.ts** \"src/c.ts\" 'src/d.ts' [src/e.ts]")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
  });
});

describe("findPaths — suffixes", () => {
  const one = (text: string) => findPaths(text)[0];

  it(":12", () => {
    const m = one("at src/a.ts:12 here");
    expect(m).toMatchObject({ raw: "src/a.ts:12", path: "src/a.ts", line: 12 });
    expect(m.endLine).toBeUndefined();
  });

  it(":12:4 keeps the line, drops the column", () => {
    expect(one("src/a.ts:12:4")).toMatchObject({ path: "src/a.ts", line: 12, raw: "src/a.ts:12:4" });
    expect(one("src/a.ts:12:4").endLine).toBeUndefined();
  });

  it(":12-30 is a range", () => {
    expect(one("src/a.ts:12-30")).toMatchObject({ path: "src/a.ts", line: 12, endLine: 30 });
  });

  it("#L12 and #L12-L30", () => {
    expect(one("src/a.ts#L12")).toMatchObject({ path: "src/a.ts", line: 12 });
    expect(one("src/a.ts#L12-L30")).toMatchObject({ path: "src/a.ts", line: 12, endLine: 30 });
  });

  it("drops a descending range's end", () => {
    expect(one("src/a.ts:30-12")).toMatchObject({ line: 30 });
    expect(one("src/a.ts:30-12").endLine).toBeUndefined();
  });

  it("a colon that is not a line suffix stays out of the match", () => {
    expect(raws("see src/a.ts: it is broken")).toEqual(["src/a.ts"]);
  });
});

describe("findPaths — punctuation", () => {
  it("excludes trailing sentence punctuation", () => {
    expect(raws("It is in src/a.ts.")).toEqual(["src/a.ts"]);
    expect(raws("Files: src/a.ts, src/b.ts; and src/c.ts!")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(raws("did you mean src/a.ts?")).toEqual(["src/a.ts"]);
  });

  it("keeps the line suffix but not the dot after it", () => {
    expect(raws("see src/a.ts:12.")).toEqual(["src/a.ts:12"]);
  });
});

describe("findPaths — URL precedence", () => {
  it("a path inside a URL is not a path", () => {
    expect(raws("go to https://example.com/src/a.ts now")).toEqual([]);
    expect(raws("go to mantaui.com/downloads now")).toEqual([]);
  });

  it("finds the path next to a URL", () => {
    expect(raws("https://a.com/x and src/a.ts")).toEqual(["src/a.ts"]);
  });

  it("accepts precomputed URL matches", () => {
    const text = "x src/a.ts y";
    expect(findPaths(text, { links: [{ start: 2, end: 10, text: "src/a.ts", href: "h" }] })).toEqual([]);
  });
});

describe("findWholePath — inline code", () => {
  it("accepts a bare filename only as the whole span", () => {
    expect(findWholePath("AGENTS.md")).toMatchObject({ path: "AGENTS.md", raw: "AGENTS.md" });
    expect(findWholePath(".gitignore")).toMatchObject({ path: ".gitignore" });
    expect(findWholePath("AGENTS.md:12")).toMatchObject({ path: "AGENTS.md", line: 12 });
    expect(findWholePath("open AGENTS.md")).toBeNull();
  });

  it("accepts every path form as the whole span", () => {
    expect(findWholePath("src/a.ts:12-30")).toMatchObject({ path: "src/a.ts", line: 12, endLine: 30 });
    expect(findWholePath("~/x.md")).toMatchObject({ path: "~/x.md" });
    expect(findWholePath("/etc/hosts")).toMatchObject({ path: "/etc/hosts" });
  });

  it("rejects commands, identifiers, versions and URLs", () => {
    expect(findWholePath("npm run build")).toBeNull();
    expect(findWholePath("cat src/a.ts")).toBeNull();
    expect(findWholePath("useState")).toBeNull();
    expect(findWholePath("1.2.3")).toBeNull();
    expect(findWholePath("this.state")).not.toBeNull(); // looks like a filename; the box decides
    expect(findWholePath("mantaui.com")).toBeNull();
    expect(findWholePath("https://a.com/src/a.ts")).toBeNull();
    expect(findWholePath("")).toBeNull();
  });

  it("reports offsets of the trimmed span", () => {
    expect(findWholePath("  src/a.ts ")).toMatchObject({ start: 2, end: 10, raw: "src/a.ts" });
  });
});

describe("parsePathRef / lineSuffix / displayPath", () => {
  it("round-trips a match's raw text", () => {
    expect(parsePathRef("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(parsePathRef("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parsePathRef("src/a.ts:12-30")).toEqual({ path: "src/a.ts", line: 12, endLine: 30 });
    expect(parsePathRef("src/a.ts#L5-L9")).toEqual({ path: "src/a.ts", line: 5, endLine: 9 });
  });

  it("formats the faint suffix", () => {
    expect(lineSuffix()).toBe("");
    expect(lineSuffix(28)).toBe(":28");
    expect(lineSuffix(28, 34)).toBe(":28-34");
  });

  it("shows paths relative to the folder when inside it", () => {
    expect(displayPath("/home/dev/p/src/a.ts", "/home/dev/p")).toBe("src/a.ts");
    expect(displayPath("/home/dev/p", "/home/dev/p/")).toBe(".");
    expect(displayPath("/etc/hosts", "/home/dev/p")).toBe("/etc/hosts");
  });
});

describe("toolArgPath", () => {
  it("reads the structured path of file tools from the input", () => {
    for (const tool of ["read", "edit", "write", "multiedit"]) {
      expect(toolArgPath(tool, { input: { filePath: "/p/a.ts" } })).toBe("/p/a.ts");
    }
    expect(toolArgPath("list", { input: { path: "/p/src" } })).toBe("/p/src");
  });

  it("a single-file apply_patch uses the patch metadata", () => {
    expect(toolArgPath("apply_patch", { input: {}, metadata: { files: [{ file: "src/a.ts" }] } })).toBe("src/a.ts");
    expect(
      toolArgPath("apply_patch", { input: {}, metadata: { files: [{ file: "a" }, { file: "b" }] } }),
    ).toBeNull();
  });

  it("other tools and empty inputs have none", () => {
    expect(toolArgPath("bash", { input: { command: "ls /p" } })).toBeNull();
    expect(toolArgPath("read", { input: {} })).toBeNull();
    expect(toolArgPath("read", undefined)).toBeNull();
    expect(toolArgPath("read", { input: { filePath: "  " } })).toBeNull();
  });
});

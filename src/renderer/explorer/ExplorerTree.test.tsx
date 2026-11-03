// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import type { FsEntry, FsListResult } from "../../shared/fsTypes";
import { ExplorerTree, ancestorsWithin, commonAncestor } from "./ExplorerTree";
import type { ExplorerTreeProps } from "./types";

const ROOT = "/home/dev/proj";
const OWNER = { sessionId: "s1", cwd: ROOT };

const entry = (dir: string, name: string, kind: FsEntry["kind"] = "file", extra: Partial<FsEntry> = {}): FsEntry => ({
  name,
  abs: `${dir}/${name}`,
  kind,
  size: 1,
  mtimeMs: 0,
  hidden: name.startsWith("."),
  ignored: false,
  ...extra,
});

let listings: Record<string, FsListResult | (() => FsListResult)>;
let git: { ok: true; changes: Record<string, "M" | "A" | "?" | "!"> } | { ok: false; reason: string };
let parent: { ok: true; abs: string } | { ok: false; reason: string };
let api: {
  fsList: ReturnType<typeof vi.fn>;
  fsGitStatus: ReturnType<typeof vi.fn>;
  fsResolvePaths: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  listings = {
    [ROOT]: {
      ok: true,
      dir: ROOT,
      total: 5,
      truncated: false,
      entries: [
        entry(ROOT, "src", "dir"),
        entry(ROOT, "docs", "dir"),
        entry(ROOT, ".env", "file"),
        entry(ROOT, "README.md"),
        entry(ROOT, "main.ts"),
      ],
    },
    [`${ROOT}/src`]: { ok: true, dir: `${ROOT}/src`, total: 2, truncated: false, entries: [entry(`${ROOT}/src`, "a.ts"), entry(`${ROOT}/src`, "b.ts")] },
  };
  git = { ok: true, changes: {} };
  parent = { ok: true, abs: "/home/dev" };
  api = {
    fsList: vi.fn(async ({ dir }: { dir: string }) => {
      const l = listings[dir];
      return (typeof l === "function" ? l() : l) ?? { ok: false, reason: "missing" };
    }),
    fsGitStatus: vi.fn(async () => git),
    fsResolvePaths: vi.fn(async ({ paths }: { paths: string[] }) => ({
      results: paths.map((p) => (parent.ok ? { input: p, ...parent, kind: "dir", size: 0, mtimeMs: 0 } : { input: p, ...parent })),
    })),
  };
  (window as unknown as { api: unknown }).api = api;
});

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
});

function props(over: Partial<ExplorerTreeProps> = {}): ExplorerTreeProps {
  return { owner: OWNER, root: ROOT, onRootChange: vi.fn(), selected: null, onOpen: vi.fn(), width: 176, refreshKey: 0, ...over };
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await h!.flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function show(over: Partial<ExplorerTreeProps> = {}) {
  const p = props(over);
  h = mount(<ExplorerTree {...p} />);
  await settle();
  return p;
}

const rows = () => Array.from(h!.container.querySelectorAll<HTMLElement>(".manta-explorer-row"));
const names = () => rows().map((r) => r.textContent?.replace(/[MA?!]$/, "").trim());
const rowFor = (name: string) => rows().find((r) => r.querySelector("span.truncate")?.textContent === name);
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
};

describe("path helpers", () => {
  it("ancestorsWithin lists the folders between root and the file", () => {
    expect(ancestorsWithin("/r", "/r/a/b/c.ts")).toEqual(["/r/a", "/r/a/b"]);
    expect(ancestorsWithin("/r", "/r/c.ts")).toEqual([]);
    expect(ancestorsWithin("/r", "/x/c.ts")).toEqual([]);
  });
  it("commonAncestor", () => {
    expect(commonAncestor("/h/dev/proj", "/h/dev/other/x.ts")).toBe("/h/dev");
    expect(commonAncestor("/h/dev/proj", "/h/dev/proj/a")).toBe("/h/dev/proj");
    expect(commonAncestor("/a", "/b")).toBe("/");
  });
});

describe("ExplorerTree", () => {
  it("lists the root in the order the server returned, folders lazily", async () => {
    await show();
    expect(names()).toEqual(["src", "docs", ".env", "README.md", "main.ts"]);
    expect(api.fsList).toHaveBeenCalledTimes(1);
    expect(api.fsList).toHaveBeenCalledWith({ dir: ROOT });
    expect(h!.container.querySelector('[role="tree"]')).toBeTruthy();
    expect(rowFor("src")?.getAttribute("role")).toBe("treeitem");
    expect(rowFor("src")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("expanding a folder lists it then; collapsing hides it", async () => {
    await show();
    await click(rowFor("src"));
    expect(api.fsList).toHaveBeenCalledWith({ dir: `${ROOT}/src` });
    expect(names()).toEqual(["src", "a.ts", "b.ts", "docs", ".env", "README.md", "main.ts"]);
    expect(rowFor("src")?.getAttribute("aria-expanded")).toBe("true");
    expect(rowFor("a.ts")?.getAttribute("aria-level")).toBe("2");
    expect(rowFor("a.ts")?.style.paddingLeft).toBe("12px");
    await click(rowFor("src"));
    expect(names()).toEqual(["src", "docs", ".env", "README.md", "main.ts"]);
  });

  it("clicking a file opens it for this owner", async () => {
    const p = await show();
    await click(rowFor("main.ts"));
    expect(p.onOpen).toHaveBeenCalledWith({ abs: `${ROOT}/main.ts`, owner: OWNER, kind: "file" });
  });

  it("clicking a folder only toggles it", async () => {
    const p = await show();
    await click(rowFor("src"));
    expect(p.onOpen).not.toHaveBeenCalled();
  });

  it("dims dot-files and git-ignored entries; ignored folders are not expanded on their own", async () => {
    listings[ROOT] = {
      ok: true,
      dir: ROOT,
      total: 3,
      truncated: false,
      entries: [entry(ROOT, "node_modules", "dir", { ignored: true }), entry(ROOT, ".env"), entry(ROOT, "main.ts")],
    };
    await show();
    expect(rowFor("node_modules")?.className).toContain("text-text-faint");
    expect(rowFor(".env")?.className).toContain("text-text-faint");
    expect(rowFor("main.ts")?.className).toContain("text-text-muted");
    expect(api.fsList).toHaveBeenCalledTimes(1);
  });

  it("shows git badges with their tones", async () => {
    git = { ok: true, changes: { "main.ts": "M", "README.md": "A", ".env": "?", "src/a.ts": "!" } };
    await show();
    await click(rowFor("src"));
    const badge = (n: string) => rowFor(n)?.querySelector("span.font-mono");
    expect(badge("main.ts")?.textContent).toBe("M");
    expect(badge("main.ts")?.className).toContain("text-warn");
    expect(badge("README.md")?.textContent).toBe("A");
    expect(badge("README.md")?.className).toContain("text-ok");
    expect(badge(".env")?.textContent).toBe("?");
    expect(badge(".env")?.className).toContain("text-text-faint");
    expect(badge("a.ts")?.textContent).toBe("!");
    expect(badge("a.ts")?.className).toContain("text-danger");
    expect(api.fsGitStatus).toHaveBeenCalledWith({ root: ROOT });
  });

  it("shows no badges outside a git repo", async () => {
    git = { ok: false, reason: "not-git" };
    await show();
    expect(h!.container.querySelectorAll(".manta-explorer-row span.font-mono").length).toBe(0);
  });

  it("filters the loaded rows by substring, case-insensitively", async () => {
    await show();
    await click(rowFor("src"));
    const input = h!.container.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "A.TS");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names()).toEqual(["a.ts"]);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h!.container.textContent).toContain("No files match");
  });

  describe("up", () => {
    it("goes to the parent folder", async () => {
      const p = await show();
      const up = h!.container.querySelector<HTMLButtonElement>('button[aria-label="Up to parent folder"]')!;
      expect(up.disabled).toBe(false);
      expect(up.title).toBe("Up to dev");
      expect(api.fsResolvePaths).toHaveBeenCalledWith({ base: ROOT, paths: [".."] });
      await click(up);
      expect(p.onRootChange).toHaveBeenCalledWith("/home/dev");
    });

    it("is disabled at /, with a reason (no lookup needed)", async () => {
      await show({ root: "/" });
      const up = h!.container.querySelector<HTMLButtonElement>('button[aria-label="Up to parent folder"]')!;
      expect(up.disabled).toBe(true);
      expect(up.title).toBe("Already at the top folder (/)");
    });

    it("climbs past home", async () => {
      parent = { ok: true, abs: "/home" };
      await show({ root: "/home/dev" });
      const up = h!.container.querySelector<HTMLButtonElement>('button[aria-label="Up to parent folder"]')!;
      expect(up.disabled).toBe(false);
      expect(up.title).toBe("Up to home");
    });
  });

  it("ends a truncated folder with a 'more not shown' row", async () => {
    listings[ROOT] = { ok: true, dir: ROOT, total: 2005, truncated: true, entries: [entry(ROOT, "a.ts"), entry(ROOT, "b.ts")] };
    await show();
    const last = rows().at(-1)!;
    expect(last.textContent).toMatch(/^2003 more not shown — use quick open \(.*P\)$/);
    expect(last.getAttribute("role")).toBeNull();
  });

  it("reveals and selects the opened file, loading its folders", async () => {
    listings[`${ROOT}/src`] = {
      ok: true,
      dir: `${ROOT}/src`,
      total: 2,
      truncated: false,
      entries: [entry(`${ROOT}/src`, "deep", "dir"), entry(`${ROOT}/src`, "b.ts")],
    };
    listings[`${ROOT}/src/deep`] = { ok: true, dir: `${ROOT}/src/deep`, total: 1, truncated: false, entries: [entry(`${ROOT}/src/deep`, "c.ts")] };
    await show({ selected: `${ROOT}/src/deep/c.ts` });
    expect(names()).toEqual(["src", "deep", "c.ts", "b.ts", "docs", ".env", "README.md", "main.ts"]);
    expect(rowFor("c.ts")?.getAttribute("aria-selected")).toBe("true");
    expect(rowFor("c.ts")?.className).toContain("bg-accent-bg");
    expect(rowFor("b.ts")?.getAttribute("aria-selected")).toBe("false");
  });

  it("selecting a folder expands it", async () => {
    await show({ selected: `${ROOT}/src` });
    expect(names()).toEqual(["src", "a.ts", "b.ts", "docs", ".env", "README.md", "main.ts"]);
    expect(rowFor("src")?.getAttribute("aria-selected")).toBe("true");
  });

  it("re-roots when the opened file is outside the root", async () => {
    const p = await show({ selected: "/home/dev/other/x.ts" });
    expect(p.onRootChange).toHaveBeenCalledWith("/home/dev");
  });

  it("re-lists the root and expanded folders and re-fetches git status on refresh", async () => {
    const p = props();
    h = mount(<ExplorerTree {...p} />);
    await settle();
    await click(rowFor("src"));
    api.fsList.mockClear();
    api.fsGitStatus.mockClear();
    listings[`${ROOT}/src`] = {
      ok: true,
      dir: `${ROOT}/src`,
      total: 3,
      truncated: false,
      entries: [entry(`${ROOT}/src`, "a.ts"), entry(`${ROOT}/src`, "b.ts"), entry(`${ROOT}/src`, "new.ts")],
    };
    git = { ok: true, changes: { "src/new.ts": "?" } };
    h.rerender(<ExplorerTree {...p} refreshKey={1} />);
    await settle();
    expect(api.fsList.mock.calls.map((c) => c[0].dir).sort()).toEqual([ROOT, `${ROOT}/src`].sort());
    expect(api.fsGitStatus).toHaveBeenCalledTimes(1);
    expect(names()).toContain("new.ts");
    expect(rowFor("new.ts")?.querySelector("span.font-mono")?.textContent).toBe("?");
  });

  it("says when the folder is empty", async () => {
    listings[ROOT] = { ok: true, dir: ROOT, total: 0, truncated: false, entries: [] };
    await show();
    expect(h!.container.textContent).toContain("Empty folder");
  });

  it("shows why the root could not be read, and Retry lists it again", async () => {
    listings[ROOT] = { ok: false, reason: "permission" };
    await show();
    expect(h!.container.textContent).toContain("No permission to open this folder");
    listings[ROOT] = { ok: true, dir: ROOT, total: 1, truncated: false, entries: [entry(ROOT, "ok.ts")] };
    const retry = Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    await click(retry);
    expect(names()).toEqual(["ok.ts"]);
    expect(h!.container.textContent).not.toContain("No permission");
  });

  it("shows an unreadable subfolder inline, and expanding it again retries", async () => {
    listings[`${ROOT}/src`] = { ok: false, reason: "permission" };
    await show();
    await click(rowFor("src"));
    expect(h!.container.textContent).toContain("No permission to open this folder");
    await click(rowFor("src")); // collapse
    listings[`${ROOT}/src`] = { ok: true, dir: `${ROOT}/src`, total: 1, truncated: false, entries: [entry(`${ROOT}/src`, "fixed.ts")] };
    await click(rowFor("src")); // expand = retry
    expect(names()).toContain("fixed.ts");
  });

  it("a thrown list failure becomes a visible error row, not a silent empty folder", async () => {
    api.fsList.mockRejectedValueOnce(new Error("file system error"));
    await show();
    expect(h!.container.textContent).toContain("Couldn’t read this folder");
  });

  it("is keyboard-operable: Enter on a folder expands it, arrows move, Enter on a file opens it", async () => {
    const p = await show();
    const key = async (el: Element | null | undefined, k: string) => {
      await act(async () => {
        el!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true }));
      });
      await settle();
    };
    await key(rowFor("src"), "Enter");
    expect(names()).toContain("a.ts");
    await key(rowFor("src"), "ArrowDown");
    await key(rowFor("a.ts"), "Enter");
    expect(p.onOpen).toHaveBeenCalledWith({ abs: `${ROOT}/src/a.ts`, owner: OWNER, kind: "file" });
  });
});

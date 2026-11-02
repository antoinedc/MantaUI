// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import { ExplorerQuickOpen, splitMatch, toAbsolute } from "./ExplorerQuickOpen";
import type { ExplorerQuickOpenProps } from "./types";

const CWD = "/home/dev/proj";
const OWNER = { sessionId: "s1", cwd: CWD };

let api: { opencodeFindFiles: ReturnType<typeof vi.fn>; fsGitStatus: ReturnType<typeof vi.fn> };
let h: Harness | null = null;

beforeEach(() => {
  api = {
    opencodeFindFiles: vi.fn(async () => ["src/server/peek.mjs", "src/server/peek.test.mjs", "docs/peek-scope.md"]),
    fsGitStatus: vi.fn(async () => ({ ok: true, changes: { "src/server/peek.mjs": "M", "docs/peek-scope.md": "A" } })),
  };
  (window as unknown as { api: unknown }).api = api;
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
});

function props(over: Partial<ExplorerQuickOpenProps> = {}): ExplorerQuickOpenProps {
  return { owner: OWNER, open: true, onClose: vi.fn(), onOpen: vi.fn(), ...over };
}

async function wait(ms = 200) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function type(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Go to file…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await wait();
}

const options = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

describe("helpers", () => {
  it("toAbsolute", () => {
    expect(toAbsolute("/h/p", "src/a.ts")).toBe("/h/p/src/a.ts");
    expect(toAbsolute("/h/p/", "./src/a.ts")).toBe("/h/p/src/a.ts");
    expect(toAbsolute("/h/p", "/x/a.ts")).toBe("/x/a.ts");
  });
  it("splitMatch finds the first case-insensitive match", () => {
    expect(splitMatch("src/server/Peek.mjs", "peek")).toEqual({ before: "src/server/", match: "Peek", after: ".mjs" });
    expect(splitMatch("src/a.ts", "zzz")).toEqual({ before: "src/a.ts", match: "", after: "" });
    expect(splitMatch("src/a.ts", "")).toEqual({ before: "src/a.ts", match: "", after: "" });
  });
});

describe("ExplorerQuickOpen", () => {
  it("renders nothing while closed", async () => {
    h = mount(<ExplorerQuickOpen {...props({ open: false })} />);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(api.fsGitStatus).not.toHaveBeenCalled();
  });

  it("searches the session folder with the typed query", async () => {
    h = mount(<ExplorerQuickOpen {...props()} />);
    await wait(20);
    expect(document.body.textContent).toContain("Type a file name to search this folder.");
    await type("peek");
    expect(api.opencodeFindFiles).toHaveBeenCalledWith({ query: "peek", directory: CWD });
    expect(options().map((o) => o.textContent)).toEqual([
      "src/server/peek.mjsM",
      "src/server/peek.test.mjs",
      "docs/peek-scope.mdA",
    ]);
  });

  it("highlights the match and shows git badges", async () => {
    h = mount(<ExplorerQuickOpen {...props()} />);
    await type("peek");
    const first = options()[0];
    expect(first.querySelector("mark")?.textContent).toBe("peek");
    expect(first.querySelector("span.font-mono")?.textContent).toBe("M");
    expect(first.querySelector("span.font-mono")?.className).toContain("text-warn");
    expect(options()[2].querySelector("span.font-mono")?.className).toContain("text-ok");
    expect(api.fsGitStatus).toHaveBeenCalledWith({ root: CWD });
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter opens the selected result as an absolute path for this owner", async () => {
    const p = props();
    h = mount(<ExplorerQuickOpen {...p} />);
    await type("peek");
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Go to file…"]')!;
    const key = async (k: string) =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      });
    await key("ArrowDown");
    await key("Enter");
    expect(p.onOpen).toHaveBeenCalledWith({ abs: `${CWD}/src/server/peek.test.mjs`, owner: OWNER, kind: "file" });
    await wait(150);
    expect(p.onClose).toHaveBeenCalled();
  });

  it("clicking a result opens it", async () => {
    const p = props();
    h = mount(<ExplorerQuickOpen {...p} />);
    await type("peek");
    await act(async () => {
      options()[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(p.onOpen).toHaveBeenCalledWith({ abs: `${CWD}/docs/peek-scope.md`, owner: OWNER, kind: "file" });
  });

  it("shows a failed search in the palette — list and footer — never as 'no matches'", async () => {
    api.opencodeFindFiles.mockRejectedValue(new Error("boom"));
    h = mount(<ExplorerQuickOpen {...props()} />);
    await type("peek");
    const alerts = Array.from(document.body.querySelectorAll('[role="alert"]')).map((e) => e.textContent);
    expect(alerts).toEqual(["Couldn’t search this folder — try again"]);
    expect(document.body.textContent).not.toContain("No files match");
  });

  it("says when nothing matches", async () => {
    api.opencodeFindFiles.mockResolvedValue([]);
    h = mount(<ExplorerQuickOpen {...props()} />);
    await type("zzz");
    expect(document.body.textContent).toContain("No files match “zzz”.");
  });

  it("ignores a superseded reply", async () => {
    let first!: (v: string[]) => void;
    api.opencodeFindFiles.mockImplementationOnce(() => new Promise<string[]>((r) => (first = r)));
    api.opencodeFindFiles.mockImplementationOnce(async () => ["new.ts"]);
    h = mount(<ExplorerQuickOpen {...props()} />);
    await type("a");
    await type("ab");
    await act(async () => first(["stale.ts"]));
    expect(options().map((o) => o.textContent)).toEqual(["new.ts"]);
  });
});

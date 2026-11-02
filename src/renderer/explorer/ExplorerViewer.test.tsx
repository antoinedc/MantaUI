// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import { useStore } from "../store";
import { MAX_PREVIEW_BYTES } from "../chatUtils";
import { ExplorerViewer, copyDisabledReason, lineFromFragment, relativeTo } from "./ExplorerViewer";
import { PREVIEW_PATH_EVENT, type ExplorerViewerProps, type MdView } from "./types";

beforeAll(() => {
  // jsdom has no layout: give CodeMirror the measuring APIs it probes.
  const rects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  const box = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Range.prototype.getClientRects = rects;
  Range.prototype.getBoundingClientRect = box;
  Element.prototype.scrollIntoView = () => {};
});

const CWD = "/home/dev/proj";
const OWNER = { sessionId: "s1", cwd: CWD };

type FileSpec = { body?: string | Uint8Array; size?: number; type?: string; status?: number; reason?: string; fail?: boolean };
let files: Record<string, FileSpec>;
let fetchLog: Array<{ method: string; path: string }>;
let gate: Promise<void> | null;

const enc = (s: string) => new TextEncoder().encode(s);

function installFetch() {
  fetchLog = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = decodeURIComponent(new URL(url).searchParams.get("path") ?? "");
      const method = init.method ?? "GET";
      fetchLog.push({ method, path });
      if (gate) await gate;
      const f = files[path];
      if (!f || f.fail) throw new TypeError("network down");
      if (f.status && f.status >= 400) {
        return method === "HEAD"
          ? new Response(null, { status: f.status })
          : new Response(JSON.stringify({ error: "x", reason: f.reason }), { status: f.status });
      }
      const body = typeof f.body === "string" ? enc(f.body) : (f.body ?? new Uint8Array());
      const size = f.size ?? body.length;
      const headers = { "content-length": String(size), "content-type": f.type ?? "text/plain" };
      return method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(body as BodyInit, { status: 200, headers });
    }),
  );
}

let clipboard: { writeText: ReturnType<typeof vi.fn> };
let api: {
  fsResolvePaths: ReturnType<typeof vi.fn>;
  agentPullFile: ReturnType<typeof vi.fn>;
  revealInFolder: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  localStorage.setItem("manta_server", "http://box.test");
  localStorage.setItem("manta_token", "tok");
  files = {};
  gate = null;
  installFetch();
  clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  api = {
    fsResolvePaths: vi.fn(async ({ base, paths }: { base: string; paths: string[] }) => ({
      results: paths.map((p) => ({ input: p, ok: true, abs: p.startsWith("/") ? p : `${base}/${p}`, kind: "file", size: 1, mtimeMs: Date.now() - 5 * 60_000 })),
    })),
    agentPullFile: vi.fn(async (p: string) => `/Users/me/Downloads/${p.split("/").pop()}`),
    revealInFolder: vi.fn(async () => {}),
  };
  (window as unknown as { api: unknown }).api = api;
  useStore.setState({ appToasts: [] });
});

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

type Spies = {
  onOpen: Mock<ExplorerViewerProps["onOpen"]>;
  onShowTree: Mock<ExplorerViewerProps["onShowTree"]>;
  onMdViewChange: Mock<ExplorerViewerProps["onMdViewChange"]>;
};

function props(over: Partial<ExplorerViewerProps> = {}): [ExplorerViewerProps, Spies] {
  const spies: Spies = {
    onOpen: vi.fn<ExplorerViewerProps["onOpen"]>(),
    onShowTree: vi.fn<ExplorerViewerProps["onShowTree"]>(),
    onMdViewChange: vi.fn<ExplorerViewerProps["onMdViewChange"]>(),
  };
  return [
    {
      owner: OWNER,
      root: CWD,
      file: { abs: `${CWD}/src/a.mjs` },
      mdView: "rendered",
      onMdViewChange: spies.onMdViewChange,
      onOpen: spies.onOpen,
      onShowTree: spies.onShowTree,
      refreshKey: 0,
      ...over,
    },
    spies,
  ];
}

async function show(over: Partial<ExplorerViewerProps> = {}) {
  const [p, spies] = props(over);
  h = mount(<ExplorerViewer {...p} />);
  await settle();
  return { p, spies };
}

async function settle() {
  await h!.flush();
  await h!.flush();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const text = () => h!.container.textContent ?? "";
const q = <T extends Element = HTMLElement>(sel: string) => h!.container.querySelector<T>(sel);
const btn = (label: string) => q<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (t: string) => Array.from(h!.container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === t);
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
};
const toasts = () => useStore.getState().appToasts;

describe("pure helpers", () => {
  it("relativeTo", () => {
    expect(relativeTo("/h/proj", "/h/proj/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/h/proj", "/h/other/b.ts")).toBe("../other/b.ts");
    expect(relativeTo("/h/proj", "/h/proj")).toBe(".");
  });
  it("lineFromFragment", () => {
    expect(lineFromFragment("L12")).toEqual({ line: 12, endLine: undefined });
    expect(lineFromFragment("L12-L20")).toEqual({ line: 12, endLine: 20 });
    expect(lineFromFragment("intro")).toBeNull();
  });
  it("copyDisabledReason", () => {
    expect(copyDisabledReason(null)).toMatch(/loading/i);
    expect(copyDisabledReason({ status: "text", text: "x", size: 1 })).toBeNull();
    expect(copyDisabledReason({ status: "binary", size: 1 })).toMatch(/binary/i);
    expect(copyDisabledReason({ status: "too-large", size: 1 })).toMatch(/large/i);
    expect(copyDisabledReason({ status: "empty" })).toMatch(/empty/i);
  });
});

describe("empty / loading / error", () => {
  it("shows the empty state and Show tree calls back", async () => {
    const { spies } = await show({ file: null });
    expect(text()).toContain("No file open");
    expect(text()).toContain("Click a file path in the conversation, or open the tree");
    await click(byText("Show tree"));
    expect(spies.onShowTree).toHaveBeenCalledTimes(1);
  });

  it("shows the skeleton only after 150 ms without a response", async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    files[`${CWD}/src/a.mjs`] = { body: "x\n" };
    vi.useFakeTimers();
    const [p] = props();
    h = mount(<ExplorerViewer {...p} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(q('[role="status"][aria-label="Loading"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(q('[role="status"][aria-label="Loading"]')).toBeTruthy();
    release();
    gate = null;
    vi.useRealTimers();
    await settle();
    expect(q('[role="status"][aria-label="Loading"]')).toBeNull();
  });

  it("shows 'Couldn't load this file' with Retry, and Retry loads it", async () => {
    files[`${CWD}/src/a.mjs`] = { fail: true };
    await show();
    expect(text()).toContain("Couldn’t load this file");
    expect(text()).toContain("The box didn’t answer");
    files[`${CWD}/src/a.mjs`] = { body: "now here\n" };
    await click(byText("Retry"));
    expect(text()).not.toContain("Couldn’t load this file");
    expect(q(".cm-content")?.textContent).toContain("now here");
  });

  it("shows 'Empty file' for a zero-byte file", async () => {
    files[`${CWD}/src/a.mjs`] = { body: "" };
    await show();
    expect(text()).toContain("Empty file");
    expect(btn("Copy contents")?.disabled).toBe(true);
    expect(btn("Copy contents")?.title).toMatch(/empty/i);
  });
});

describe("refusals", () => {
  it("too large: explains, offers Download, and never fetches the body", async () => {
    files[`${CWD}/src/a.mjs`] = { size: MAX_PREVIEW_BYTES + 1, body: "x" };
    await show();
    expect(text()).toContain("Too large to preview");
    expect(text()).toContain("a.mjs is");
    expect(text()).toContain("the limit is 25 MB");
    expect(fetchLog.some((c) => c.method === "GET" && !c.path.includes("range"))).toBe(false);
    await click(byText("Download"));
    expect(api.agentPullFile).toHaveBeenCalledWith(`${CWD}/src/a.mjs`);
  });

  it("binary: explains and offers Download", async () => {
    files[`${CWD}/src/a.mjs`] = { body: new Uint8Array([0x41, 0, 0x42]), type: "application/octet-stream" };
    await show();
    expect(text()).toContain("Binary file");
    expect(text()).toContain("a.mjs can’t be shown as text");
    expect(btn("Copy contents")?.disabled).toBe(true);
    await click(byText("Download"));
    expect(api.agentPullFile).toHaveBeenCalledWith(`${CWD}/src/a.mjs`);
  });

  it("missing: no action", async () => {
    files[`${CWD}/src/a.mjs`] = { status: 404, reason: "missing" };
    await show();
    expect(text()).toContain("No longer exists");
    expect(text()).toContain("Moved or deleted after it was mentioned");
    expect(byText("Download")).toBeUndefined();
    expect(byText("Retry")).toBeUndefined();
    expect(btn("Download")?.disabled).toBe(true);
  });

  it("permission: no action", async () => {
    files[`${CWD}/src/a.mjs`] = { status: 403, reason: "permission" };
    await show();
    expect(text()).toContain("Can’t read this file");
    expect(text()).toContain("The box user has no permission to open it");
    expect(byText("Download")).toBeUndefined();
  });

  it("outside home: says so", async () => {
    files[`${CWD}/src/a.mjs`] = { status: 403, reason: "outside-home" };
    await show();
    expect(text()).toContain("It is outside your home folder");
  });

  it("a transient server answer offers Retry", async () => {
    files[`${CWD}/src/a.mjs`] = { status: 503, reason: "unavailable" };
    await show();
    expect(text()).toContain("Couldn’t load this file");
    expect(byText("Retry")).toBeTruthy();
  });
});

describe("code", () => {
  const body = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i};`).join("\n") + "\n";

  it("renders the file in CodeMirror with the file bar and footer", async () => {
    files[`${CWD}/src/a.mjs`] = { body };
    await show();
    expect(q(".cm-content")?.textContent).toContain("const v1 = 0;");
    const bar = q(".manta-explorer-filebar")!;
    expect(bar.textContent).toContain("src / ");
    expect(bar.textContent).toContain("a.mjs");
    expect(bar.querySelector('[aria-label="Markdown view"]')).toBeNull();
    const foot = q(".manta-explorer-footer")!;
    expect(foot.textContent).toContain("JavaScript");
    expect(foot.textContent).toContain("30 lines");
    expect(foot.textContent).toContain(`${body.length} B`);
    expect(foot.textContent).toContain("modified 5m ago");
  });

  it("highlights and reports a line range", async () => {
    files[`${CWD}/src/a.mjs`] = { body };
    await show({ file: { abs: `${CWD}/src/a.mjs`, line: 3, endLine: 4 } });
    expect(Array.from(h!.container.querySelectorAll(".cm-manta-target")).map((e) => e.textContent)).toEqual([
      "const v3 = 2;",
      "const v4 = 3;",
    ]);
    expect(q(".manta-explorer-filebar")!.textContent).toContain("lines 3–4");
    expect(q(".manta-explorer-footer")!.textContent).toContain("Ln 3");
    expect(q(".manta-explorer-footer")!.textContent).not.toContain("modified");
  });

  it("breadcrumb is relative to the root, absolute outside it", async () => {
    files["/home/dev/other/b.mjs"] = { body: "x\n" };
    await show({ file: { abs: "/home/dev/other/b.mjs" } });
    expect(q(".manta-explorer-filebar")!.textContent).toContain("home / dev / other / b.mjs");
  });
});

describe("Markdown", () => {
  const md = "# Title\n\nSome *text* with a [rel](other.md#L3) and [top](#title).\n\n## Section\n";
  const file = `${CWD}/docs/n.md`;

  it("renders by default and offers Rendered/Source", async () => {
    files[file] = { body: md, type: "text/markdown" };
    await show({ file: { abs: file } });
    expect(q(".manta-explorer-md h1")?.textContent).toBe("Title");
    expect(q(".cm-content")).toBeNull();
    const seg = q('[aria-label="Markdown view"]')!;
    expect(seg.querySelector('[aria-pressed="true"]')?.textContent).toBe("Rendered");
  });

  it("Source shows CodeMirror; the toggle reports the new preference", async () => {
    files[file] = { body: md, type: "text/markdown" };
    const { spies } = await show({ file: { abs: file } });
    await click(byText("Source"));
    expect(spies.onMdViewChange).toHaveBeenCalledWith("source");
  });

  it("honours the app-wide Source preference", async () => {
    files[file] = { body: md, type: "text/markdown" };
    await show({ file: { abs: file }, mdView: "source" as MdView });
    expect(q(".cm-content")?.textContent).toContain("# Title");
    expect(q('[aria-label="Markdown view"] [aria-pressed="true"]')?.textContent).toBe("Source");
  });

  it("a line target opens Source at that line without changing the preference", async () => {
    files[file] = { body: md, type: "text/markdown" };
    const { spies } = await show({ file: { abs: file, line: 3 } });
    expect(q(".cm-content")).toBeTruthy();
    expect(q(".cm-manta-target")).toBeTruthy();
    expect(spies.onMdViewChange).not.toHaveBeenCalled();
    // The user can still choose Rendered.
    await click(byText("Rendered"));
    expect(spies.onMdViewChange).toHaveBeenCalledWith("rendered");
    expect(q(".manta-explorer-md h1")?.textContent).toBe("Title");
  });

  it("a large file opens in Source with a note and no Rendered option", async () => {
    files[file] = { body: "# Big\n" + "word ".repeat(11_000), type: "text/markdown" };
    await show({ file: { abs: file } });
    expect(text()).toContain("Large file — showing source");
    expect(q(".cm-content")).toBeTruthy();
    expect(q('[aria-label="Markdown view"]')).toBeNull();
  });

  it("⇧⌘V toggles Rendered ↔ Source", async () => {
    files[file] = { body: md, type: "text/markdown" };
    const { spies } = await show({ file: { abs: file } });
    await act(async () => {
      q(".manta-explorer-filebar")!.dispatchEvent(new KeyboardEvent("keydown", { key: "V", metaKey: true, shiftKey: true, bubbles: true }));
    });
    expect(spies.onMdViewChange).toHaveBeenCalledWith("source");
  });

  it("a relative link navigates the Explorer through fs:resolve-paths", async () => {
    files[file] = { body: md, type: "text/markdown" };
    const { spies } = await show({ file: { abs: file } });
    await click(q('a[href="other.md#L3"]'));
    expect(api.fsResolvePaths).toHaveBeenCalledWith({ base: `${CWD}/docs`, paths: ["other.md"] });
    expect(spies.onOpen).toHaveBeenCalledWith({ abs: `${CWD}/docs/other.md`, kind: "file", owner: OWNER, line: 3, endLine: undefined });
  });

  it("a link to a missing file shows an error toast instead of doing nothing", async () => {
    files[file] = { body: md, type: "text/markdown" };
    api.fsResolvePaths.mockImplementation(async ({ paths }: { paths: string[] }) => ({ results: paths.map((p) => ({ input: p, ok: false, reason: "missing" })) }));
    const { spies } = await show({ file: { abs: file } });
    await click(q('a[href="other.md#L3"]'));
    expect(spies.onOpen).not.toHaveBeenCalled();
    expect(toasts().some((t) => t.tone === "error" && String(t.message).includes("other.md"))).toBe(true);
  });

  it("an unknown #fragment says so instead of doing nothing", async () => {
    files[file] = { body: md.replace("[top](#title)", "[top](#nope)"), type: "text/markdown" };
    await show({ file: { abs: file } });
    await click(q('a[href="#nope"]'));
    expect(toasts().some((t) => t.tone === "error" && String(t.message).includes("nope"))).toBe(true);
  });

  it("#fragment scrolls to the heading with that id", async () => {
    files[file] = { body: md, type: "text/markdown" };
    await show({ file: { abs: file } });
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    await click(q('a[href="#title"]'));
    expect(scrolled).toEqual(["title"]);
  });
});

describe("copy, download, more", () => {
  const abs = `${CWD}/src/a.mjs`;
  beforeEach(() => {
    files[abs] = { body: "hello\n" };
  });

  it("Copy contents confirms with a check and 'Copied', then reverts", async () => {
    await show();
    await click(btn("Copy contents"));
    expect(clipboard.writeText).toHaveBeenCalledWith("hello\n");
    expect(btn("Copied")).toBeTruthy();
    expect(btn("Copied")!.querySelector("svg")?.getAttribute("class") ?? "").toContain("text-ok");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1600));
    });
    expect(btn("Copy contents")).toBeTruthy();
  });

  it("a clipboard failure shows an error toast", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denied"));
    await show();
    await click(btn("Copy contents"));
    expect(btn("Copied")).toBeNull();
    expect(toasts().some((t) => t.tone === "error" && t.message === "Couldn’t copy — the clipboard is unavailable")).toBe(true);
  });

  it("an unavailable clipboard shows the same error toast", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await show();
    await click(btn("Copy contents"));
    expect(toasts().some((t) => t.tone === "error")).toBe(true);
  });

  it("Download saves the file through the shared feedback path", async () => {
    await show();
    await click(btn("Download"));
    expect(api.agentPullFile).toHaveBeenCalledWith(abs);
    expect(toasts().some((t) => String(t.message).startsWith("Saved a.mjs"))).toBe(true);
  });

  it("More → Copy path / Copy relative path", async () => {
    await show();
    await click(btn("More"));
    const items = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent);
    expect(items).toEqual(["Copy path", "Copy relative path"]);
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]'))[0]);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(abs);
    expect(toasts().some((t) => t.message === "Path copied")).toBe(true);
    await click(btn("More"));
    await click(Array.from(document.body.querySelectorAll('[role="menuitem"]'))[1]);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("src/a.mjs");
  });

  it("More menu is keyboard-operable: focus lands on the menu, arrows move, Enter activates", async () => {
    await show();
    await click(btn("More"));
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    const key = async (k: string) => {
      await act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      });
    };
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Copy path");
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Copy relative path");
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Copy path");
    await key("ArrowUp");
    expect(document.activeElement?.textContent).toBe("Copy relative path");
    await act(async () => {
      (document.activeElement as HTMLElement).click();
    });
    await settle();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("src/a.mjs");
  });

  it("More → a clipboard failure is an error toast", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denied"));
    await show();
    await click(btn("More"));
    await click(document.body.querySelector('[role="menuitem"]'));
    expect(toasts().some((t) => t.tone === "error")).toBe(true);
  });
});

describe("media", () => {
  it("PDF offers Open preview, which opens the existing overlay for that path", async () => {
    const abs = `${CWD}/docs/spec.pdf`;
    files[abs] = { size: 2048, type: "application/octet-stream", body: "%PDF" };
    await show({ file: { abs } });
    expect(text()).toContain("Open preview");
    const seen: Array<{ path: string }> = [];
    window.addEventListener(PREVIEW_PATH_EVENT, ((e: CustomEvent) => seen.push(e.detail)) as unknown as EventListener);
    await click(byText("Open preview"));
    expect(seen).toEqual([{ path: abs }]);
    expect(q(".manta-explorer-footer")!.textContent).toContain("PDF");
  });

  it("images load through the authenticated blob path and report their size", async () => {
    const abs = `${CWD}/docs/pic.png`;
    files[abs] = { body: new Uint8Array([1, 2, 3, 4]), type: "image/png" };
    URL.createObjectURL = vi.fn(() => "blob:pic") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
    await show({ file: { abs } });
    expect(q("img")?.getAttribute("src")).toBe("blob:pic");
    expect(q(".manta-explorer-footer")!.textContent).toContain("Image");
    expect(btn("Copy contents")?.disabled).toBe(true);
  });
});

describe("refresh", () => {
  const abs = `${CWD}/src/a.mjs`;

  it("re-reads without a loading flash and flashes 'Updated' for 3 s when the content changed", async () => {
    files[abs] = { body: "one\n" };
    const [p] = props({ refreshKey: 0 });
    h = mount(<ExplorerViewer {...p} />);
    await settle();
    expect(q(".cm-content")?.textContent).toContain("one");
    expect(text()).not.toContain("Updated");

    files[abs] = { body: "two\n" };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.rerender(<ExplorerViewer {...p} refreshKey={1} />);
    // Content stays on screen while the new content is in flight.
    expect(q(".cm-content")?.textContent).toContain("one");
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(q(".cm-content")?.textContent).toContain("two");
    expect(text()).toContain("Updated");
    expect(q('[role="status"][aria-label="Loading"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(text()).not.toContain("Updated");
  });

  it("no pill when a refresh finds the same content", async () => {
    files[abs] = { body: "same\n" };
    const [p] = props({ refreshKey: 0 });
    h = mount(<ExplorerViewer {...p} />);
    await settle();
    h.rerender(<ExplorerViewer {...p} refreshKey={1} />);
    await settle();
    expect(text()).not.toContain("Updated");
  });

  it("a refresh that cannot reach the box keeps what is shown", async () => {
    files[abs] = { body: "kept\n" };
    const [p] = props({ refreshKey: 0 });
    h = mount(<ExplorerViewer {...p} />);
    await settle();
    files[abs] = { fail: true };
    h.rerender(<ExplorerViewer {...p} refreshKey={1} />);
    await settle();
    expect(q(".cm-content")?.textContent).toContain("kept");
    expect(text()).not.toContain("Couldn’t load");
  });

  it("a refresh that finds the file gone says so", async () => {
    files[abs] = { body: "bye\n" };
    const [p] = props({ refreshKey: 0 });
    h = mount(<ExplorerViewer {...p} />);
    await settle();
    files[abs] = { status: 404, reason: "missing" };
    h.rerender(<ExplorerViewer {...p} refreshKey={1} />);
    await settle();
    expect(text()).toContain("No longer exists");
  });
});

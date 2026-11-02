// @vitest-environment jsdom
//
// Path links in the transcript: a link appears only after the box confirms the
// path; a click opens it in THIS session's Explorer (⌘-click expands); inline
// code keeps its <code>; tool-card headers keep their toggle; Markdown rendered
// in the Explorer routes relative links/images through the viewer.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, type Harness } from "./testHarness";
import { MarkdownBody } from "./MarkdownBody";
import { MessageRow } from "./MessageRow";
import { ToolCall } from "./ToolCall";
import { ToolCard } from "./ToolCard";
import { FileLink, Linkified } from "./Linkified";
import { ExplorerOwnerProvider } from "./explorer/ownerContext";
import { RESOLVE_DEBOUNCE_MS, resetPathResolution } from "./usePathResolution";
import { bumpFileGeneration } from "./explorer/fileChanges";
import { EXPLORER_OPEN_EVENT, type ExplorerOwner, type OpenFileRequest } from "./explorer/types";
import type { FsResolveInput, FsResolved } from "../shared/fsTypes";
import type { OpencodeMessage, OpencodePart } from "../shared/types";

const CWD = "/home/u/proj";
let n = 0;
let owner: ExplorerOwner;

const abs = (p: string) => (p.startsWith("/") ? p : `${CWD}/${p.replace(/^\.\//, "")}`);
const resolveAll = (input: FsResolveInput): FsResolved[] =>
  input.paths.map((p): FsResolved =>
    p.includes("nope")
      ? { input: p, ok: false, reason: "missing" }
      : { input: p, ok: true, abs: abs(p), kind: p.endsWith("/") ? "dir" : "file", size: 1, mtimeMs: 1 },
  );

const anchors = (h: Harness) => Array.from(h.container.querySelectorAll("a"));
const fileLinks = (h: Harness) => Array.from(h.container.querySelectorAll<HTMLAnchorElement>("a.manta-file-link"));

describe("path links", () => {
  let h: Harness | null = null;
  let resolveSpy: ReturnType<typeof vi.fn>;
  let opened: OpenFileRequest[];
  const onOpen = (e: Event) => opened.push((e as CustomEvent<OpenFileRequest>).detail);

  const install = (overrides: Record<string, unknown> = {}) => {
    resolveSpy = vi.fn(async (input: FsResolveInput) => ({ results: resolveAll(input) }));
    installMockApi({ fsResolvePaths: resolveSpy, ...overrides });
  };
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  // Let the debounce fire and the reply render.
  const resolved = async () => {
    await advance(RESOLVE_DEBOUNCE_MS);
    await advance(0);
  };
  const withOwner = (el: React.ReactElement, o: ExplorerOwner | null = owner) => (
    <ExplorerOwnerProvider owner={o}>{el}</ExplorerOwnerProvider>
  );
  const asked = () => resolveSpy.mock.calls.flatMap((c) => (c[0] as FsResolveInput).paths);

  beforeEach(() => {
    vi.useFakeTimers();
    resetPathResolution();
    n += 1;
    owner = { sessionId: `ses_link${n}`, cwd: CWD };
    opened = [];
    window.addEventListener(EXPLORER_OPEN_EVENT, onOpen);
    install();
  });
  afterEach(() => {
    window.removeEventListener(EXPLORER_OPEN_EVENT, onOpen);
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  describe("user bubble (Linkified paths)", () => {
    it("is plain text until the box confirms, then a link with a faint line suffix", async () => {
      h = mount(withOwner(<Linkified text="look at src/a.ts:12 and src/nope.ts please" paths />));
      expect(fileLinks(h)).toHaveLength(0);
      expect(h.text()).toBe("look at src/a.ts:12 and src/nope.ts please");
      await resolved();
      const links = fileLinks(h);
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("href")).toBe("#");
      expect(links[0].getAttribute("data-path")).toBe(`${CWD}/src/a.ts`);
      expect(links[0].textContent).toBe("src/a.ts:12");
      expect(links[0].querySelector("span")?.className).toContain("text-text-faint");
      expect(links[0].className).toContain("decoration-dotted");
      expect(h.text()).toBe("look at src/a.ts:12 and src/nope.ts please");
    });

    it("sends the paths as written, relative to the owner's folder", async () => {
      h = mount(withOwner(<Linkified text="see src/a.ts" paths />));
      await resolved();
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0][0]).toEqual({ base: CWD, paths: ["src/a.ts"] });
    });

    it("renders text exactly as today without an owner, and asks nothing", async () => {
      h = mount(withOwner(<Linkified text="see src/a.ts" paths />, null));
      await resolved();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(anchors(h)).toHaveLength(0);
      expect(h.text()).toBe("see src/a.ts");
    });

    it("paths are opt-in: plain Linkified (tool output) never links them", async () => {
      h = mount(withOwner(<Linkified text="see src/a.ts" />));
      await resolved();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(anchors(h)).toHaveLength(0);
    });

    it("keeps URLs as external links and does not path-link inside them", async () => {
      h = mount(withOwner(<Linkified text="https://a.com/src/a.ts and src/b.ts" paths />));
      await resolved();
      expect(asked()).toEqual(["src/b.ts"]);
      expect(anchors(h).map((a) => a.getAttribute("href"))).toEqual(["https://a.com/src/a.ts", "#"]);
    });

    it("click opens in THIS session's Explorer at the line; ⌘-click expands", async () => {
      h = mount(withOwner(<Linkified text="src/a.ts:12-30" paths />));
      await resolved();
      const a = fileLinks(h)[0];
      const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => void a.dispatchEvent(plain));
      expect(plain.defaultPrevented).toBe(true);
      expect(opened).toEqual([
        { abs: `${CWD}/src/a.ts`, line: 12, endLine: 30, owner, kind: "file", expand: false },
      ]);
      act(() => void a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })));
      expect(opened[1].expand).toBe(true);
    });

    it("a click does not also trigger a clickable parent", async () => {
      const parent = vi.fn();
      h = mount(
        withOwner(
          <div onClick={parent}>
            <Linkified text="src/a.ts" paths />
          </div>,
        ),
      );
      await resolved();
      act(() => fileLinks(h!)[0].click());
      expect(parent).not.toHaveBeenCalled();
      expect(opened).toHaveLength(1);
    });

    it("captures the owner at render: a later owner change does not redirect an open", async () => {
      const other: ExplorerOwner = { sessionId: `ses_other${n}`, cwd: "/home/u/other" };
      h = mount(withOwner(<Linkified text="src/a.ts" paths />));
      await resolved();
      expect(fileLinks(h)[0]).toBeTruthy();
      act(() => fileLinks(h!)[0].click());
      expect(opened[0].owner).toEqual(owner);
      expect(opened[0].owner).not.toEqual(other);
    });

    it("a directory opens as a dir", async () => {
      h = mount(withOwner(<Linkified text="in src/server/ ok" paths />));
      await resolved();
      act(() => fileLinks(h!)[0].click());
      expect(opened[0]).toMatchObject({ abs: `${CWD}/src/server/`, kind: "dir" });
    });

    it("the user's bubble in a MessageRow is path-aware", async () => {
      const msg = {
        info: { id: "u1", sessionID: "s", role: "user" },
        parts: [{ id: "p1", messageID: "u1", type: "text", text: "open src/a.ts" }],
      } as unknown as OpencodeMessage;
      h = mount(
        withOwner(
          <MessageRow msg={msg} showThinking={false} turnDurationMs={null} turnTokens={null} verbSeedId={null} truncation={null} commandInfo={null} />,
        ),
      );
      await resolved();
      expect(fileLinks(h)).toHaveLength(1);
    });
  });

  describe("assistant Markdown", () => {
    it("links a confirmed path in prose", async () => {
      h = mount(withOwner(<MarkdownBody text={"The fix is in **src/server/peek.mjs:28**, not src/nope.ts."} />));
      expect(fileLinks(h)).toHaveLength(0);
      await resolved();
      const links = fileLinks(h);
      expect(links.map((a) => a.textContent)).toEqual(["src/server/peek.mjs:28"]);
      expect(h.text()).toBe("The fix is in src/server/peek.mjs:28, not src/nope.ts.");
      act(() => links[0].click());
      expect(opened[0]).toMatchObject({ abs: `${CWD}/src/server/peek.mjs`, line: 28, owner });
    });

    it("keeps the <code> around a path that is the whole inline-code span", async () => {
      h = mount(withOwner(<MarkdownBody text="Edit `src/a.ts:12` and `AGENTS.md` and `src/nope.ts` and `npm run x`" />));
      await resolved();
      const codes = Array.from(h.container.querySelectorAll("code"));
      expect(codes).toHaveLength(4);
      expect(codes[0].className).toBe("");
      expect(codes[0].querySelector("a.manta-file-link")?.textContent).toBe("src/a.ts:12");
      expect(codes[1].querySelector("a.manta-file-link")?.getAttribute("data-path")).toBe(`${CWD}/AGENTS.md`);
      expect(codes[2].querySelector("a")).toBeNull();
      expect(codes[2].textContent).toBe("src/nope.ts");
      expect(codes[3].querySelector("a")).toBeNull();
      expect(asked()).not.toContain("npm run x");
      // The inline-code link inherits the code font; prose links add their own.
      expect(codes[0].querySelector("a")!.className).not.toContain("font-mono");
    });

    it("does not link paths in fenced code or existing links", async () => {
      h = mount(
        withOwner(<MarkdownBody text={"```\nsrc/in-fence.ts\n```\n\n[text src/in-link.ts](https://a.com/x)"} />),
      );
      await resolved();
      expect(asked()).toEqual([]);
      expect(fileLinks(h)).toHaveLength(0);
    });

    it("renders exactly as today without an owner", async () => {
      h = mount(<MarkdownBody text={"The fix is in src/a.ts and `src/b.ts` and [x](manta-file:src%2Fa.ts)"} />);
      await resolved();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(anchors(h)).toHaveLength(0);
      expect(h.text()).toBe("The fix is in src/a.ts and src/b.ts and x");
    });

    it("keeps external links working alongside path links", async () => {
      h = mount(withOwner(<MarkdownBody text="[docs](https://a.com/x) and src/a.ts" />));
      await resolved();
      expect(anchors(h).map((a) => a.getAttribute("href"))).toEqual(["https://a.com/x", "#"]);
    });
  });

  describe("tool-card header (ToolCard argPath)", () => {
    const link = () => <FileLink abs={`${CWD}/src/a.ts`} text="src/a.ts" owner={owner} mono />;

    it("a link click does not toggle; the disclosure button toggles once; the row toggles too", () => {
      let toggles = 0;
      h = mount(<ToolCard tone="ok" name="Read" argPath={link()} expanded={false} onToggle={() => toggles++} />);
      const header = h.container.firstElementChild!.firstElementChild as HTMLElement;
      expect(header.tagName).toBe("DIV");
      // No anchor inside a button; exactly one disclosure control.
      expect(h.container.querySelector("button a")).toBeNull();
      const disclosure = header.querySelectorAll("button[aria-expanded]");
      expect(disclosure).toHaveLength(1);
      expect(disclosure[0].getAttribute("aria-label")).toBe("Show details");

      act(() => h!.container.querySelector<HTMLAnchorElement>("a.manta-file-link")!.click());
      expect(toggles).toBe(0);
      expect(opened).toHaveLength(1);

      act(() => (disclosure[0] as HTMLButtonElement).click());
      expect(toggles).toBe(1);

      act(() => header.click());
      expect(toggles).toBe(2);
    });

    it("keeps the copy button from toggling and shows the link in place of arg", () => {
      let toggles = 0;
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      h = mount(
        <ToolCard name="Read" arg="ignored" argPath={link()} copyText="body" expanded onToggle={() => toggles++} />,
      );
      expect(h.text()).not.toContain("ignored");
      expect(h.text()).toContain("src/a.ts");
      act(() => h!.container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
      expect(writeText).toHaveBeenCalledWith("body");
      expect(toggles).toBe(0);
    });

    it("a card without argPath keeps its button header", () => {
      h = mount(<ToolCard name="Read" arg="src/a.ts" expanded={false} onToggle={() => {}} />);
      const header = h.container.firstElementChild!.firstElementChild as HTMLElement;
      expect(header.querySelector("button.flex-1")).not.toBeNull();
      expect(header.className).not.toContain("cursor-pointer");
    });

    const readPart = (tool: string, input: Record<string, unknown>): OpencodePart =>
      ({
        id: "t1",
        messageID: "m1",
        type: "tool",
        tool,
        state: { status: "completed", input, output: "x", title: "ignored", metadata: {} },
      }) as unknown as OpencodePart;

    it("ToolCall: a Read of a confirmed file shows a link, the card stays collapsed on click", async () => {
      h = mount(withOwner(<ToolCall part={readPart("read", { filePath: `${CWD}/src/a.ts` })} verbose={false} />));
      expect(fileLinks(h)).toHaveLength(0);
      await resolved();
      const a = fileLinks(h)[0];
      expect(a.textContent).toBe("src/a.ts");
      expect(resolveSpy.mock.calls[0][0]).toEqual({ base: CWD, paths: [`${CWD}/src/a.ts`] });
      expect(h.container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
      act(() => a.click());
      expect(h.container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
      expect(opened[0]).toMatchObject({ abs: `${CWD}/src/a.ts`, kind: "file", owner });
      act(() => h!.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
      expect(h.container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    });

    it("ToolCall: a file the tool is about to create links once it exists", async () => {
      let exists = false;
      install({
        fsResolvePaths: vi.fn(async (input: FsResolveInput) => ({
          results: input.paths.map(
            (p): FsResolved =>
              exists
                ? { input: p, ok: true, abs: p, kind: "file", size: 1, mtimeMs: 1 }
                : { input: p, ok: false, reason: "missing" },
          ),
        })),
      });
      h = mount(withOwner(<ToolCall part={readPart("write", { filePath: `${CWD}/new.ts` })} verbose={false} />));
      await resolved();
      expect(fileLinks(h)).toHaveLength(0);
      expect(h.text()).toContain("ignored"); // today's arg text
      exists = true;
      act(() => bumpFileGeneration(owner.sessionId));
      await resolved();
      expect(fileLinks(h)).toHaveLength(1);
    });

    it("ToolCall: no owner, no link, today's markup", async () => {
      h = mount(<ToolCall part={readPart("read", { filePath: `${CWD}/src/a.ts` })} verbose={false} />);
      await resolved();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(fileLinks(h)).toHaveLength(0);
      expect(h.container.querySelector("button.flex-1")).not.toBeNull();
    });

    it("ToolCall: tools without a structured path (bash) never ask", async () => {
      h = mount(withOwner(<ToolCall part={readPart("bash", { command: "cat /home/u/proj/src/a.ts" })} verbose={false} />));
      await resolved();
      expect(resolveSpy).not.toHaveBeenCalled();
    });
  });

  describe("Markdown rendered in the Explorer (fileContext)", () => {
    const ctx = () => ({
      openLink: vi.fn(),
      resolveImage: vi.fn(async (src: string) => (src.includes("missing") ? null : `blob:${src}`)),
    });

    it("routes relative links and #fragments to the viewer, never the renderer", () => {
      const c = ctx();
      h = mount(<MarkdownBody text="[a](docs/a.md) [b](#intro) [c](../up.md#x)" fileContext={c} />);
      const links = anchors(h);
      expect(links.map((a) => a.textContent)).toEqual(["a", "b", "c"]);
      for (const a of links) {
        const e = new MouseEvent("click", { bubbles: true, cancelable: true });
        act(() => void a.dispatchEvent(e));
        expect(e.defaultPrevented).toBe(true);
      }
      expect(c.openLink.mock.calls.map((x) => x[0])).toEqual(["docs/a.md", "#intro", "../up.md#x"]);
    });

    it("keeps http(s) external and renders any other scheme as plain text", () => {
      const c = ctx();
      h = mount(<MarkdownBody text="[web](https://a.com/x) [ftp](ftp://a.com) [js](javascript:alert(1))" fileContext={c} />);
      const links = anchors(h);
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("target")).toBe("_blank");
      expect(links[0].getAttribute("href")).toBe("https://a.com/x");
      expect(h.text()).toBe("web ftp js");
      act(() => links[0].click());
      expect(c.openLink).not.toHaveBeenCalled();
    });

    it("gives headings ids so #fragment links have somewhere to go", () => {
      h = mount(<MarkdownBody text={"# Intro\n\n## Getting started"} fileContext={ctx()} />);
      expect(h.container.querySelector("h1")?.id).toBe("intro");
      expect(h.container.querySelector("h2")?.id).toBe("getting-started");
    });

    it("loads a relative image through resolveImage and falls back to its alt text", async () => {
      vi.useRealTimers();
      const c = ctx();
      h = mount(<MarkdownBody text="![logo](img/a.png) ![gone](img/missing.png)" fileContext={c} />);
      await h.flush();
      expect(c.resolveImage.mock.calls.map((x) => x[0])).toEqual(["img/a.png", "img/missing.png"]);
      const imgs = Array.from(h.container.querySelectorAll("img"));
      expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["blob:img/a.png"]);
      expect(h.text()).toContain("gone");
    });

    it("never loads an external image: it is a link showing the alt text", () => {
      const c = ctx();
      h = mount(<MarkdownBody text="![badge](https://a.com/x.svg)" fileContext={c} />);
      expect(h.container.querySelector("img")).toBeNull();
      const a = anchors(h)[0];
      expect(a.textContent).toBe("badge");
      expect(a.getAttribute("href")).toBe("https://a.com/x.svg");
      expect(c.resolveImage).not.toHaveBeenCalled();
    });

    it("adds no path links (the document's own links are the links)", async () => {
      h = mount(withOwner(<MarkdownBody text="see src/a.ts and `src/b.ts`" fileContext={ctx()} />));
      await resolved();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(fileLinks(h)).toHaveLength(0);
    });

    it("without fileContext an <img> is unchanged", () => {
      h = mount(<MarkdownBody text="![x](https://a.com/x.png)" />);
      expect(h.container.querySelector("img")?.getAttribute("src")).toBe("https://a.com/x.png");
    });
  });
});

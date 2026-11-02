// @vitest-environment jsdom
//
// ChatPanel provides the Explorer owner around its transcript: a chat window's
// assistant text gets confirmed path links owned by {sessionId, cwd}; a panel
// without a window (previous-session view, orphaned pane) gets none.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { resetPathResolution } from "./usePathResolution";
import { EXPLORER_OPEN_EVENT, type OpenFileRequest } from "./explorer/types";
import type { FsResolveInput } from "../shared/fsTypes";

const SID = "ses_pl_panel";
const CWD = "/home/u/proj";
const MESSAGES = [
  {
    info: { id: "msg_a", sessionID: SID, role: "assistant", time: { created: 1, completed: 2 } },
    parts: [{ type: "text", id: "p_a", messageID: "msg_a", text: "The bug is in src/a.ts:7 and `src/b.ts`." }],
  },
];

describe("ChatPanel path links", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    resetPathResolution();
    vi.useRealTimers();
  });

  async function open(props: Partial<React.ComponentProps<typeof ChatPanel>>) {
    const resolve = vi.fn(async (input: FsResolveInput) => ({
      results: input.paths.map((p) => ({ input: p, ok: true as const, abs: `${CWD}/${p}`, kind: "file" as const, size: 1, mtimeMs: 1 })),
    }));
    installMockApi({ opencodeMessages: () => Promise.resolve(MESSAGES), fsResolvePaths: resolve });
    resetStore();
    h = mount(<ChatPanel sessionId={SID} tmuxSession="proj" windowIndex={1} cwd={CWD} isActive {...props} />);
    await h.flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    await h.flush();
    return resolve;
  }

  it("links confirmed paths in the transcript, owned by this session and folder", async () => {
    const resolve = await open({});
    expect(resolve.mock.calls.flatMap((c) => (c[0] as FsResolveInput).base)).toEqual([CWD]);
    const links = Array.from(h!.container.querySelectorAll<HTMLAnchorElement>("a.manta-file-link"));
    expect(links.map((a) => a.textContent)).toEqual(["src/a.ts:7", "src/b.ts"]);

    const seen: OpenFileRequest[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<OpenFileRequest>).detail);
    window.addEventListener(EXPLORER_OPEN_EVENT, on);
    act(() => links[0].click());
    window.removeEventListener(EXPLORER_OPEN_EVENT, on);
    expect(seen).toEqual([
      { abs: `${CWD}/src/a.ts`, line: 7, endLine: undefined, owner: { sessionId: SID, cwd: CWD }, kind: "file", expand: false },
    ]);
  });

  it("a pane whose window is gone has no Explorer, so no path links", async () => {
    const resolve = await open({ tmuxSession: null, windowIndex: null });
    expect(resolve).not.toHaveBeenCalled();
    expect(h!.container.querySelectorAll("a.manta-file-link")).toHaveLength(0);
    expect(h!.text()).toContain("src/a.ts:7");
  });
});

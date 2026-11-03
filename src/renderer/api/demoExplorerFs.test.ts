// The demo filesystem must equal the mockup's names / sizes / line counts, and
// answer the three fs:* channels the way the box does.

import { describe, it, expect } from "vitest";
import { formatBytes } from "../chatUtils";
import {
  DEMO_EXPLORER_CWD,
  PEEK_MJS,
  PEEK_SCOPE_MD,
  buildIndexMjs,
  demoFindFiles,
  demoFsGitStatus,
  demoFsList,
  demoFsResolvePaths,
  demoPeekFetch,
} from "./demoExplorerFs";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const lineCount = (s: string) => s.replace(/\n$/, "").split("\n").length;
const resolve = (paths: string[], base = DEMO_EXPLORER_CWD) => demoFsResolvePaths({ base, paths }).results;

describe("fixture files equal the mockup", () => {
  it("peek-scope.md is 18 lines, 612 B", () => {
    expect(lineCount(PEEK_SCOPE_MD)).toBe(18);
    expect(bytes(PEEK_SCOPE_MD)).toBe(612);
  });

  it("peek.mjs is 142 lines, 4.8 KB, with the guard comment on line 28", () => {
    expect(lineCount(PEEK_MJS)).toBe(142);
    expect(formatBytes(bytes(PEEK_MJS))).toBe("4.8 KB");
    expect(PEEK_MJS.split("\n")[27]).toContain("Guard:");
  });

  it("index.mjs is 5,811 lines, 212 KB, with the download route at 3920", () => {
    const text = buildIndexMjs();
    expect(lineCount(text)).toBe(5811);
    expect(formatBytes(bytes(text))).toBe("212 KB");
    expect(text.split("\n")[3926]).toContain("streamFile");
  });
});

describe("fs:resolve-paths", () => {
  it("resolves relative, ~ and absolute paths; refuses the rest with the box's reasons", () => {
    const r = resolve(["src/server/peek.mjs", "~/notes/todo.md", "/home/dev/projects/manta/AGENTS.md", "src/server/gone.mjs", "/etc/caddy/Caddyfile", "../../../../../etc/passwd"]);
    expect(r.map((x) => (x.ok ? x.kind : x.reason))).toEqual(["file", "file", "file", "missing", "missing", "missing"]);
    const peek = r[0];
    expect(peek.ok && peek.abs).toBe(`${DEMO_EXPLORER_CWD}/src/server/peek.mjs`);
    expect(peek.ok && peek.size).toBe(bytes(PEEK_MJS));
  });

  it("a folder resolves as a dir", () => {
    expect(resolve(["src/server"])[0]).toMatchObject({ ok: true, kind: "dir" });
  });
});

describe("fs:list", () => {
  it("lists the session folder: folders first, node_modules ignored, .git never", () => {
    const r = demoFsList({ dir: DEMO_EXPLORER_CWD });
    if (!r.ok) throw new Error("not ok");
    expect(r.entries.map((e) => e.name)).toEqual(["docs", "node_modules", "src", "AGENTS.md"]);
    expect(r.entries.find((e) => e.name === "node_modules")?.ignored).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("answers a missing / outside folder with a reason", () => {
    expect(demoFsList({ dir: `${DEMO_EXPLORER_CWD}/nope` })).toEqual({ ok: false, reason: "missing" });
    expect(demoFsList({ dir: "/etc" })).toEqual({ ok: false, reason: "missing" });
  });

  it("the folders above home exist, down to /", () => {
    const top = demoFsList({ dir: "/" });
    if (!top.ok) throw new Error("not ok");
    expect(top.entries.map((e) => e.abs)).toEqual(["/home"]);
    const home = demoFsList({ dir: "/home" });
    if (!home.ok) throw new Error("not ok");
    expect(home.entries.map((e) => e.abs)).toEqual(["/home/dev"]);
    expect(resolve([".."], "/home/dev")[0]).toMatchObject({ ok: true, abs: "/home", kind: "dir" });
  });
});

describe("fs:git-status", () => {
  it("maps changes to the root, and says not-git outside the repo", () => {
    expect(demoFsGitStatus({ root: DEMO_EXPLORER_CWD })).toEqual({
      ok: true,
      changes: { "docs/peek-scope.md": "A", "src/server/index.mjs": "M", "src/server/peek.mjs": "M" },
    });
    expect(demoFsGitStatus({ root: `${DEMO_EXPLORER_CWD}/src` })).toMatchObject({ ok: true, changes: { "server/peek.mjs": "M" } });
    expect(demoFsGitStatus({ root: "/home/dev/notes" })).toEqual({ ok: false, reason: "not-git" });
  });
});

describe("quick open", () => {
  it("ranks the mockup's three results for `peek`", () => {
    expect(demoFindFiles("peek", DEMO_EXPLORER_CWD)).toEqual([
      "src/server/peek.mjs",
      "src/server/peek.test.mjs",
      "docs/peek-scope.md",
    ]);
  });
});

describe("demoPeekFetch (the box's /api/peek)", () => {
  const ask = (abs: string, method: "GET" | "HEAD" = "GET") => demoPeekFetch(abs, { method, headers: {} });

  it("HEAD gives the size; GET gives the bytes", async () => {
    const head = await ask(`${DEMO_EXPLORER_CWD}/docs/peek-scope.md`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("612");
    expect(await (await ask(`${DEMO_EXPLORER_CWD}/docs/peek-scope.md`)).text()).toBe(PEEK_SCOPE_MD);
  });

  it("refusals carry the reason the viewer maps to its states", async () => {
    const missing = await ask("/home/dev/notes/old-plan.md");
    expect([missing.status, (await missing.json()).reason]).toEqual([404, "missing"]);
    const locked = await ask("/home/dev/notes/private.txt");
    expect([locked.status, (await locked.json()).reason]).toEqual([403, "permission"]);
    await expect(ask("/home/dev/notes/flaky.md")).rejects.toThrow(TypeError);
  });

  it("a loading file stays pending until aborted", async () => {
    const c = new AbortController();
    const p = demoPeekFetch("/home/dev/notes/slow.md", { method: "GET", headers: {}, signal: c.signal });
    c.abort();
    await expect(p).rejects.toThrow();
  });

  it("the video declares 812 MB without any bytes", async () => {
    const head = await ask("/home/dev/downloads/video.mov", "HEAD");
    expect(Number(head.headers.get("content-length"))).toBe(812 * 1024 * 1024);
  });
});

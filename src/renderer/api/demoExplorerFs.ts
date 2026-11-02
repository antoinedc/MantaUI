// demoExplorerFs.ts — the demo transport's pretend box filesystem for the file
// explorer (docs/screens/explorer). It answers the three `fs*` channels, the
// quick-open search and the viewer's file reads, so the Explorer renders with no
// box behind it.
//
// File names, sizes and line counts equal the mockup's (docs/screens/explorer/
// mockup.html): peek-scope.md is 18 lines / 612 B, peek.mjs 142 lines / 4.8 KB,
// index.mjs 5,811 lines / 212 KB — so the side-by-side compares layout, not words.
// Every path is fictional; the home directory is /home/dev.

import { DEMO_T0 } from "./demoFixture.js";
import type {
  FsEntry,
  FsGitBadge,
  FsGitStatusResult,
  FsListInput,
  FsListResult,
  FsReason,
  FsResolveInput,
  FsResolveResult,
  FsResolved,
} from "../../shared/fsTypes.js";

export const DEMO_HOME = "/home/dev";
export const DEMO_EXPLORER_CWD = `${DEMO_HOME}/projects/manta/fix-peek-range`;

const MIN = 60_000;

/** What the viewer's file read gets back for a path. */
export type DemoPeek =
  | { kind: "ok" }
  /** The route answers with this refusal (the viewer maps the reason to its state). */
  | { kind: "refuse"; status: 403 | 404; reason: FsReason }
  /** The box never answers (a network failure). */
  | { kind: "network" }
  /** The request stays pending until it is aborted — the viewer's loading state. */
  | { kind: "hang" };

type FileNode = {
  kind: "file";
  mtimeMs: number;
  /** Text content, or a function producing it (large generated files). */
  text?: string | (() => string);
  bytes?: Uint8Array;
  /** Declared size when there are no real bytes behind it (a huge video). */
  size?: number;
  peek: DemoPeek;
};
type DirNode = { kind: "dir"; ignored?: boolean; mtimeMs: number };
type Node = FileNode | DirNode;

// ---------------------------------------------------------------------------
// File contents
// ---------------------------------------------------------------------------

export const PEEK_SCOPE_MD = [
  "# Peek & download scope",
  "",
  "Inline media and the artifacts panel read files through",
  "the same route. Both now share **one** rule: any regular",
  "file inside the user's home directory, however it was reached — peek, downloads, and tree alike.",
  "",
  "## Rules",
  "",
  "- Paths resolve against `$HOME`; `~` is expanded at the edge.",
  "- Anything outside home answers `403`, symlinks included.",
  "- Downloads are non-destructive.",
  "",
  "| Route | Before | After |",
  "|---|---|---|",
  "| `/api/peek` | home | home |",
  "| `/api/download` | outbox | home |",
  "",
  "> Display and download must never disagree — see [src/server/peek.mjs:28](src/server/peek.mjs#L28).",
].join("\n") + "\n";

export const PEEK_MJS = [
  "// GET /api/peek?path=<abs> — streams a box file back to the client.",
  "//",
  "// Display and download share ONE rule (see docs/peek-scope.md): the path must",
  "// resolve to a regular file inside the user's home directory. Everything the",
  "// transcript can show, it can also save. A path that leaves home is refused before any byte is read.",
  "",
  'import { homedir } from "node:os";',
  'import { resolve } from "node:path";',
  'import { stat } from "node:fs/promises";',
  'import { createReadStream } from "node:fs";',
  'import { parseRange } from "./range.mjs";',
  "",
  "const MAX_BODY = 25 * 1024 * 1024; // the viewer's own limit; nothing larger is streamed inline",
  "",
  "// Built once at boot; the handler itself holds no state, so one instance",
  "// serves every request and nothing here needs tearing down.",
  "export function createPeekHandler({ writeJsonError, pipeline, MIME }) {",
  "  return async function handlePeek(req, res, url) {",
  '    const raw = url.searchParams.get("path") ?? "";',
  "    if (!raw) {",
  '      writeJsonError(res, 400, { error: "path is required" });',
  "      return;",
  "    }",
  "    // Expand ~ to $HOME so callers can pass ~/foo/bar.",
  "    let resolved = raw;",
  '    if (resolved === "~") resolved = homedir() + "/";',
  "    else resolved = resolve(resolved);",
  "    // Guard: resolved path must stay inside the user's home dir.",
  '    const home = homedir() + "/";',
  "    if (resolved !== home && !resolved.startsWith(home)) {",
  '      writeJsonError(res, 403, { error: "path outside home directory" });',
  "      return;",
  "    }",
  "    let s;",
  "    try {",
  "      s = await stat(resolved);",
  "    } catch (e) {",
  '      if (e?.code === "ENOENT") {',
  '        writeJsonError(res, 404, { error: "not found" });',
  "        return;",
  "      }",
  '      if (e?.code === "EACCES") {',
  '        writeJsonError(res, 403, { error: "permission denied" });',
  "        return;",
  "      }",
  '      writeJsonError(res, 500, { error: "stat failed" });',
  "      return;",
  "    }",
  "    if (!s.isFile()) {",
  '      writeJsonError(res, 404, { error: "not a file" });',
  "      return;",
  "    }",
  '    const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();',
  '    const type = MIME[ext] ?? "application/octet-stream";',
  "    // A range request is how the video element seeks and how the viewer probes for the reason a file is refused; a malformed or unsatisfiable one is answered with a 416.",
  "    const range = parseRange(req.headers.range, s.size);",
  '    if (range === "invalid") {',
  '      res.writeHead(416, { "content-range": `bytes */${s.size}` });',
  "      res.end();",
  "      return;",
  "    }",
  "    const headers = {",
  '      "content-type": type,',
  '      "accept-ranges": "bytes",',
  '      "cache-control": "no-store",',
  "    };",
  "    if (range) {",
  '      headers["content-range"] = `bytes ${range.start}-${range.end}/${s.size}`;',
  '      headers["content-length"] = range.end - range.start + 1;',
  "      res.writeHead(206, headers);",
  "    } else {",
  '      headers["content-length"] = s.size;',
  "      res.writeHead(200, headers);",
  "    }",
  '    if (req.method === "HEAD") {',
  "      res.end();",
  "      return;",
  "    }",
  "    const stream = createReadStream(resolved, range ?? undefined);",
  "    try {",
  "      await pipeline(stream, res);",
  "    } catch {",
  "      // Client went away mid-stream; nothing to report.",
  "    }",
  "  };",
  "}",
  "",
  "// The viewer asks for a body only when HEAD said it fits (size from content-length).",
  "export function fitsPreview(size) {",
  "  return Number.isFinite(size) && size >= 0 && size <= MAX_BODY;",
  "}",
  "",
  "// Binary sniff, mirrored from the renderer: a NUL byte in the first 8 KiB.",
  "export function looksBinary(buf) {",
  "  const n = Math.min(buf.length, 8192);",
  "  for (let i = 0; i < n; i++) {",
  "    if (buf[i] === 0) return true;",
  "  }",
  "  return false;",
  "}",
  "",
  "// Content-Disposition for a download; keeps the original file name.",
  "export function attachmentName(abs) {",
  '  const name = abs.slice(abs.lastIndexOf("/") + 1);',
  '  return `attachment; filename="${name.replace(/"/g, "")}"`;',
  "}",
  "",
  "// Parses `bytes=a-b` into an inclusive window, or null when absent.",
  "export function describeRange(header, size) {",
  "  if (!header) return null;",
  "  const m = /^bytes=(\\d*)-(\\d*)$/.exec(header);",
  '  if (!m) return "invalid";',
  '  const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);',
  '  const end = m[2] === "" || m[1] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);',
  '  if (start > end || start >= size) return "invalid";',
  "  return { start, end };",
  "}",
  "",
  "// Maps a stat failure to the HTTP status the route answers with; anything unexpected is a 500.",
  "export function statusFor(code) {",
  "  switch (code) {",
  '    case "ENOENT":',
  "      return 404;",
  '    case "EACCES":',
  '    case "EPERM":',
  '    case "ELOOP":',
  "      return 403;",
  "    default:",
  "      return 500;",
  "  }",
  "}",
  "",
  "// Cheap guard for the tree: names that must never be listed.",
  'const HIDDEN = new Set([".git"]);',
  "",
  "export function isListable(name) {",
  "  return !HIDDEN.has(name);",
  "}",
  "",
  "export const LIMITS = Object.freeze({ maxBody: MAX_BODY, sniffBytes: 8192 });",
  "// Route constant, shared with the download handler so the two cannot drift apart.",
  'export const PEEK_ROUTE = "/api/peek";',
].join("\n") + "\n";

/** index.mjs is a 5,811-line, 212 KB file; lines 3920–3928 are the download route. */
const INDEX_MJS_LINES = 5811;
const INDEX_MJS_BYTES = 217_000;
const INDEX_MJS_EXCERPT_AT = 3920;
const INDEX_MJS_EXCERPT = [
  "// GET /api/download?path=<abs> — saves a box file to the client.",
  "// Same home-scoped rule as /api/peek: anything the transcript can",
  "// display, it can also save.",
  'if (req.method === "GET" && path === "/api/download") {',
  '  const rel = url.searchParams.get("path") ?? "";',
  "  const abs = resolveHomePath(rel);",
  '  if (!abs) return writeJsonError(res, 403, { error: "outside home" });',
  '  return streamFile(res, abs, { disposition: "attachment" });',
  "}",
];

/** Deterministic filler for the rest of index.mjs: plausible handler code, sized to land on the target. */
export function buildIndexMjs(): string {
  const encoder = new TextEncoder();
  const build = (slack: (n: number) => number): string => {
    const lines: string[] = [];
    for (let n = 1; n <= INDEX_MJS_LINES; n++) {
      const at = n - INDEX_MJS_EXCERPT_AT;
      if (at >= 0 && at < INDEX_MJS_EXCERPT.length) {
        lines.push(INDEX_MJS_EXCERPT[at]);
        continue;
      }
      const route = `/api/route-${Math.floor(n / 9)}`;
      switch (n % 9) {
        case 0:
          lines.push("}");
          break;
        case 1:
          lines.push(`// ${route} — handler ${n}${slack(n) > 0 ? ` ${"-".repeat(slack(n))}` : ""}`);
          break;
        case 2:
          lines.push(`if (req.method === "POST" && path === "${route}") {`);
          break;
        case 3:
          lines.push(`  const body = await readJsonBody(req, { limit: ${1024 * (1 + (n % 7))} });`);
          break;
        case 4:
          lines.push(`  const result = await handlers.route${Math.floor(n / 9)}(body, { session });`);
          break;
        case 5:
          lines.push("  if (!result.ok) {");
          break;
        case 6:
          lines.push(`    return writeJsonError(res, ${errorStatus(n)}, result.error);`);
          break;
        case 7:
          lines.push("  }");
          break;
        default:
          lines.push("  return writeJson(res, 200, result.value);");
      }
    }
    return lines.join("\n") + "\n";
  };
  // Spread the slack over the route comments so the file lands on its size.
  const comments = Math.floor(INDEX_MJS_LINES / 9);
  const missing = INDEX_MJS_BYTES - encoder.encode(build(() => 0)).length;
  const each = Math.max(0, Math.floor((missing - comments) / comments));
  const extra = Math.max(0, missing - comments * (each + 1));
  // `each + 1` bytes per comment (the space and the dashes); the first `extra` ones take one more.
  return build((n) => (missing > 0 ? each + (Math.floor(n / 9) <= extra ? 1 : 0) : 0));
}

function errorStatus(n: number): number {
  return n % 2 === 0 ? 400 : 422;
}

const RANGE_MJS = [
  "// Parses an HTTP Range header against a file of `size` bytes.",
  "// Returns { start, end } (inclusive), null when there is no Range, or \"invalid\".",
  "export function parseRange(header, size) {",
  "  if (!header) return null;",
  "  const m = /^bytes=(\\d*)-(\\d*)$/.exec(header);",
  '  if (!m) return "invalid";',
  "  const [, a, b] = m;",
  '  if (a === "" && b === "") return "invalid";',
  '  let start = a === "" ? size - Number(b) : Number(a);',
  '  let end = a === "" || b === "" ? size - 1 : Number(b);',
  "  start = Math.max(0, start);",
  "  end = Math.min(end, size - 1);",
  '  if (start > end) return "invalid";',
  "  return { start, end };",
  "}",
].join("\n") + "\n";

const PEEK_TEST_MJS = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { createPeekHandler } from "./peek.mjs";',
  "",
  'test("a path outside home is refused with 403", async () => {',
  "  const sent = [];",
  "  const handle = createPeekHandler({ writeJsonError: (_r, status) => sent.push(status), pipeline: async () => {}, MIME: {} });",
  '  await handle({ headers: {} }, {}, new URL("http://x/api/peek?path=/etc/passwd"));',
  "  assert.deepEqual(sent, [403]);",
  "});",
].join("\n") + "\n";

const AGENTS_MD = [
  "# AGENTS.md",
  "",
  "Context for agents working in this repository.",
  "",
  "## Layout",
  "",
  "- `src/server/` — the box server: routes, file access, the event bus.",
  "- `docs/` — specs and design notes.",
  "",
  "## Rules",
  "",
  "- Every file route goes through the shared home-scoped policy.",
  "- Expected refusals are returned, never thrown.",
  "- Run the server tests before pushing: `npm run test:server`.",
].join("\n") + "\n";

const TODO_MD = [
  "# Todo",
  "",
  "- [x] Align the peek and download routes",
  "- [ ] Re-check symlinks that point out of home",
  "- [ ] Write the release note",
].join("\n") + "\n";

const SQLITE_BYTES = new Uint8Array([
  ...new TextEncoder().encode("SQLite format 3"),
  0, 4, 0, 1, 1, 0, 64, 32, 32, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0,
]);

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const REPO = DEMO_EXPLORER_CWD;
const fresh = DEMO_T0 - 2 * MIN;
const dayOld = DEMO_T0 - 26 * 60 * MIN;

const file = (text: string | (() => string), over: Partial<FileNode> = {}): FileNode => ({
  kind: "file",
  mtimeMs: fresh,
  text,
  peek: { kind: "ok" },
  ...over,
});
const dir = (over: Partial<DirNode> = {}): DirNode => ({ kind: "dir", mtimeMs: dayOld, ...over });

let cache: Map<string, Node> | null = null;

function nodes(): Map<string, Node> {
  if (cache) return cache;
  const m = new Map<string, Node>();
  const add = (abs: string, n: Node) => {
    m.set(abs, n);
    // Every ancestor below home exists as a folder.
    let at = abs;
    for (;;) {
      at = at.slice(0, at.lastIndexOf("/"));
      if (at.length <= DEMO_HOME.length || m.has(at)) break;
      m.set(at, dir());
    }
  };

  add(`${DEMO_HOME}/projects/manta/AGENTS.md`, file(AGENTS_MD, { mtimeMs: dayOld }));
  add(`${REPO}/AGENTS.md`, file(AGENTS_MD, { mtimeMs: dayOld }));
  add(`${REPO}/src/server/index.mjs`, file(() => buildIndexMjs()));
  add(`${REPO}/src/server/peek.mjs`, file(PEEK_MJS));
  add(`${REPO}/src/server/peek.test.mjs`, file(PEEK_TEST_MJS, { mtimeMs: dayOld }));
  add(`${REPO}/src/server/range.mjs`, file(RANGE_MJS, { mtimeMs: dayOld }));
  add(`${REPO}/docs/peek-scope.md`, file(PEEK_SCOPE_MD));
  add(`${REPO}/node_modules`, dir({ ignored: true }));
  add(`${REPO}/node_modules/.package-lock.json`, file('{ "name": "fix-peek-range", "lockfileVersion": 3 }\n', { mtimeMs: dayOld }));

  add(`${DEMO_HOME}/notes/todo.md`, file(TODO_MD, { mtimeMs: dayOld }));
  // Resolves, then cannot be read: the viewer's four non-text outcomes + the two load states.
  add(`${DEMO_HOME}/notes/old-plan.md`, file("", { peek: { kind: "refuse", status: 404, reason: "missing" } }));
  add(`${DEMO_HOME}/notes/private.txt`, file("", { peek: { kind: "refuse", status: 403, reason: "permission" } }));
  add(`${DEMO_HOME}/notes/flaky.md`, file("", { peek: { kind: "network" } }));
  add(`${DEMO_HOME}/notes/slow.md`, file("", { peek: { kind: "hang" } }));
  add(`${DEMO_HOME}/downloads/video.mov`, file("", { text: undefined, size: 812 * 1024 * 1024 }));
  add(`${DEMO_HOME}/downloads/app.sqlite`, file("", { text: undefined, bytes: SQLITE_BYTES }));

  cache = m;
  return m;
}

const CONTENT_TYPES: Record<string, string> = {
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".mov": "video/quicktime",
};

const enc = new TextEncoder();

function bytesOf(n: FileNode): Uint8Array {
  if (n.bytes) return n.bytes;
  const t = typeof n.text === "function" ? n.text() : (n.text ?? "");
  return enc.encode(t);
}

function sizeOf(n: FileNode): number {
  return n.size ?? bytesOf(n).length;
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

function normalize(base: string, raw: string): string {
  const expanded = raw === "~" ? DEMO_HOME : raw.startsWith("~/") ? `${DEMO_HOME}/${raw.slice(2)}` : raw;
  const joined = expanded.startsWith("/") ? expanded : `${base}/${expanded}`;
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

const insideHome = (abs: string) => abs === DEMO_HOME || abs.startsWith(`${DEMO_HOME}/`);

function lookup(abs: string): { ok: true; node: Node } | { ok: false; reason: FsReason } {
  if (!insideHome(abs)) return { ok: false, reason: "outside-home" };
  if (abs === DEMO_HOME) return { ok: true, node: dir() };
  const node = nodes().get(abs);
  return node ? { ok: true, node } : { ok: false, reason: "missing" };
}

// ---------------------------------------------------------------------------
// fs:* channels
// ---------------------------------------------------------------------------

export function demoFsResolvePaths(input: FsResolveInput): FsResolveResult {
  const results = input.paths.map((p): FsResolved => {
    const abs = normalize(input.base, p);
    const hit = lookup(abs);
    if (!hit.ok) return { input: p, ok: false, reason: hit.reason };
    const n = hit.node;
    return n.kind === "dir"
      ? { input: p, ok: true, abs, kind: "dir", size: 0, mtimeMs: n.mtimeMs }
      : { input: p, ok: true, abs, kind: "file", size: sizeOf(n), mtimeMs: n.mtimeMs };
  });
  return { results };
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function demoFsList(input: FsListInput): FsListResult {
  const dirAbs = normalize(DEMO_HOME, input.dir);
  const hit = lookup(dirAbs);
  if (!hit.ok) return { ok: false, reason: hit.reason };
  if (hit.node.kind !== "dir") return { ok: false, reason: "not-file" };
  const prefix = dirAbs === "/" ? "/" : `${dirAbs}/`;
  const entries: FsEntry[] = [];
  for (const [abs, n] of nodes()) {
    if (!abs.startsWith(prefix) || abs.slice(prefix.length).includes("/")) continue;
    const name = abs.slice(prefix.length);
    const parentIgnored = isIgnored(abs);
    entries.push({
      name,
      abs,
      kind: n.kind === "dir" ? "dir" : "file",
      size: n.kind === "dir" ? 0 : sizeOf(n),
      mtimeMs: n.mtimeMs,
      hidden: name.startsWith("."),
      ignored: parentIgnored,
    });
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1,
  );
  const limit = Math.min(input.limit ?? 2000, 2000);
  return {
    ok: true,
    dir: dirAbs,
    entries: entries.slice(0, limit),
    total: entries.length,
    truncated: entries.length > limit,
  };
}

function isIgnored(abs: string): boolean {
  return abs.startsWith(`${REPO}/node_modules`);
}

// What `git status` reports for the repo rooted at DEMO_EXPLORER_CWD.
const GIT_CHANGES: Record<string, FsGitBadge> = {
  "docs/peek-scope.md": "A",
  "src/server/index.mjs": "M",
  "src/server/peek.mjs": "M",
};

export function demoFsGitStatus(input: { root: string }): FsGitStatusResult {
  const root = normalize(DEMO_HOME, input.root);
  if (root !== REPO && !root.startsWith(`${REPO}/`)) return { ok: false, reason: "not-git" };
  const rel = root === REPO ? "" : `${root.slice(REPO.length + 1)}/`;
  const changes: Record<string, FsGitBadge> = {};
  for (const [p, badge] of Object.entries(GIT_CHANGES)) {
    if (p.startsWith(rel)) changes[p.slice(rel.length)] = badge;
  }
  return { ok: true, changes };
}

/** Quick open's search of the session folder: relative paths, best match first. */
export function demoFindFiles(query: string, directory: string): string[] {
  const root = normalize(DEMO_HOME, directory);
  const q = query.toLowerCase();
  const hits: Array<{ rel: string; rank: number }> = [];
  for (const [abs, n] of nodes()) {
    if (n.kind !== "file" || !abs.startsWith(`${root}/`) || isIgnored(abs)) continue;
    const rel = abs.slice(root.length + 1);
    const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ rel, rank: at * 1000 + name.length });
  }
  return hits.sort((a, b) => a.rank - b.rank).map((h) => h.rel);
}

// ---------------------------------------------------------------------------
// The viewer's file reads (filePeek's seam)
// ---------------------------------------------------------------------------

const abortable = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });

const refusal = (status: number, reason: FsReason, error: string) =>
  new Response(JSON.stringify({ error, reason }), { status, headers: { "content-type": "application/json" } });

/** The box's /api/peek, answered from the fixture. Same statuses, bodies and headers. */
export async function demoPeekFetch(
  rawPath: string,
  init: { method: "GET" | "HEAD"; headers: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
  const abs = normalize(DEMO_HOME, rawPath);
  const hit = lookup(abs);
  if (!hit.ok) {
    return hit.reason === "missing"
      ? refusal(404, "missing", "not found")
      : refusal(403, hit.reason, "path outside home directory");
  }
  if (hit.node.kind !== "file") return refusal(404, "not-file", "not a file");
  const n = hit.node;
  switch (n.peek.kind) {
    case "refuse":
      return refusal(n.peek.status, n.peek.reason, n.peek.reason === "missing" ? "not found" : "permission denied");
    case "network":
      throw new TypeError("Failed to fetch");
    case "hang":
      return abortable(init.signal);
    case "ok":
      break;
  }
  const ext = abs.includes(".") ? abs.slice(abs.lastIndexOf(".")).toLowerCase() : "";
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "content-length": String(sizeOf(n)),
    "accept-ranges": "bytes",
  };
  if (init.method === "HEAD" || n.size != null) return new Response(null, { status: 200, headers });
  return new Response(bytesOf(n) as BlobPart, { status: 200, headers });
}

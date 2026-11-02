// ===== File-path detection for transcript text =====
//
// Pure (no React). Finds path candidates in prose / inline code / the user's
// bubble; the box decides which of them exist (usePathResolution) and only
// those become links. Spec: docs/superpowers/specs/2026-11-02-file-explorer.md
// §Path links.
//
// Forms: absolute (`/…`), home (`~/…`), relative with at least one `/`
// (`src/a.ts`, `./x.ts`, `../y/z.md`). A bare filename (`AGENTS.md`) counts only
// when it is the WHOLE content of an inline-code span (`findWholePath`).
// Optional line suffix: `:12`, `:12:4`, `:12-30`, `#L12`, `#L12-L30`.
// URLs always win: a path overlapping a URL match is dropped, and trailing
// sentence punctuation is excluded.

import { findLinks, type LinkMatch } from "./linkify";

export type PathMatch = {
  start: number;
  end: number;
  /** The matched text, path plus any line suffix. */
  raw: string;
  /** The path alone, as written (not resolved). */
  path: string;
  /** 1-based, inclusive. */
  line?: number;
  endLine?: number;
};

export type PathRef = { path: string; line?: number; endLine?: number };

const SEG = String.raw`[\p{L}\p{N}_.+@%-]+`;
const SUFFIX = String.raw`(?::(\d+)(?::\d+|-(\d+))?|#L(\d+)(?:-L?(\d+))?)`;
// A token starts at the beginning or after anything that cannot be part of a
// path, so `and/or` is one token and `a//b` / `http://x/y` start nothing mid-way.
const PATH_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.\-/~@$:\\#%+])((?:~/|\.{1,2}/|/)?${SEG}(?:/${SEG})*/?)${SUFFIX}?`,
  "gu",
);
const SUFFIX_END_RE = new RegExp(`${SUFFIX}$`, "u");
const TRAILING_JUNK = /[.\-+@%]+$/;
const HAS_LETTER = /\p{L}/u;
const MAX_PATH_CHARS = 1024;

function lineRange(a?: string, b?: string): { line?: number; endLine?: number } {
  const line = a ? Number(a) : 0;
  if (!(line >= 1)) return {};
  const end = b ? Number(b) : 0;
  return end > line ? { line, endLine: end } : { line };
}

function overlaps(links: LinkMatch[], start: number, end: number): boolean {
  return links.some((l) => start < l.end && end > l.start);
}

export type FindPathsOptions = {
  /** URL matches already computed for `text` (avoids a second scan). */
  links?: LinkMatch[];
};

export function findPaths(text: string, opts: FindPathsOptions = {}): PathMatch[] {
  if (!text || !text.includes("/")) return [];
  const links = opts.links ?? findLinks(text);
  const out: PathMatch[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    const hasSuffix = m[2] !== undefined || m[3] !== undefined || m[4] !== undefined || m[5] !== undefined;
    let path = m[1];
    if (!hasSuffix) path = path.replace(TRAILING_JUNK, "");
    if (!path.includes("/") || !HAS_LETTER.test(path) || path.length > MAX_PATH_CHARS) continue;
    const start = m.index;
    const end = hasSuffix ? m.index + m[0].length : start + path.length;
    if (overlaps(links, start, end)) continue;
    const range = hasSuffix ? lineRange(m[2] ?? m[4], m[3] ?? m[5]) : {};
    out.push({ start, end, raw: text.slice(start, end), path, ...range });
  }
  return out;
}

const BARE_RE = new RegExp(String.raw`^([\p{L}\p{N}_.+@%-]+)${SUFFIX}?$`, "u");
const EXT_RE = /^[\p{L}\p{N}]{1,10}$/u;

/** The whole trimmed span as ONE path (inline code): any form findPaths knows, or a bare filename. */
export function findWholePath(text: string): PathMatch | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lead = text.length - text.trimStart().length;
  const shift = (m: PathMatch): PathMatch => ({ ...m, start: m.start + lead, end: m.end + lead });
  if (findLinks(trimmed, { schemeless: "whole" }).length > 0) return null;
  const found = findPaths(trimmed);
  if (found.length === 1 && found[0].start === 0 && found[0].end === trimmed.length) return shift(found[0]);
  if (found.length > 0 || trimmed.includes("/")) return null;
  const m = BARE_RE.exec(trimmed);
  if (!m) return null;
  const path = m[1];
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1);
  if (dot === -1 || path.endsWith(".") || path.includes("..") || !EXT_RE.test(ext) || !HAS_LETTER.test(ext)) {
    return null;
  }
  return shift({
    start: 0,
    end: trimmed.length,
    raw: trimmed,
    path,
    ...lineRange(m[2] ?? m[4], m[3] ?? m[5]),
  });
}

/** Split `path[:L[:C]|:L-M|#Ln[-Ln]]` back into path + line target (for hrefs that carry a whole match). */
export function parsePathRef(raw: string): PathRef {
  const m = SUFFIX_END_RE.exec(raw);
  if (!m) return { path: raw };
  return { path: raw.slice(0, m.index), ...lineRange(m[1] ?? m[3], m[2] ?? m[4]) };
}

/** `:28` / `:28-34` — the faint line suffix a link shows after the path. */
export function lineSuffix(line?: number, endLine?: number): string {
  if (line == null) return "";
  return endLine != null && endLine > line ? `:${line}-${endLine}` : `:${line}`;
}

/** `p` relative to `cwd` when inside it (for compact display), else as given. */
export function displayPath(p: string, cwd: string): string {
  const dir = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  if (!dir || dir === "/") return p;
  if (p === dir) return ".";
  return p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
}

type ToolInput = Record<string, unknown> | undefined;

const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/**
 * The structured file path of a tool call (Read / Edit / Write / MultiEdit /
 * List, and a single-file apply_patch), taken from the tool INPUT — no text
 * detection. `kind` is only a hint; the box's resolution is authoritative.
 */
export function toolArgPath(
  tool: string,
  state: { input?: ToolInput; metadata?: Record<string, unknown> } | undefined,
): string | null {
  const input = state?.input;
  switch (tool) {
    case "read":
    case "edit":
    case "write":
    case "multiedit":
    case "list":
      return nonEmpty(input?.filePath) ?? nonEmpty(input?.path) ?? null;
    case "apply_patch":
    case "patch": {
      const direct = nonEmpty(input?.filePath) ?? nonEmpty(input?.path);
      if (direct) return direct;
      const files = state?.metadata?.files;
      if (Array.isArray(files) && files.length === 1) {
        const f = files[0] as Record<string, unknown> | string | undefined;
        return typeof f === "string" ? nonEmpty(f) ?? null : nonEmpty(f?.file) ?? nonEmpty(f?.path) ?? null;
      }
      return null;
    }
    default:
      return null;
  }
}

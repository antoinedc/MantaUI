// ===== Clickable links in transcript text =====
//
// ExternalLink is the one anchor for every link in the transcript (markdown
// links and auto-detected ones); Linkified turns plain text into strings +
// ExternalLinks. Detection lives in ./linkify.
//
// FileLink is its sibling for file paths the box has confirmed (spec:
// 2026-11-02-file-explorer.md §Path links, contract E10); PathCandidate is the
// "maybe a link" wrapper that resolves a detected path first. Path detection
// lives in ./pathLinks, resolution in ./usePathResolution.

import { useContext, useMemo, type AnchorHTMLAttributes, type ReactNode } from "react";
import { getMantaPreload } from "./preloadAccess";
import { findLinks, type FindLinksOptions } from "./linkify";
import { findPaths, lineSuffix, type PathMatch } from "./pathLinks";
import { usePathResolution } from "./usePathResolution";
import { ExplorerOwnerContext } from "./explorer/ownerContext";
import { useFileTargetActive } from "./explorer/explorerStore";
import { dispatchOpenFile, type ExplorerOwner } from "./explorer/types";

// Only these schemes become anchors: the href can come from model output, and
// openExternal hands it to the OS. Anything else renders as plain text.
const SAFE_HREF = /^(https?:|mailto:)/i;

export function ExternalLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href || !SAFE_HREF.test(href)) return <>{children}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline"
      style={{ color: "var(--accent-tx)" }}
      {...rest}
      onClick={(e) => {
        // A link inside a clickable header (tool card, command bar) must not
        // also toggle it.
        e.stopPropagation();
        const preload = getMantaPreload();
        if (preload && href) {
          e.preventDefault();
          preload.openExternal(href);
        }
      }}
    >
      {children}
    </a>
  );
}

// The ONE anchor for a CONFIRMED file path. Inside inline code the <code> keeps
// its styling and the link inherits its font; elsewhere pass `mono`.
export function FileLink({
  abs,
  text,
  line,
  endLine,
  kind = "file",
  owner,
  mono = false,
  active: activeProp = false,
}: {
  /** Canonical path the box confirmed. */
  abs: string;
  /** The path as shown (as written in the transcript / relative to the folder). */
  text: string;
  line?: number;
  endLine?: number;
  kind?: "file" | "dir";
  /** Captured where the link RENDERS — never "whichever session is active later". */
  owner: ExplorerOwner;
  mono?: boolean;
  /** Force the active look (the link otherwise derives it from the owner's Explorer). */
  active?: boolean;
}) {
  const shown = useFileTargetActive(owner.sessionId, abs, line, endLine);
  const active = activeProp || shown;
  const suffix = lineSuffix(line, endLine);
  return (
    <a
      href="#"
      data-path={abs}
      className={`manta-file-link -mx-px rounded-xs px-px text-accent-tx underline decoration-dotted decoration-accent/50 underline-offset-[3px] hover:bg-accent-bg hover:decoration-solid${
        mono ? " font-mono text-[0.88em]" : ""
      }${active ? " bg-accent-bg no-underline ring-1 ring-inset ring-accent/40" : ""}`}
      onClick={(e) => {
        // Like ExternalLink: a link inside a clickable header must not toggle it.
        e.preventDefault();
        e.stopPropagation();
        dispatchOpenFile({ abs, line, endLine, owner, kind, expand: e.metaKey || e.ctrlKey });
      }}
    >
      {text}
      {suffix && <span className="text-text-faint">{suffix}</span>}
    </a>
  );
}

// A detected path: a FileLink once the box confirms it, otherwise `fallback`
// exactly as the text rendered before. No owner (CTO pane, routines…) → always
// the fallback.
export function PathCandidate({
  match,
  mono,
  fallback,
}: {
  match: Pick<PathMatch, "path" | "line" | "endLine">;
  mono?: boolean;
  fallback: ReactNode;
}) {
  const owner = useContext(ExplorerOwnerContext);
  const find = usePathResolution(owner, [match.path]);
  const resolved = find(match.path);
  if (!owner || !resolved) return <>{fallback}</>;
  return (
    <FileLink
      abs={resolved.abs}
      text={match.path}
      line={match.line}
      endLine={match.endLine}
      kind={resolved.kind}
      owner={owner}
      mono={mono}
    />
  );
}

// No wrapper element: the parent's typography and whitespace handling apply.
// `paths` opts into path links (the user's own bubble); tool output and the
// like keep URL-only linking.
export function Linkified({
  text,
  schemeless,
  paths = false,
}: {
  text: string;
  schemeless?: FindLinksOptions["schemeless"];
  paths?: boolean;
}) {
  const owner = useContext(ExplorerOwnerContext);
  const withPaths = paths && owner != null;
  const nodes = useMemo(() => {
    const links = findLinks(text, { schemeless });
    const found = withPaths ? findPaths(text, { links }) : [];
    if (links.length === 0 && found.length === 0) return null;
    const parts: Array<
      | { kind: "url"; start: number; end: number; href: string; text: string }
      | { kind: "path"; start: number; end: number; match: PathMatch }
    > = [
      ...links.map((l) => ({ kind: "url" as const, start: l.start, end: l.end, href: l.href, text: l.text })),
      ...found.map((m) => ({ kind: "path" as const, start: m.start, end: m.end, match: m })),
    ].sort((a, b) => a.start - b.start);
    const out: React.ReactNode[] = [];
    let at = 0;
    parts.forEach((p, i) => {
      if (p.start > at) out.push(text.slice(at, p.start));
      out.push(
        p.kind === "url" ? (
          <ExternalLink key={i} href={p.href}>
            {p.text}
          </ExternalLink>
        ) : (
          <PathCandidate key={i} match={p.match} mono fallback={p.match.raw} />
        ),
      );
      at = p.end;
    });
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text, schemeless, withPaths]);
  return <>{nodes ?? text}</>;
}

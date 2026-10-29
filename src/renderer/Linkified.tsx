// ===== Clickable links in transcript text =====
//
// ExternalLink is the one anchor for every link in the transcript (markdown
// links and auto-detected ones); Linkified turns plain text into strings +
// ExternalLinks. Detection lives in ./linkify.

import { useMemo, type AnchorHTMLAttributes } from "react";
import { getMantaPreload } from "./preloadAccess";
import { findLinks, type FindLinksOptions } from "./linkify";

export function ExternalLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
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

// No wrapper element: the parent's typography and whitespace handling apply.
export function Linkified({ text, schemeless }: { text: string; schemeless?: FindLinksOptions["schemeless"] }) {
  const nodes = useMemo(() => {
    const links = findLinks(text, { schemeless });
    if (links.length === 0) return null;
    const out: React.ReactNode[] = [];
    let at = 0;
    links.forEach((l, i) => {
      if (l.start > at) out.push(text.slice(at, l.start));
      out.push(
        <ExternalLink key={i} href={l.href}>
          {l.text}
        </ExternalLink>,
      );
      at = l.end;
    });
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text, schemeless]);
  return <>{nodes ?? text}</>;
}

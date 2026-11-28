// ===== The profile's Overview (profile v5) =====
//
// The agent's instructions as formatted text, through the app's own Markdown renderer (`MarkdownBody`, with heading ids on), and the
// "Sections" index beside them when there are 3 or more sections and the page is wide enough. The index is a sticky column; the
// section being read is marked with `aria-current` — a scroll-spy on the headings (`IntersectionObserver`, the `scrollspy` guide's
// fallback: `scroll-target-group` needs Chromium 140 and the app bundles 126). The section list is read from the rendered headings,
// so the links always match the ids the renderer made. Clicking a section scrolls to it and moves focus there.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "../MarkdownBody";
import { BlockTitle } from "./AgentsParts";
import { stripTitle } from "./agentsView";

type Heading = { id: string; text: string };

/** The `h2`s of a rendered document, each made focusable so a section link can move focus to it. */
function readHeadings(root: HTMLElement | null): Heading[] {
  if (!root) return [];
  const out: Heading[] = [];
  for (const h of root.querySelectorAll<HTMLElement>("h2")) {
    if (!h.id) continue;
    h.tabIndex = -1;
    out.push({ id: h.id, text: (h.textContent ?? "").trim() });
  }
  return out;
}

export function AgentOverview({ name, instructions }: { name: string; instructions: string }) {
  const text = useMemo(() => stripTitle(instructions, name).trim(), [instructions, name]);
  const docRef = useRef<HTMLElement | null>(null);
  const [heads, setHeads] = useState<Heading[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  useLayoutEffect(() => {
    const next = readHeadings(docRef.current);
    setHeads((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.text === next[i].text) ? prev : next));
  }, [text]);

  const showIndex = heads.length >= 3;
  const firstId = heads[0]?.id ?? null;
  useEffect(() => {
    setCurrent((c) => (c && heads.some((h) => h.id === c) ? c : firstId));
  }, [heads, firstId]);

  // scroll-spy: a heading entering the top band of the page becomes current; one leaving it downward gives back to the one before it
  useEffect(() => {
    if (!showIndex || typeof IntersectionObserver === "undefined" || !docRef.current) return;
    const ids = heads.map((h) => h.id);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = ids.indexOf((e.target as HTMLElement).id);
          if (i < 0) continue;
          if (e.isIntersecting) setCurrent(ids[i]);
          else if (e.boundingClientRect.top > 0) setCurrent(ids[Math.max(0, i - 1)]);
        }
      },
      { rootMargin: "0px 0px -75% 0px", threshold: 0 },
    );
    for (const h of docRef.current.querySelectorAll<HTMLElement>("h2[id]")) io.observe(h);
    return () => io.disconnect();
  }, [showIndex, heads]);

  const go = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const el = docRef.current?.querySelector<HTMLElement>(`[id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
    setCurrent(id);
  };

  return (
    <div className="[container-type:inline-size]" data-testid="profile-overview">
      <div className={`grid grid-cols-1 gap-8${showIndex ? " [@container(min-width:760px)]:grid-cols-[minmax(0,1fr)_11rem]" : ""}`}>
        <section aria-labelledby="profile-instructions-title" className="min-w-0">
          <h2 id="profile-instructions-title" className="m-0 mb-3 text-body font-semibold text-text">
            Instructions
          </h2>
          {text ? (
            <article ref={docRef} data-testid="profile-instructions" className="max-w-[68ch] text-body">
              <MarkdownBody text={text} headingIds />
            </article>
          ) : (
            <p className="m-0 text-label text-text-faint">No instructions yet.</p>
          )}
        </section>
        {showIndex && (
          <nav
            aria-label="Sections of the instructions"
            className="sticky top-4 hidden self-start text-meta [@container(min-width:760px)]:block"
          >
            <BlockTitle>Sections</BlockTitle>
            <ol className="m-0 list-none border-l border-border-subtle p-0">
              {heads.map((h) => (
                <li key={h.id}>
                  <a
                    href={`#${h.id}`}
                    onClick={(e) => go(e, h.id)}
                    aria-current={current === h.id ? "true" : undefined}
                    className="-ml-px block border-l-2 border-transparent py-1 pl-3 leading-snug text-text-faint no-underline hover:text-text aria-[current=true]:border-accent aria-[current=true]:text-text focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>
    </div>
  );
}

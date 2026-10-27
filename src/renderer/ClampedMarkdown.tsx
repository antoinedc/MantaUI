// Markdown clamped to a few lines with a Show more / Show less toggle. The
// toggle is offered only when the text actually overflows. Shared by the
// background-result card and the handoff card; never a scroll container.

import { memo, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "./MarkdownBody";

const LINE_HEIGHT_EM = 1.5;

export const ClampedMarkdown = memo(function ClampedMarkdown({
  text,
  lines = 3,
  bodyTestId,
  toggleTestId,
  className = "mt-1",
  bodyClassName = "text-text",
}: {
  text: string;
  /** Collapsed height in lines of meta-size text. */
  lines?: number;
  bodyTestId: string;
  toggleTestId: string;
  className?: string;
  bodyClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);
  const clamped = !expanded;
  return (
    <div className={className}>
      <div
        ref={bodyRef}
        className={`break-words overflow-hidden ${bodyClassName}`}
        style={
          clamped
            ? {
                maxHeight: `${lines * LINE_HEIGHT_EM}em`,
                ...(overflows
                  ? {
                      maskImage: "linear-gradient(to bottom, black 55%, transparent)",
                      WebkitMaskImage: "linear-gradient(to bottom, black 55%, transparent)",
                    }
                  : {}),
              }
            : undefined
        }
        data-testid={bodyTestId}
      >
        {renderMarkdown(text)}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-meta text-accent-tx hover:underline"
          aria-expanded={expanded}
          data-testid={toggleTestId}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
});

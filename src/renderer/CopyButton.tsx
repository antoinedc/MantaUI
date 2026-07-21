// ===== Copy button (chat code/tool blocks) =====
//
// Tiny reusable "copy" affordance for the top-right corner of code/output
// blocks in the chat transcript. Reused by CodeBlock (MarkdownBody.tsx) and
// the plain-output branch of ToolOutput (ToolBodies.tsx) — one component, two
// callers, no duplicated clipboard logic.
//
// Pattern matches PanelCards.tsx `copyUrl` (lines 140–148): `navigator.clipboard`
// with optional-chaining + no-op on failure (clipboard blocked). A click IS a
// user gesture, so the Electron desktop's silent block on `navigator.clipboard`
// (see Terminal.tsx note) does not apply — we follow the established convention.
//
// Positioning is the consumer's responsibility: this component is
// position-agnostic, accepts an arbitrary `className`, and the callers pass
// `absolute top-1 right-1 z-10` (etc.) against a `relative` parent.

import { memo, useEffect, useState } from "react";

export const CopyButton = memo(function CopyButton({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {
            /* clipboard blocked — no-op */
          },
        );
      }}
      title="Copy"
      aria-label="Copy"
      className={
        className ??
        "text-[10px] text-text-faint hover:text-text px-1 rounded"
      }
    >
      {copied ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  );
});

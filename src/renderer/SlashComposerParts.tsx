// ===== Slash-command composer parts (v2-next Stage B) =====
//
// The two pieces the composer shows around a valid slash command (visual
// source: docs/superpowers/specs/2026-10-23-opencode-v2-next/
// bg-commands-mockup.html):
//
//   - SlashHighlight: a mirrored overlay that paints the `/name` token in the
//     primary colour. The textarea STAYS the input (caret, IME, selection,
//     undo, paste, autosize are all untouched); the overlay is aria-hidden,
//     pointer-events:none, and carries the same font / size / line-height /
//     wrapping, so the coloured token lands exactly on the glyphs it covers.
//     Everything outside the token is transparent, and the token's own box is
//     opaque (the composer's card colour under the accent tint) so the
//     textarea's plain glyphs underneath are covered rather than doubled. The
//     token never changes weight or gets horizontal padding — either would
//     shift its width and break the character-for-character alignment.
//   - BackgroundRunBox: the "Run in background" checkbox that slides in under
//     the input while the text is a valid opencode command / skill.

import { forwardRef, memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MOTION_BASE, MOTION_EASE } from "./chatMotion";
import { Checkbox } from "./Checkbox";
import {
  BACKGROUND_HELPER_TEXT,
  BACKGROUND_LOCKED_TITLE,
  overlaySegments,
  type SlashToken,
} from "./backgroundRun";

// The textarea's own metrics (InputArea): font-sans, text-prose, 1.5 line
// height, pre-wrap with break-word wrapping.
const OVERLAY_CLASS =
  "absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words font-sans text-prose text-transparent";

const TOKEN_STYLE: React.CSSProperties = {
  // Opaque card colour first, accent tint on top: covers the textarea glyphs
  // beneath instead of drawing a second copy over them.
  backgroundColor: "rgb(var(--card-rgb))",
  backgroundImage: "linear-gradient(var(--accent-bg), var(--accent-bg))",
  color: "var(--accent-tx)",
  borderRadius: 4,
};

export const SlashHighlight = memo(
  forwardRef<HTMLDivElement, { text: string; token: SlashToken }>(function SlashHighlight(
    { text, token },
    ref,
  ) {
    const segments = overlaySegments(text, token);
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={OVERLAY_CLASS}
        style={{ lineHeight: "1.5" }}
        data-testid="slash-highlight"
      >
        {segments.map((s, i) =>
          s.command ? (
            <span key={i} style={TOKEN_STYLE} data-testid="slash-token">
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        {/* A trailing newline would otherwise leave the overlay one line
            shorter than the textarea and clamp its scroll offset. */}
        {"\u200b"}
      </div>
    );
  }),
);

export function BackgroundRunBox({
  open,
  checked,
  locked,
  onChange,
}: {
  open: boolean;
  checked: boolean;
  locked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="background-run-box"
          data-testid="background-run-box"
          initial={{ height: 0, opacity: 0, overflow: "hidden" }}
          animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
          exit={{ height: 0, opacity: 0, overflow: "hidden" }}
          transition={{ duration: MOTION_BASE, ease: MOTION_EASE }}
        >
          <div className="flex items-center gap-2 text-meta text-text-muted min-w-0">
            <span title={locked ? BACKGROUND_LOCKED_TITLE : undefined} className="shrink-0">
              <Checkbox
                checked={checked}
                onChange={onChange}
                disabled={locked}
                label="Run in background"
              />
            </span>
            {/* Reserved even while unchecked (visibility, not display), so
                ticking the box never changes the composer's height. */}
            <span
              className={"min-w-0 truncate text-text-faint " + (checked ? "visible" : "invisible")}
              data-testid="background-run-helper"
            >
              — {BACKGROUND_HELPER_TEXT}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

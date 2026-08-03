// M527.ToolCard — the tool-call / subagent card chrome primitive (BET-636).
//
// The spec's `.tool` shell plus its header strip `.tool-h`: a bordered card
// (rounded-md) on the raised surface with a header holding the status dot,
// bold tool name, a gap, a truncating muted argument, and a right-aligned
// meta slot (`+38 −4` counts / status word). Optionally the header is a
// disclosure button (subagent/task card) with an `aria-expanded` chevron.
//
// No `className` escape hatch (epic standing decision 3). Off-grid chrome:
// the `9px` header vertical padding, the `11px` meta size, and the `12.5px`
// mono header size.

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { StatusDot } from "./StatusDot";

const SHELL = "rounded-md border border-border-subtle bg-bg-elev overflow-hidden";
const HEADER =
  "flex items-center gap-2 px-3 py-[9px] text-[12.5px] leading-none font-mono text-text-muted";
const NAME = "text-text font-semibold";
const ARG = "text-text-faint min-w-0 truncate";
const META = "ml-auto flex items-center gap-2 text-[11px] text-text-quiet";

export function ToolCard({
  tone,
  name,
  arg,
  meta,
  expanded,
  onToggle,
  children,
}: {
  /**
   * Status of the operation — drives the leading StatusDot. Optional: a card
   * that renders its own status dot in the body (the subagent/task card's
   * collapsed status line) omits it to avoid painting two dots (BET-636).
   */
  tone?: "ok" | "running" | "error" | "idle";
  /** The bold tool name. */
  name: string;
  /** The muted, ellipsis-truncated argument / path. */
  arg?: string;
  /** Optional right-aligned metadata node (e.g. "+38 −4"). */
  meta?: ReactNode;
  /** Expanded state for the disclosure chevron (only meaningful with `onToggle`). */
  expanded?: boolean;
  /** When supplied the header becomes a toggle button with a chevron. */
  onToggle?: () => void;
  /** Optional body — an OutputWell or a diff. */
  children?: ReactNode;
}) {
  const headerChrome = `${HEADER}${onToggle ? " w-full text-left cursor-pointer" : ""}`;
  const chevron = onToggle ? (
    <ChevronDown
      size={12}
      aria-hidden="true"
      className={`shrink-0 transition-transform${expanded ? " rotate-180" : ""}${meta == null ? " ml-auto" : ""}`}
    />
  ) : null;

  const headerInner = (
    <>
      {tone != null && <StatusDot tone={tone} />}
      <span className={NAME}>{name}</span>
      {arg != null && <span className={ARG}>{arg}</span>}
      {meta != null && <span className={META}>{meta}</span>}
      {chevron}
    </>
  );

  return (
    <div className={SHELL}>
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={expanded ?? false} className={headerChrome}>
          {headerInner}
        </button>
      ) : (
        <div className={headerChrome}>{headerInner}</div>
      )}
      {children != null && children}
    </div>
  );
}

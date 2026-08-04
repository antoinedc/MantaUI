// M527.ToolCard — the tool-call / subagent card chrome primitive (BET-636).
//
// The spec's `.tool` shell plus its header strip `.tool-h`: a bordered card
// (rounded-md) on the raised surface with a header holding the status dot,
// bold tool name, a gap, a truncating muted argument, a right-aligned meta
// slot (`+38 −4` counts / status word), and — right of the copy icon — a
// collapse/expand chevron. Card bodies are collapsible: when `onToggle` is
// supplied the name/arg/meta region becomes a disclosure button and a chevron
// appears at the header's far right (immediately after the copy button when
// one is present).
//
// The copy button and the chevron are SIBLINGS of the disclosure button, not
// children of it — a `<button>` cannot legally nest another `<button>`, and a
// nested one is unclickable. The header is therefore always a plain flex
// `<div>`; the clickable toggle region (dot + name + arg + meta) is the inner
// `flex-1` button, and copy + chevron sit beside it on the right.
//
// No `className` escape hatch (epic standing decision 3). Off-grid chrome:
// the `9px` header vertical padding, the `11px` meta size, and the `12.5px`
// mono header size.

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { StatusDot } from "./StatusDot";
import { CopyButton } from "./CopyButton";

const SHELL = "rounded-md border border-border-subtle bg-bg-elev overflow-hidden";
const HEADER =
  "flex items-center gap-2 px-3 py-[9px] text-[12.5px] leading-none font-mono text-text-muted";
const NAME = "text-text font-semibold";
const ARG = "text-text-faint min-w-0 truncate";
const META = "ml-auto flex items-center gap-2 text-[11px] text-text-quiet";
const COPY = "shrink-0 text-text-faint hover:text-text -my-1 p-1 rounded-xs";
// The disclosure region of a collapsible header + the action buttons to its
// right. `flex-1` pushes copy/chevron to the header's far right.
const TOGGLE = "flex items-center gap-2 flex-1 min-w-0 text-left";
const ACTION = "shrink-0 text-text-faint hover:text-text -my-1 p-1 rounded-xs";

export function ToolCard({
  tone,
  name,
  arg,
  meta,
  copyText,
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
  /**
   * When set, the header carries a copy affordance for this text (the card's
   * output / diff) — rendered as a button sitting just LEFT of the collapse
   * chevron. It works whether or not `onToggle` is set (the copy button is a
   * sibling of the disclosure button, never nested inside it).
   */
  copyText?: string;
  /** Expanded state for the disclosure chevron (only meaningful with `onToggle`). */
  expanded?: boolean;
  /** When supplied the header becomes a disclosure (name/arg/meta clickable) with a chevron. */
  onToggle?: () => void;
  /** Optional body — an OutputWell or a diff. */
  children?: ReactNode;
}) {
  const copy = copyText ? <CopyButton text={copyText} className={COPY} /> : null;

  const chevron = onToggle ? (
    <button
      type="button"
      onClick={onToggle}
      aria-label={expanded ? "Collapse" : "Expand"}
      title={expanded ? "Collapse" : "Expand"}
      className={ACTION}
    >
      <ChevronDown
        size={12}
        aria-hidden="true"
        className={`transition-transform${expanded ? " rotate-180" : ""}`}
      />
    </button>
  ) : null;

  const info = (
    <>
      {tone != null && <StatusDot tone={tone} />}
      <span className={NAME}>{name}</span>
      {arg != null && <span className={ARG}>{arg}</span>}
    </>
  );

  const metaSlot = meta != null && <span className={META}>{meta}</span>;

  return (
    <div className={SHELL}>
      <div className={HEADER}>
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded={expanded ?? false} className={TOGGLE}>
            {info}
            {metaSlot}
          </button>
        ) : (
          <>
            {info}
            {metaSlot}
          </>
        )}
        {copy}
        {chevron}
      </div>
      {children != null && children}
    </div>
  );
}

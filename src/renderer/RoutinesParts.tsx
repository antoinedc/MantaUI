// ===== Routines — shared building blocks =====
//
// The small pieces every Routines screen draws the same way: the pane header
// bar, a section head (Eyebrow + count + optional right slot), the accent
// text-link button, the outcome Pill, the routine glyph tile, the live
// clock and the show-more clamp. They compose the existing primitives; nothing here re-implements a
// primitive's chrome.

import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { CalendarClock, Check, ChevronDown, X } from "lucide-react";
import { IconButton } from "./IconButton";
import { INPUT_BASE, LABEL_CLS } from "./Field";
import { Eyebrow } from "./Eyebrow";
import { Pill } from "./Pill";
import { StatusDot } from "./StatusDot";
import { nowMs, useClockTick } from "./clock";
import { routineIcon, type OutcomeView } from "./routinesView";
import type { RoutineIcon } from "../shared/routines";

/** Live `now` — advances every `tickMs`; pinned when the demo clock is pinned. */
export function useNowMs(tickMs = 1000): number {
  useClockTick(tickMs);
  return nowMs();
}

/** The pane's top bar: crumb text on the left, optional right slot. Sits where SessionHeader sits. */
export function RoutinesHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div
      className="manta-routines-header titlebar-drag flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle pl-4 pr-[calc(var(--sp-3)+var(--titlebar-inset-right))]"
    >
      <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-label font-medium text-text">{children}</div>
      {right && <div className="titlebar-no-drag ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

/** A crumb segment that goes back (`Routines` in `Routines / name`). */
export function CrumbLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    // titlebar-no-drag: the header bar is a window drag region, and on macOS a
    // button inside one never receives the click.
    <button type="button" onClick={onClick} className="titlebar-no-drag text-text-faint hover:text-text">
      {children}
    </button>
  );
}

export function CrumbSep() {
  return <span className="text-text-quiet">/</span>;
}

/** The page column — identical to the CTO pane's. */
export function PageColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
      {children}
    </div>
  );
}

/** Eyebrow title + count + optional hint and right slot. */
export function SectionHead({
  title,
  count,
  hint,
  right,
}: {
  title: string;
  count?: number;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      {/* Eyebrow carries its own bottom margin; the negative margin cancels it so the row centres. */}
      <div className="-mb-3">
        <Eyebrow>{title}</Eyebrow>
      </div>
      {count != null && <span className="text-micro font-mono tabular-nums text-text-quiet">{count}</span>}
      {hint && <span className="text-meta text-text-quiet">{hint}</span>}
      {right && <span className="ml-auto flex items-center gap-1">{right}</span>}
    </div>
  );
}

/** The accent text-link button ("Mark all read", "Findings only", "Show older"). */
export function TextLink({ onClick, children, pressed }: { onClick: () => void; children: ReactNode; pressed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className="rounded-sm px-2 py-1 text-meta font-medium text-accent-tx hover:bg-accent-bg"
    >
      {children}
    </button>
  );
}

/** The list container — Card's surface without padding (rows own it). */
export function Box({ hook, children }: { hook?: string; children: ReactNode }) {
  return (
    <div className={`${hook ? `${hook} ` : ""}overflow-hidden rounded-lg border border-border-subtle bg-bg-soft`}>{children}</div>
  );
}

export function OutcomePill({ view }: { view: OutcomeView }) {
  return (
    <Pill tone={view.tone} border={view.border} size="meta">
      {view.dot && <StatusDot tone={view.dot} />}
      {view.label}
    </Pill>
  );
}

/** Per-routine glyph tile: `size="sm"` 32px neutral (lists), `size="lg"` 40px accent (hero). */
export function RoutineGlyph({ icon, size = "sm" }: { icon: RoutineIcon | string; size?: "sm" | "lg" }) {
  const Icon = routineIcon(icon);
  return size === "lg" ? (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-bg text-accent-tx">
      <Icon size={20} aria-hidden />
    </span>
  ) : (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-fill text-text-faint">
      <Icon size={14} aria-hidden />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Modal chrome shared by the editor (R4), the convert modal (R6) and the
// move-to-chat modal (R7).
// ---------------------------------------------------------------------------


export function RoutineModalHeader({ title, onClose, icon }: { title: string; onClose: () => void; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-4">
      {icon ?? <CalendarClock size={16} className="text-accent-tx" aria-hidden />}
      <h3 className="text-title font-semibold text-text">{title}</h3>
      <span className="ml-auto">
        <IconButton icon={<X />} label="Close" onClick={onClose} />
      </span>
    </div>
  );
}

export function RoutineModalBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>;
}

export function RoutineModalFooter({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-elev px-5 py-3">{children}</div>;
}

/** A labelled block of a modal (label in Field's label style, help / error below). */
export function LabelledBlock({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className={LABEL_CLS}>{label}</div>
      {children}
      {error ? <div className="text-meta text-danger">{error}</div> : help ? <div className="text-meta text-text-faint">{help}</div> : null}
    </div>
  );
}

/** A button that looks like a Field and opens a picker (Folder, Model). */
export function PickerButton({
  icon,
  text,
  mono = false,
  onClick,
  label,
  buttonRef,
}: {
  icon?: ReactNode;
  text: string;
  mono?: boolean;
  onClick: () => void;
  label: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      onClick={onClick}
      className={`${INPUT_BASE} flex items-center gap-2 px-4 py-3 text-left ${mono ? "font-mono" : ""}`}
    >
      {icon && <span className="shrink-0 text-text-faint">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden />
    </button>
  );
}

/** The R4 radio card (Allowed-to choices, Which-chat choices). */
export function RadioCard({
  selected,
  title,
  sub,
  onSelect,
}: {
  selected: boolean;
  title: string;
  sub?: string;
  onSelect: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer gap-2 rounded-md border p-3 ${selected ? "border-accent bg-accent-bg" : "border-border bg-bg-soft"}`}
    >
      <span
        className={`mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${selected ? "border-accent-solid" : "border-border-strong"}`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-accent-solid" />}
      </span>
      <span className="min-w-0">
        <span className="block text-label font-semibold text-text">{title}</span>
        {sub && <span className="block text-meta text-text-faint">{sub}</span>}
      </span>
    </div>
  );
}

/** A "what changes" line: green check + sentence. */
export function CheckLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <Check size={14} className="mt-[2px] shrink-0 text-ok" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/**
 * Long text clamped to `lines` lines with a Show more / Show less toggle. The toggle
 * only appears when the text actually overflows the clamp (measured, so short text
 * draws exactly as before). `className` carries the text styling.
 */
export function ShowMore({ lines = 5, className = "", children }: { lines?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);
  return (
    <div>
      <div
        ref={ref}
        className={className}
        style={open ? undefined : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }}
      >
        {children}
      </div>
      {(overflows || open) && (
        <div className="-ml-2 mt-1 font-sans">
          <TextLink onClick={() => setOpen(!open)} pressed={open}>
            {open ? "Show less" : "Show more"}
          </TextLink>
        </div>
      )}
    </div>
  );
}

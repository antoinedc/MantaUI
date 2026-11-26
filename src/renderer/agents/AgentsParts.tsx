// Small building blocks both agent pages draw the same way (contract §Regions → classes): the pane header bar (the Routines
// header recipe), the breadcrumb trail (the `breadcrumbs` guide), a section title with its count, and the page column.

import type { ReactNode } from "react";
import { SidebarRevealButton } from "../SidebarToggle";
import { CrumbLink } from "../RoutinesParts";
import { Pill } from "../Pill";

/** The pane's top bar: title or breadcrumbs on the left, optional right slot. Same chrome as the Routines header. */
export function AgentsHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div
      className="manta-agents-header titlebar-drag flex h-11 shrink-0 items-center gap-2 border-b border-border pr-[calc(var(--sp-3)+var(--titlebar-inset-right))]"
      style={{ paddingLeft: "max(var(--sp-4), var(--pane-inset-x, 0px))" }}
    >
      <SidebarRevealButton />
      <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-label font-medium text-text">{children}</div>
      {right && <div className="titlebar-no-drag ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

/**
 * `Agents / SEO`: ancestors are buttons that go back, the current page is the last item (`aria-current="page"`). The slash is
 * drawn by CSS with an empty alt, so it is not read out. The current page is text, not a link to itself: a control that does
 * nothing is not allowed here.
 */
export function Crumbs({ trail, current }: { trail: ReadonlyArray<{ label: string; onClick: () => void }>; current: string }) {
  return (
    <nav aria-label="Breadcrumbs" className="manta-agents-crumbs min-w-0" data-testid="agents-crumbs">
      <ol className="m-0 flex list-none items-center gap-2 p-0 [&>li+li]:before:mr-2 [&>li+li]:before:text-text-quiet [&>li+li]:before:[content:'/'_/_'']">
        {trail.map((c) => (
          <li key={c.label}>
            <CrumbLink onClick={c.onClick}>{c.label}</CrumbLink>
          </li>
        ))}
        <li className="min-w-0 truncate">
          <span aria-current="page" className="font-semibold text-text">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}

/** A section title (`.h2`): label, and the count in a warn pill when there is one. */
export function SectionTitle({ id, children, count, sub }: { id?: string; children: ReactNode; count?: number; sub?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 id={id} tabIndex={-1} className="m-0 text-label font-semibold text-text outline-none">
        {children}
      </h2>
      {count != null && count > 0 && (
        <span data-testid="needs-count">
          <Pill tone="warn">{count}</Pill>
        </span>
      )}
      {sub && <span className="text-meta font-normal text-text-faint">{sub}</span>}
    </div>
  );
}

/**
 * A section title of the profile's main column: plain ink at body size, never a faint uppercase eyebrow (the title is the
 * content's label, so it must be at least as readable as the content). `aside` is a control that belongs to the title row.
 */
export const BlockTitle = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="mb-2 flex items-baseline gap-2">
    <h3 className="m-0 text-body font-semibold text-text">{children}</h3>
    {aside && <span className="ml-auto">{aside}</span>}
  </div>
);

/** A title inside the details pane: the pane is the quiet side of the page, so its titles are one step down. */
export const PaneTitle = ({ children, sub }: { children: ReactNode; sub?: string }) => (
  <h3 className="m-0 mb-2 text-meta font-semibold text-text-muted">
    {children}
    {sub && <span className="font-normal text-text-faint"> · {sub}</span>}
  </h3>
);

const LINK_FOCUS = "rounded-sm focus-visible:outline-2 focus-visible:outline-accent";

/** A text action in the accent colour ("All 4 →", "Manage seats", "Edit brief"): a button that reads as a link. */
export function LinkButton({ onClick, children, spaced = true, disabled = false }: { onClick: () => void; children: ReactNode; spaced?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${spaced ? "mt-2 " : ""}${LINK_FOCUS} text-meta font-medium text-accent-tx hover:underline disabled:opacity-60`}>
      {children}
    </button>
  );
}

/** A quiet, underlined text action ("Remove seat", "Restore the version before this"): present, but never the loudest thing on the row. */
export function QuietLink({ onClick, children, danger = false, disabled = false }: { onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${LINK_FOCUS} text-meta text-text-faint underline decoration-border underline-offset-2 disabled:opacity-60 ${danger ? "hover:text-danger" : "hover:text-text"}`}
    >
      {children}
    </button>
  );
}

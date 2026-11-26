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

/** The `.blk h3` block title of the profile. */
export const BlockTitle = ({ children }: { children: ReactNode }) => (
  <h3 className="m-0 mb-2 text-meta font-semibold uppercase tracking-wider text-text-faint">{children}</h3>
);

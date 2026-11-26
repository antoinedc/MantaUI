// The profile's two-column page body, the same on every tab (proposal A): the tab's content on the left, one tinted pane on the
// right holding that tab's facts and actions. Below ~720px of the page's OWN width (a container query, not the window's) the pane
// stacks under the content. Titles inside the pane are one step quieter than the content's; groups are separated by hairlines.

import type { ReactNode } from "react";
import { PaneTitle } from "./AgentsParts";

/** The content column and its pane. Every panel is in the page at once (the others `hidden`), so tests and callers scope by panel. */
export function TwoColumn({ main, pane }: { main: ReactNode; pane: ReactNode }) {
  return (
    <div className="[container-type:inline-size]">
      <div data-testid="profile-grid" className="grid grid-cols-1 items-start gap-8 [@container(min-width:720px)]:grid-cols-[minmax(0,1fr)_18rem]">
        <div data-testid="profile-main" className="flex min-w-0 flex-col gap-8">
          {main}
        </div>
        {pane}
      </div>
    </div>
  );
}

/** The tinted pane: one region, `sticky` while the two columns sit side by side; dark adds an inset hairline (the surface step is subtle). */
export function Pane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside
      aria-label={label}
      data-testid="profile-pane"
      className="manta-agents-details min-w-0 rounded-lg bg-bg-elev p-4 top-4 [@container(min-width:720px)]:sticky [[data-theme=dark]_&]:shadow-[inset_0_0_0_1px_var(--border-subtle)]"
    >
      {children}
    </aside>
  );
}

const GROUP = "border-t border-border pt-4 first:border-t-0 first:pt-0 [&:not(:first-child)]:mt-5 [[data-theme=dark]_&]:border-border-subtle";

/** One group of the pane: a hairline above every group but the first. */
export function PaneGroup({ testId, title, sub, children }: { testId?: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className={GROUP}>
      <PaneTitle sub={sub}>{title}</PaneTitle>
      {children}
    </section>
  );
}

/** A pane group whose own content has a title (the memory map draws its own). */
export function PaneBlock({ testId, children }: { testId?: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className={GROUP}>
      {children}
    </section>
  );
}

/** Key / value rows of a pane group: the key quiet, the value in full ink on the right. */
export function PaneFacts({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-label">
      {rows.map(([k, v]) => (
        <FactRow key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-text-faint">{k}</dt>
      <dd className="m-0 min-w-0 break-words text-right text-text">{v}</dd>
    </>
  );
}

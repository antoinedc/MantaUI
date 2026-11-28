// Tab bodies of the profile (profile v5: no side column). A tab's content, then — when it has one — a quiet block under it holding that
// tab's facts and actions (what a seat is, how the library is kept, how rules are learned). Titles inside the block are one step
// quieter than the content's; groups are separated by hairlines. The component keeps its old names so the tabs' own code is untouched.

import type { ReactNode } from "react";
import { PaneTitle } from "./AgentsParts";

/** The content and, under it, the tab's own block. Every panel is in the page at once (the others `hidden`), so tests and callers scope by panel. */
export function TwoColumn({ main, pane }: { main: ReactNode; pane: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <div data-testid="profile-main" className="flex min-w-0 flex-col gap-8">
        {main}
      </div>
      {pane}
    </div>
  );
}

/** The tab's own block: one region under the content, set off by a hairline (never a side column, never tinted). */
export function Pane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside aria-label={label} data-testid="profile-pane" className="manta-agents-details min-w-0 border-t border-border-subtle pt-4">
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

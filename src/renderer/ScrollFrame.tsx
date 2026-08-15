import type { ReactNode } from "react";

// ScrollFrame.tsx — the shared "capped-height list" scroll treatment.
//
// A flex column capped at `maxHeight` whose BODY scrolls while `header` and
// `footer` stay pinned. Extracted so the clone picker (CloneFromGitHub) and
// the "New workspace" repo-setup list (NewSessionScreen) share ONE layout
// instead of each hand-rolling `flex-1 min-h-0 overflow-y-auto` inside an
// ad-hoc `max-h-*`.
//
// This is what keeps the action button reachable no matter how long the list
// gets: the body takes the leftover space and scrolls, while header/footer
// never move — so on a machine with dozens of repos, the search/status stays
// on top and "Set up N workspace(s)" / "Clone N selected" stays in view.
//
// Without the `max-height` cap the body has nothing to shrink against and
// `overflow-y-auto` silently does nothing, so the list just grows and pushes
// the footer off-screen (the bug BET-944 fixed for the clone picker, and
// which this component generalises to every bounded list).

export function ScrollFrame({
  header,
  children,
  footer,
  className = "",
  bodyClassName = "",
  maxHeight = "max-h-[70vh]",
}: {
  /** Pinned above the scrolled body (e.g. a search field or a header). */
  header?: ReactNode;
  /** The scrollable middle — the list rows. */
  children: ReactNode;
  /** Pinned below the scrolled body (e.g. the action buttons). */
  footer?: ReactNode;
  /** Extra classes on the outer column (padding, borders, …). */
  className?: string;
  /** Extra classes on the scrolled body (margin/spacing relative to header/footer). */
  bodyClassName?: string;
  /** Height cap for the column. Pass "max-h-none" to disable. */
  maxHeight?: string;
}) {
  return (
    <div className={`flex flex-col ${maxHeight} ${className}`}>
      {header != null && <div className="shrink-0">{header}</div>}
      <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>
      {footer != null && <div className="shrink-0">{footer}</div>}
    </div>
  );
}

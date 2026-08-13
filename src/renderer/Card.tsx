// M527.Card — the card chrome primitive (BET-531, stage 2).
//
// Owns the ONE shared card chrome with NO `className` escape hatch (epic
// standing decision 3): a caller cannot shear the surface / edge / radius /
// padding, so the whole card library can only drift if Card itself is
// retuned. Renders an optional `header` slot, a body (`children`) and an
// optional action footer (`actions`) with the documented intra-card rhythm
// (header→body sp-3, body→actions sp-4). A `danger` variant re-faces the
// surface and edge.
//
// Consolidation targets land here without a visual change: AskCardShell's
// chrome (Cards.tsx) and GroupCard's chrome (Settings.tsx) both render
// through this primitive and keep their own domain content. RetryCard /
// CompactionCard / the transcript stay out of the first pass (BET-531).

import type { ReactNode } from "react";

const CARD_CHROME = "rounded-lg border border-border bg-bg-soft px-4 py-3";
const CARD_DANGER_CHROME = "rounded-lg border border-danger bg-danger-bg px-4 py-3";
const CARD_WARN_CHROME = "rounded-lg border border-warn bg-warn-bg px-4 py-3";

export function Card({
  danger = false,
  warn = false,
  elevated = false,
  header,
  children,
  actions,
}: {
  danger?: boolean;
  /**
   * Warn re-face (border-warn / bg-warn-bg) for a state that needs the user's
   * attention but isn't a failure — e.g. BET-791's blocked card. Mirrors the
   * danger variant exactly; mutually exclusive with `danger`.
   */
  warn?: boolean;
  /**
   * Add the `--shadow-md` floating lift. Opt-in (default false) so the shared
   * primitive's existing adopters (GroupCard in Settings) stay flat; only the
   * ask cards, which float over the transcript, pass `elevated`.
   */
  elevated?: boolean;
  header?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const hasHeader = header !== undefined;
  const hasBody = children !== undefined;
  const base = danger ? CARD_DANGER_CHROME : warn ? CARD_WARN_CHROME : CARD_CHROME;
  return (
    <div className={elevated ? `${base} shadow-md` : base}>
      {hasHeader && <div className="flex items-start gap-3">{header}</div>}
      {hasBody && (hasHeader ? <div className="mt-3">{children}</div> : children)}
      {actions !== undefined && (
        <div className={"flex items-center gap-2" + (hasHeader || hasBody ? " mt-4" : "")}>
          {actions}
        </div>
      )}
    </div>
  );
}

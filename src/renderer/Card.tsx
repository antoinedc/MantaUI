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

export function Card({
  danger = false,
  header,
  children,
  actions,
}: {
  danger?: boolean;
  header?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const hasHeader = header !== undefined;
  const hasBody = children !== undefined;
  return (
    <div className={danger ? CARD_DANGER_CHROME : CARD_CHROME}>
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

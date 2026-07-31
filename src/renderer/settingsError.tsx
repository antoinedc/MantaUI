// BET-419 §D — error presentation primitive. The spec: "Route every failure
// through the toast primitive with human copy. Keep the raw message behind a
// 'Details' disclosure, never as the headline."
//
// `errorDisclosure` returns a ReactNode suitable for a Toast `message` (or an
// inline `role="alert"` body): a human headline plus a collapsible `<details>`
// carrying the raw underlying message. Used by both desktop Settings.tsx and
// mobile MobileSettings.tsx (and by settingsApply's apply-error toast).

import type { ReactNode } from "react";

export function errorDisclosure(headline: string, raw: unknown): ReactNode {
  const rawText = raw instanceof Error ? raw.message : String(raw ?? "");
  return (
    <span className="flex flex-col gap-1">
      <span>{headline}</span>
      {rawText && (
        <details>
          <summary className="text-text-faint cursor-pointer text-meta">Details</summary>
          <span className="block break-words text-meta text-text-faint">{rawText}</span>
        </details>
      )}
    </span>
  );
}

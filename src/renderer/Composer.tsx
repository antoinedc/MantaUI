// ===== Composer =====
//
// Extracted from ChatPanel.tsx (BET-63). The bottom composer cluster: the
// pending-attachment chip strip, the @-mention / command typeahead popup, and
// the input row itself (textarea + footer with model picker, context bar,
// voice mic, and the ⏰/🔑/🪝 toolbar). Purely presentational — it owns no
// state; ChatPanel passes the input value, the attachment/typeahead data, and
// every callback (submit / abort / voice / typeahead nav / history) in.
//
// The presentational leaves (AttachmentStrip, TypeaheadPopup, InputArea) were
// already extracted in M0.5; this component is the container-shaped wrapper
// that assembles them into "the composer" — the named unit the decomposition
// plan calls for — so ChatPanel's render body no longer inlines the three of
// them plus their gating conditions.
//
// The InputArea prop surface is large (~40 fields) and its type is declared
// inline in InputArea.tsx, so rather than duplicate it we accept exactly
// `InputAreaProps` (derived from the component's own parameter type) for that
// slice and add the attachment/typeahead fields alongside. This keeps the
// contract in one place — change InputArea's props and Composer follows.

import { AttachmentStrip, InputArea, TypeaheadPopup } from "./InputArea";
import type { Attachment, TypeaheadRow, TypeaheadState } from "./chatShared";

// The InputArea props, sourced from the component itself so there's a single
// source of truth for that surface.
type InputAreaProps = Parameters<typeof InputArea>[0];

export type ComposerProps = InputAreaProps & {
  // Attachment chips strip — rendered only when something is pending.
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  // Typeahead popup state + the resolved rows to render.
  typeahead: TypeaheadState | null;
  typeaheadRows: TypeaheadRow[];
  onTypeaheadSelect: (row: TypeaheadRow) => void;
  onTypeaheadHover: (idx: number) => void;
};

export function Composer({
  attachments,
  onRemoveAttachment,
  typeahead,
  typeaheadRows,
  onTypeaheadSelect,
  onTypeaheadHover,
  ...inputAreaProps
}: ComposerProps) {
  return (
    <>
      {/* Attachment chips strip — only when something pending. */}
      {attachments.length > 0 && (
        <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />
      )}

      {/* Typeahead popup — shown the moment typeahead state is set, even */}
      {/* if the result list is still loading. Empty rows render a small */}
      {/* "Searching…" placeholder so the user sees instant feedback. */}
      {typeahead && (
        <TypeaheadPopup
          rows={typeaheadRows}
          selectedIdx={Math.min(
            typeahead.selectedIdx,
            Math.max(0, typeaheadRows.length - 1),
          )}
          onSelect={onTypeaheadSelect}
          onHover={onTypeaheadHover}
          emptyHint={
            typeahead.mode === "file"
              ? "Searching…"
              : typeahead.mode === "agent"
                ? "No matching agents"
                : "No matching commands"
          }
        />
      )}

      <InputArea {...inputAreaProps} />
    </>
  );
}

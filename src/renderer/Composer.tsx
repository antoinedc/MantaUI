// ===== Composer =====
//
// Extracted from ChatPanel.tsx (BET-63). The bottom composer cluster: the
// @-mention / command typeahead popup and the input row itself (textarea +
// footer with model picker, context bar, voice mic, and the ⏰/🔑/🪝 toolbar).
// Purely presentational — it owns no state; ChatPanel passes the input value,
// the attachment/typeahead data, and every callback (submit / abort / voice /
// typeahead nav / history) in.
//
// The presentational leaves (AttachmentStrip, TypeaheadPopup, InputArea) were
// already extracted in M0.5; this component is the container-shaped wrapper
// that assembles them into "the composer" — the named unit the decomposition
// plan calls for — so ChatPanel's render body no longer inlines them plus
// their gating conditions.
//
// Attachment chips render INSIDE the InputArea box (BET-416 §B), so they are
// threaded straight through via InputAreaProps; Composer no longer renders an
// AttachmentStrip sibling above the box. The TypeaheadPopup still floats
// ABOVE the box (it anchors to the box's top edge).
//
// The InputArea prop surface is large (~40 fields) and its type is declared
// inline in InputArea.tsx, so rather than duplicate it we accept exactly
// `InputAreaProps` (derived from the component's own parameter type) for that
// slice and add the typeahead fields alongside. This keeps the contract in
// one place — change InputArea's props and Composer follows.

import { InputArea, TypeaheadPopup } from "./InputArea";
import type { TypeaheadRow, TypeaheadState } from "./chatShared";

// The InputArea props, sourced from the component itself so there's a single
// source of truth for that surface.
type InputAreaProps = Parameters<typeof InputArea>[0];

export type ComposerProps = InputAreaProps & {
  // Typeahead popup state + the resolved rows to render.
  typeahead: TypeaheadState | null;
  typeaheadRows: TypeaheadRow[];
  onTypeaheadSelect: (row: TypeaheadRow) => void;
  onTypeaheadHover: (idx: number) => void;
  // True while the canonical transcript is being refetched in the background
  // (warm-stale reopen). Drives the ambient loading animation on the composer's
  // top divider. Threaded straight through to InputArea.
  refreshing: boolean;
};

export function Composer({
  typeahead,
  typeaheadRows,
  onTypeaheadSelect,
  onTypeaheadHover,
  ...inputAreaProps
}: ComposerProps) {
  return (
    <>
      {/* Typeahead popup — shown the moment typeahead state is set, even */}
      {/* if the result list is still loading. Empty rows render a small */}
      {/* "Searching…" placeholder so the user sees instant feedback. Floats */}
      {/* above the composer box (anchors to its top edge, BET-416 §C). */}
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

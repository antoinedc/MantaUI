// inlineEmbed.tsx — the shared reserved-box pieces for the two inline embed
// renderers (BET-1325).
//
// MediaBody (images/video, BET-1148) and WidgetBody (sandboxed HTML widgets,
// BET-1325) both render an artifact inside a ToolCard's OutputWell and both
// must RESERVE the artifact's final aspect box up front so the transcript's
// pin-to-bottom logic never sees a height change under the reader. The
// reserved-box style, the loading/tile class and the degraded placeholder are
// THE SAME in both, so they are defined here once — the two body files are
// then free to differ only in what goes inside the well (an <img>/<video> vs
// a sandboxed <iframe>). A reviewer diffing them sees exactly that.
//
// Everything here is pure/presentational; the data model for each embed lives
// in chatUtils.ts alongside `resolveMediaAspect`, which is the single source
// of the reserved box's width÷height.

import type { CSSProperties } from "react";
import { resolveMediaAspect } from "./chatUtils";

/** The dimension trio every embed meta carries (the "reserve the final box"
 *  inputs). Structurally a subset of MediaMeta and WidgetMeta. */
export type EmbedDims = {
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
};

// The reserved box is capped at the --inline-max-w reading-width token so a
// huge aspect never opens at full column width; every state (pending / ready /
// degraded) renders inside the SAME box so swap-in or downgrade never changes
// its size — the pin-to-bottom logic thus never sees a height change.
export function boxStyle(dims: EmbedDims): CSSProperties {
  return { aspectRatio: `${resolveMediaAspect(dims)}`, maxWidth: "var(--inline-max-w)" };
}

// The loading/tile class shared by both renderers' pending + loading states:
// an inset, bordered box that centers its spinner.
export const TILE_CLS =
  "rounded-md border border-border-subtle bg-inset flex items-center justify-center overflow-hidden relative";

// The shared degraded placeholder: the reserved box with the warning label
// centered. `label` is supplied by each renderer so the copy stays
// noun-specific while the box itself is defined exactly once.
// `data-media-box` is the reserved-box test hook MediaBody's four-state
// invariant pins on (see MediaBody.test.tsx): the SAME attribute on every
// state so the transcript's pin-to-bottom never sees a height change. It stays
// on the shared box so WidgetBody inherits the same invariant out of the box.
export function DegradedBox({ label, dims }: { label: string; dims: EmbedDims }) {
  return (
    <div className="w-full" style={boxStyle(dims)} data-media-box data-degraded>
      <div className="h-full w-full rounded-md border border-border-subtle bg-inset grid place-items-center text-label text-text-muted">
        <span>⚠ {label}</span>
      </div>
    </div>
  );
}

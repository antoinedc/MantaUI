// WidgetBody.tsx — the single inline-widget renderer (BET-1325).
//
// The design contract (docs/screens/widgets/mockup.html) states the rule this
// whole issue depends on: a widget card is NOT a new component. It renders as
// the EXISTING `ToolCard` shell with an `OutputWell variant="attached"` body —
// the identical structure MediaBody uses for images and video. The only new
// thing inside the well is a sandboxed <iframe> instead of an <img>/<video>,
// and the four lifecycle states (pending / ready / failed / expired) that the
// meta slot names.
//
// Security (locked, do not revisit — see the issue's "Do not touch" contract):
//   - the iframe is `sandbox="allow-scripts"` and nothing more. NEVER add
//     `allow-same-origin` (with allow-scripts it is a documented sandbox
//     escape), nor allow-popups/modals/forms/top-navigation/downloads — each
//     hands back something the design deliberately withholds.
//   - `src`, NEVER `srcdoc`: a srcdoc document inherits the embedding page's
//     CSP, so the renderer's `script-src 'self'` would silently block every
//     inline script in the widget. The URL from the bus event is served by the
//     box with its OWN CSP header, which is the policy that must apply.
//   - `sandboxed · no network` is the enforced policy, rendered in ToolCard's
//     meta slot — the one band of the card the widget provably cannot paint
//     into. It is always present; never conditional, hover-only, or a tooltip.
//   - the ONLY header action is ToolCard's own collapse chevron. There is no
//     expand button on desktop.
//
// The load-bearing layout invariant mirrors MediaBody: the widget RESERVES its
// final aspect box (the same width/height/aspectRatio fields the media kind
// carries, resolved by chatUtils' `resolveMediaAspect`) and every state
// renders inside that same box, so the transcript's pin-to-bottom logic never
// sees a height change. The reserved-box style, the loading tile class and the
// degraded placeholder are shared with MediaBody from ./inlineEmbed — this
// file differs from MediaBody only in what goes inside the well.

import { memo, useState } from "react";
import { Loader2 } from "lucide-react";
import { ToolCard } from "./ToolCard";
import { OutputWell } from "./OutputWell";
import { boxStyle, DegradedBox, TILE_CLS } from "./inlineEmbed";
import { type WidgetEntry } from "./chatUtils";

function WidgetContent({ entry }: { entry: WidgetEntry }) {
  const dims = entry.meta;
  if (entry.state === "ready" && entry.meta.url) {
    return (
      <div className="w-full" style={boxStyle(dims)} data-media-box>
        <iframe
          src={entry.meta.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          title={entry.meta.title ?? "Widget"}
          style={{ display: "block", width: "100%", height: "100%", border: 0 }}
        />
      </div>
    );
  }
  if (entry.state === "failed" || entry.state === "expired") {
    const label =
      entry.state === "expired" ? "This widget expired" : "The widget failed to load";
    return <DegradedBox label={label} dims={dims} />;
  }
  // pending — the reserved box with a skeleton, exactly like MediaBody's.
  return (
    <div className={TILE_CLS} style={boxStyle(dims)} data-media-box>
      <Loader2 className="animate-spin text-text-faint" size={18} aria-hidden="true" />
    </div>
  );
}

/**
 * The single widget renderer. Renders the full card — a ToolCard shell,
 * expanded by default, with the sandboxed widget body on the inset surface.
 * Memoized (the store keeps a stable per-message entry reference; a typing
 * keystroke re-renders the ChatPanel but must not re-render this leaf or
 * reload its iframe).
 */
export const WidgetBody = memo(function WidgetBody({ entry }: { entry: WidgetEntry }) {
  const [expanded, setExpanded] = useState(true);
  const { meta, state } = entry;
  const degraded = state === "failed" || state === "expired";

  return (
    <ToolCard
      tone={degraded ? "error" : "ok"}
      name="Widget"
      arg={meta.title ?? undefined}
      meta={<span>sandboxed · no network</span>}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      {expanded && (
        <OutputWell variant="attached">
          <WidgetContent entry={entry} />
        </OutputWell>
      )}
    </ToolCard>
  );
});

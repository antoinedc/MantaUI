// V2 twin of docs/opencode-tools/widget.ts → widget_show. Thin registrar over
// POST /api/widgets. The declared width/height is a HARD constraint (see the
// description — it is load-bearing for how the model authors the widget).

import { call } from "../lib/server.ts";
import { input, num, posInt, posNum, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "widget_show",
    description: [
      "Store and display an inline widget in the chat. You author a FULL, ",
      "self-contained standalone HTML document (a single <html> document with ",
      "everything it needs inline — CSS, JS, chart libraries all embedded, ",
      "because the widget has NO network access and cannot fetch anything). ",
      "YOU ARE DESIGNING A FIXED-SIZE SURFACE — a card, not a web page. The ",
      "box you declare is a HARD CONSTRAINT: the host reserves exactly those ",
      "pixels and NEVER measures your HTML or resizes to fit it. Content taller ",
      "than the box is clipped or scrolls inside it; content shorter leaves dead ",
      "space. Decide the box first, then design to fit it: give the document ",
      "html,body{height:100%;overflow:hidden} and a flex column with exactly one ",
      "region at flex:1 1 auto to absorb slack. The content height must be a ",
      "SINGLE number — it must not change with state (reserve space with ",
      "visibility:hidden, never display:none) nor with width (chrome must be ",
      "nowrap with ellipsis or horizontal scroll, never wrapping). If the height ",
      "varies, no declared box can be correct. The widget runs sandboxed in an ",
      "opaque origin with no network (connect-src 'none') and no same-origin, so ",
      "it can never read the user's box token or exfiltrate data — keep all ",
      "rendering logic inside the authored HTML. A widget_show call returns ",
      "promptly; the widget is stored on the box (default 24h TTL, or ",
      "ttlHours:0 for no expiry).",
    ].join(" "),
    input: input(
      {
        html: str(
          "The full standalone HTML document for the widget (its own <html> " +
            "document). Everything must be inline — CSS in <style>, JS in " +
            "<script>, and any chart/library code embedded directly, because " +
            "the widget has no network access and nothing external can be " +
            "fetched or loaded.",
        ),
        title: str("Optional short label for the widget."),
        width: posInt(
          "Width in px of the reserved box. A HARD constraint, not a hint — the host reserves exactly this and never measures your HTML.",
        ),
        height: posInt(
          "Height in px of the reserved box. A HARD constraint, not a hint: content taller than this is clipped or scrolls, content shorter leaves dead space. Measure the document's real height rather than estimating it.",
        ),
        aspectRatio: posNum(
          "Aspect ratio (width/height) for when exact px are unknown. Same hard-constraint semantics as width/height — the host never measures your HTML.",
        ),
        ttlHours: num("Hours until the widget expires (default 24). Set to 0 to disable expiry."),
      },
      ["title", "width", "height", "aspectRatio", "ttlHours"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/widgets", {
        html: args.html,
        title: args.title,
        width: args.width,
        height: args.height,
        aspectRatio: args.aspectRatio,
        ttlHours: args.ttlHours,
        sessionID: context.sessionID,
        messageID: context.messageID,
      });
      return `Widget registered at ${result.url}.`;
    },
  },
];

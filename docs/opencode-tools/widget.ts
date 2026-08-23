// manta-native `widget_show` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/widget.ts ~/.config/opencode/tools/widget.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It validates the request and POSTs it to
// manta-server (127.0.0.1:8787, same box — no SSH hop), which stores the HTML
// under ~/.manta/widgets/<id>/ and serves it from /widgets/<id> under the
// box's own hostname, then announces it to the clients on the bus. The tool
// does NOT sleep, poll, or do any work — execute() returns promptly.
//
// See docs/manta-tools-scheduler.md for the general "manta tools" pattern.

import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one tiny
// local file) so a token rotation never requires an opencode-serve restart.
// MANTA_BOX_TOKEN env overrides for tests/dev.
function boxToken(): string | null {
  const fromEnv = process.env.MANTA_BOX_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8");
    const tok = JSON.parse(raw)?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null; // no store yet (auth disabled / first run) → send no header
  }
}

function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  const tok = boxToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  return headers;
}

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MANTA_SERVER}${path}`, {
    method,
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `manta-server ${res.status}`);
  }
  return json;
}

export const widget_show = tool({
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
  args: {
    html: z
      .string()
      .describe(
        "The full standalone HTML document for the widget (its own <html> " +
          "document). Everything must be inline — CSS in <style>, JS in " +
          "<script>, and any chart/library code embedded directly, because " +
          "the widget has no network access and nothing external can be " +
          "fetched or loaded.",
      ),
    title: z.string().optional().describe("Optional short label for the widget."),
    width: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Width in px of the reserved box. A HARD constraint, not a hint — the host reserves exactly this and never measures your HTML.",
      ),
    height: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Height in px of the reserved box. A HARD constraint, not a hint: content taller than this is clipped or scrolls, content shorter leaves dead space. Measure the document's real height rather than estimating it.",
      ),
    aspectRatio: z
      .number()
      .positive()
      .optional()
      .describe(
        "Aspect ratio (width/height) for when exact px are unknown. Same hard-constraint semantics as width/height — the host never measures your HTML.",
      ),
    ttlHours: z
      .number()
      .optional()
      .describe(
        "Hours until the widget expires (default 24). Set to 0 to disable expiry.",
      ),
  },
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
});

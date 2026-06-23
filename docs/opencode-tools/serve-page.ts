// bui-native `serve_page` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs bui-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/serve-page.ts ~/.config/opencode/tools/serve-page.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It validates the request and POSTs it to
// bui-server (127.0.0.1:8787, same box — no SSH hop), which copies the page
// into a stable directory and serves it via an in-process HTTP server. Caddy
// reverse-proxies *.bui.antoinedc.com to this server. The tool does NOT sleep
// or run the page itself — execute() must return promptly.
//
// See docs/bui-tools-scheduler.md for the general "bui tools" pattern.

import { tool } from "@opencode-ai/plugin";

const BUI_SERVER = process.env.BUI_SERVER_URL || "http://127.0.0.1:8787";

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BUI_SERVER}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
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
    throw new Error(json?.error || `bui-server ${res.status}`);
  }
  return json;
}

export const serve_page = tool({
  description: [
    "Host a standalone HTML webpage publicly under *.bui.antoinedc.com.",
    "Use when you generate a web page (design preview, demo, mockup, interactive",
    "prototype) and want it accessible from anywhere — especially from the",
    "machine where the bui UI is running. The page is served at",
    "https://<subdomain>.bui.antoinedc.com and auto-expires after 24h by",
    "default (configurable via ttlHours). To update a page, call this tool",
    "again with the same subdomain and a new file path.",
  ].join(" "),
  args: {
    subdomain: z
      .string()
      .describe(
        "Subdomain for the page (e.g. 'preview', 'my-design'). " +
          "Must be 1-63 lowercase alphanumeric characters or hyphens, no " +
          "leading/trailing hyphens. The page will be served at " +
          "https://<subdomain>.bui.antoinedc.com",
      ),
    filePath: z
      .string()
      .describe(
        "Absolute path to the HTML file to serve (e.g. " +
          "'/tmp/preview/index.html'). The file will be copied into a " +
          "stable directory so it survives /tmp cleanup.",
      ),
    ttlHours: z
      .number()
      .optional()
      .describe(
        "Hours until the page auto-expires (default 24). " +
          "Set to a higher value for longer-lived pages, or 0 to disable expiry.",
      ),
  },
  async execute(args, context) {
    const result = await call("POST", "/api/serve-page", {
      subdomain: args.subdomain,
      filePath: args.filePath,
      ttlHours: args.ttlHours,
      sessionID: context.sessionID,
    });
    const ttl = args.ttlHours != null
      ? args.ttlHours === 0
        ? "no expiry"
        : `${args.ttlHours}h`
      : "24h";
    return `Page served at ${result.url} (expires in ${ttl}).`;
  },
});

export const stop_page = tool({
  description:
    "Stop serving a hosted webpage. Use when the user asks to take down a page, " +
    "or when a preview is no longer needed. Takes the subdomain that was used " +
    "when the page was created.",
  args: {
    subdomain: z
      .string()
      .describe("The subdomain of the page to stop (e.g. 'preview')."),
  },
  async execute(args) {
    const result = await call(
      "DELETE",
      `/api/serve-page?subdomain=${encodeURIComponent(args.subdomain)}`,
    );
    return result.deleted
      ? `Page ${args.subdomain}.bui.antoinedc.com has been taken down.`
      : `No page found for subdomain "${args.subdomain}".`;
  },
});

export const list_pages = tool({
  description:
    "List all currently hosted web pages (subdomain, URL, expiry). " +
    "Use when the user asks what pages are being served.",
  args: {},
  async execute() {
    const result = await call("GET", "/api/serve-page");
    const pages = result.pages ?? [];
    if (pages.length === 0) return "No pages are currently being served.";
    return pages
      .map((p: any) => {
        const exp = p.expiresAt
          ? ` (expires ${new Date(p.expiresAt).toISOString()})`
          : " (no expiry)";
        return `• ${p.url}${exp}`;
      })
      .join("\n");
  },
});

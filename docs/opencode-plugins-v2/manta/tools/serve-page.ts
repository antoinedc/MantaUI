// V2 twin of docs/opencode-tools/serve-page.ts → serve_page / stop_page /
// list_pages. manta-server copies the page into a stable directory and serves
// it from /pages/<subdomain> under the box's own hostname.

import { call } from "../lib/server.ts";
import { input, noInput, num, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "serve_page",
    description: [
      "Host a standalone HTML webpage on the box's own URL and return it.",
      "Use when you generate a web page (design preview, demo, mockup,",
      "interactive prototype) and want it accessible from anywhere —",
      "especially from the machine where the manta UI is running. The returned",
      "URL may be a public `https://` hostname OR a private tailnet `http://`",
      "address depending on how the box is reached — echo `result.url`",
      "verbatim, NEVER construct one yourself. A tailnet URL is only reachable",
      "from inside the user's tailnet (if the link doesn't open, that is the",
      "likely reason — not a bug to retry). If the box has neither a public",
      "hostname nor a tailnet address, `serve_page` returns a clear error",
      "instead of a URL — relay it to the user. The page auto-expires after",
      "24h by default (configurable via ttlHours). To update a page, call this",
      "tool again with the same subdomain and a new file path.",
    ].join(" "),
    input: input(
      {
        subdomain: str(
          "Subdomain for the page (e.g. 'preview', 'my-design'). " +
            "Must be 1-63 lowercase alphanumeric characters or hyphens, no " +
            "leading/trailing hyphens — it becomes a single URL path segment " +
            "under /pages/, so no dots, no slashes.",
        ),
        filePath: str(
          "Absolute path to the HTML file to serve (e.g. " +
            "'/tmp/preview/index.html'). The file will be copied into a " +
            "stable directory so it survives /tmp cleanup.",
        ),
        ttlHours: num(
          "Hours until the page auto-expires (default 24). " +
            "Set to a higher value for longer-lived pages, or 0 to disable expiry.",
        ),
      },
      ["ttlHours"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/serve-page", {
        subdomain: args.subdomain,
        filePath: args.filePath,
        ttlHours: args.ttlHours,
        sessionID: context.sessionID,
      });
      const ttl =
        args.ttlHours != null ? (args.ttlHours === 0 ? "no expiry" : `${args.ttlHours}h`) : "24h";
      return `Page served at ${result.url} (expires in ${ttl}).`;
    },
  },
  {
    name: "stop_page",
    description:
      "Stop serving a hosted webpage. Use when the user asks to take down a page, " +
      "or when a preview is no longer needed. Takes the subdomain that was used " +
      "when the page was created.",
    input: input({ subdomain: str("The subdomain of the page to stop (e.g. 'preview').") }),
    async execute(args) {
      const result = await call(
        "DELETE",
        `/api/serve-page?subdomain=${encodeURIComponent(args.subdomain)}`,
      );
      return result.deleted
        ? `Page "${args.subdomain}" has been taken down.`
        : `No page found for subdomain "${args.subdomain}".`;
    },
  },
  {
    name: "list_pages",
    description:
      "List all currently hosted web pages (subdomain, URL, expiry). " +
      "Use when the user asks what pages are being served.",
    input: noInput(),
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
  },
];

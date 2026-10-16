// V2 twin of docs/opencode-tools/plan-render.ts → plan_render. Thin registrar
// over POST /api/plan-render (manta-server renders + publishes the plan page).

import { call } from "../lib/server.ts";
import { input, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "plan_render",
    description: [
      "Publish the single-HTML plan bundle the plan agent authored: given the",
      "path to the plan HTML file, render it into a standalone plan page and",
      "return its public URL. The path must be inside the session's own",
      "directory (it is resolved and confined there). Call this AFTER writing",
      "the authored plan HTML bundle; the returned URL is the shareable plan",
      "page. Then invoke the plan_exit tool separately afterwards to complete",
      "the plan.",
    ].join(" "),
    input: input({
      file: str(
        "Absolute (or session-relative) path to the authored plan HTML bundle. " +
          "Must resolve to a path inside the session directory.",
      ),
    }),
    async execute(args, context) {
      const result = await call("POST", "/api/plan-render", {
        sessionID: context.sessionID,
        file: args.file,
      });
      return `Plan page published at ${result.url}`;
    },
  },
];

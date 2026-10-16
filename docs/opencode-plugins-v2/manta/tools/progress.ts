// V2 twin of docs/opencode-tools/progress.ts → progress_report.
//
// THE DESCRIPTION IS LOAD-BEARING AND ANTI-REFLEX. A model handed a progress
// tool will call it constantly and turn it into narration; the description
// deliberately forbids that. Do not soften it.

import { call } from "../lib/server.ts";
import { arr, input, num, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "progress_report",
    description: [
      "Report at **plan boundaries**, not per action. Each call **replaces** the",
      "previous state — this is a status, not a log. Do not call more than roughly",
      "once a minute. This does NOT notify the user; use `notify` for that. Set",
      '`state:"blocked"` only when you have genuinely stopped and need a human',
      "decision.",
    ].join(" "),
    input: input(
      {
        label: str(
          'A one-line, in your own words description of where you are now (e.g. "step 3 of 5: wiring the REST handler").',
        ),
        step: num(
          "The current step (1-based). Monotonic: a lower value than the last report is clamped.",
        ),
        total: num("Total steps in the plan. May change freely as the plan evolves."),
        state: oneOf(
          ["working", "blocked", "done", "failed"],
          "working = in progress; blocked = you have stopped and need a human decision; done/failed = finished.",
        ),
        detail: str("Optional free-form detail (obstacle, what's next, etc.)."),
        sinks: arr(
          oneOf(["ui"]),
          'Where to send the progress signal. Only "ui" is implemented; unknown sinks are ignored.',
        ),
      },
      ["label", "step", "total", "state", "detail", "sinks"],
    ),
    async execute(args, context) {
      const body: Record<string, unknown> = { sessionID: context.sessionID };
      if (args.label !== undefined) body.label = args.label;
      if (args.step !== undefined) body.step = args.step;
      if (args.total !== undefined) body.total = args.total;
      if (args.state !== undefined) body.state = args.state;
      if (args.detail !== undefined) body.detail = args.detail;
      if (args.sinks !== undefined) body.sinks = args.sinks;
      const result = await call("POST", "/api/progress", body);
      return result?.ok ? "Progress recorded." : "Progress failed to record.";
    },
  },
];

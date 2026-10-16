// V2 twin of docs/opencode-tools/send-to-cto.ts → send_to_cto. Thin registrar
// over POST /api/cto/inbound; manta-server owns routing + the inbox store.

import { call } from "../lib/server.ts";
import { arr, input, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "send_to_cto",
    description: [
      "Report a note to the on-call CTO. Any session can call this: it appends a",
      "note to the durable CTO inbox (the CTO reads it via the read_inbox verb).",
      "One verb, one routing rule: a bare {message} is treated as a blocker and",
      "fires the immediate blocking-tier notification the same way a question",
      "waiting does; a non-blocker kind is silent — it sits in the inbox until the",
      "CTO drains it. You should give the message some context (what happened, why",
      "it matters), and pass refs (a new P0 issue, a blocker, a failing check) so",
      "the CTO can jump to it. This supersedes every earlier send_to_cto spelling.",
    ].join(" "),
    input: input(
      {
        message: str(
          "What to report. Be concrete: the fact, the impact, what the CTO should know.",
        ),
        kind: oneOf(
          ["fyi", "finding", "blocker", "handoff", "anomaly"],
          "The note's kind. Default (and bare {message}) is `blocker`, which is the only " +
            "kind that fires the immediate blocking-tier notification. fyi/finding/handoff/" +
            "anomaly are silent — they land in the inbox unread and surface via read_inbox.",
        ),
        refs: arr(
          str(),
          "Optional refs for the note — issue/PR keys, check names, surface ids — so the CTO can jump to them.",
        ),
        tag: str(
          "Optional dedupe tag: two notes with the same tag coalesce into one inbox entry " +
            "(refs union, timestamp refreshed, count bumped) instead of creating a duplicate.",
        ),
        title: str(
          "Optional short title for the surfaced notification. Defaults to the sender's session label.",
        ),
        condition: str(
          "For blockers: a checkable condition the note is blocked on (e.g. 'CI on F is broken'). " +
            "The CTO re-verifies it on its card ticks and auto-resolves the blocker when the named state no longer holds.",
        ),
      },
      ["kind", "refs", "tag", "title", "condition"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/cto/inbound", {
        surface: "session",
        sessionID: context.sessionID,
        kind: args.kind,
        message: args.message,
        refs: args.refs,
        tag: args.tag,
        title: args.title,
        condition: args.condition,
      });
      const blocker =
        result.parked &&
        args.kind !== "fyi" &&
        args.kind !== "finding" &&
        args.kind !== "handoff" &&
        args.kind !== "anomaly" &&
        (args.kind === "blocker" || !args.kind);
      return blocker
        ? "Flagged to the CTO as a blocker (immediate notification + inbox note)."
        : "Reported to the CTO inbox (silent — surfaces via read_inbox).";
    },
  },
];

// V2 twin of docs/opencode-tools/cto-verdict.ts → cto_verdict. Records a
// verdict about a suggestion the Adaptive CTO surfaced (POST /api/cto/verdict).

import { call } from "../lib/server.ts";
import { bool, input, obj, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "cto_verdict",
    description: [
      "Record a verdict about a suggestion the Adaptive CTO surfaced (or you gave",
      "it) into the verdict ledger: whether it was accepted, edited, dismissed,",
      "vetoed, corrected, marked never-again, expired, or opened. Accepted findings",
      "build the CTO's trust in the source that produced them; rejections do the",
      "opposite. Use it when you assess a suggestion the CTO proposed — e.g. an",
      "open blocker-card recommendation or a digest item reference — so the CTO",
      "learns what is useful.",
    ].join(" "),
    input: input(
      {
        type: str(
          "The kind of subject being judged, e.g. `fact` (a blackboard fact), `digest_item` (a digest row).",
        ),
        id: str("The subject's stable id (the fact id, the digest item id)."),
        class: str(
          "Optional learner partition the subject belongs to (e.g. a project, tier).",
        ),
        sender: {
          // z.union([z.string(), z.object({ sessionID: z.string() })])
          anyOf: [{ type: "string" }, obj({ sessionID: str() }, ["sessionID"])],
          description:
            "Who produced the subject worth crediting (trust/reliability). A session id string or {sessionID}.",
        },
        verdict: oneOf(
          ["accept", "dismiss", "edit", "veto", "expire", "correct", "open"],
          "accept (keep, confirm), edit (keep-with-signal), dismiss (reject), veto (reject a pending window), " +
            "correct (reject, it was wrong), expire (retention decay only), open (accessed / importance only).",
        ),
        never: bool(
          "Mark as a never-again judgment (kills future rings). A never-flagged verdict is counted as a rejection.",
        ),
      },
      ["class", "sender", "never"],
    ),
    async execute(args) {
      const result = await call("POST", "/api/cto/verdict", {
        subject: {
          type: args.type,
          id: args.id,
          ...(args.class ? { class: args.class } : {}),
          ...(args.sender !== undefined ? { sender: args.sender } : {}),
        },
        verdict: args.verdict,
        ...(args.never !== undefined ? { never: args.never } : {}),
      });
      const effects = result?.effects ? Object.keys(result.effects).join(" + ") : "none";
      return `Verdict recorded: ${args.verdict} on ${args.type}:${args.id} → counter effects [${effects}].`;
    },
  },
];

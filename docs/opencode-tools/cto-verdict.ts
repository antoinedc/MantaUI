// `cto_verdict` tool — global opencode custom tool (Adaptive CTO, BET-1391 / §9.5).
//
// Lets any agent session record a *verdict* about a suggestion it surfaced
// (or the user gave) into the Adaptive CTO verdict ledger: whether the
// suggestion was accepted, edited, dismissed, vetoed, corrected, marked
// never-again, expired, or simply opened. The server appends it to
// `verdicts.json` and routes its §9.5 counter effects to the registered sinks
// (facts sender-reliability now, trust / tool counters later) — see
// src/server/ctoVerdicts.mjs.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/cto-verdict.ts ~/.config/opencode/tools/cto-verdict.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar (see docs/opencode-tools/AGENTS.md): it
// validates the verdict shape client-side and POSTs it to manta-server
// (127.0.0.1:8787, same box), which owns the verdict ledger and the §9.5
// counter routing. execute() returns promptly with the recorded effects.

import { tool } from "@opencode-ai/plugin";
import { authHeaders } from "./manta-auth";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";
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

export const cto_verdict = tool({
  description: [
    "Record a verdict about a suggestion the Adaptive CTO surfaced (or you gave",
    "it) into the verdict ledger: whether it was accepted, edited, dismissed,",
    "vetoed, corrected, marked never-again, expired, or opened. Accepted findings",
    "build the CTO's trust in the source that produced them; rejections do the",
    "opposite. Use it when you assess a suggestion the CTO proposed — e.g. an",
    "open blocker-card recommendation or a digest item reference — so the CTO",
    "learns what is useful.",
  ].join(" "),
  args: {
    type: z
      .string()
      .describe(
        "The kind of subject being judged, e.g. `fact` (a blackboard fact), `digest_item` (a digest row).",
      ),
    id: z.string().describe("The subject's stable id (the fact id, the digest item id)."),
    class: z
      .string()
      .optional()
      .describe("Optional learner partition the subject belongs to (e.g. a project, tier)."),
    sender: z
      .union([z.string(), z.object({ sessionID: z.string() })])
      .optional()
      .describe(
        "Who produced the subject worth crediting (trust/reliability). A session id string or {sessionID}.",
      ),
    verdict: z
      .enum(["accept", "dismiss", "edit", "veto", "expire", "correct", "open"])
      .describe(
        "accept (keep, confirm), edit (keep-with-signal), dismiss (reject), veto (reject a pending window), " +
          "correct (reject, it was wrong), expire (retention decay only), open (accessed / importance only).",
      ),
    never: z
      .boolean()
      .optional()
      .describe(
        "Mark as a never-again judgment (kills future rings). A never-flagged verdict is counted as a rejection.",
      ),
  },
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
});

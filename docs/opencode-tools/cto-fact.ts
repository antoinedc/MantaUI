// `cto_fact` tool — global opencode custom tool (Adaptive CTO, BET-1390 / §6.2).
//
// Lets any agent session propose a *fact* onto the Adaptive CTO blackboard: a
// short, evidence-backed statement about a project (a status, blocker,
// decision, theory, invariant, or anomaly). Facts are the CTO's durable,
// cross-session memory — surfaced later to new sessions and delegate jobs via
// §6.9 spawn-context seeding.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/cto-fact.ts ~/.config/opencode/tools/cto-fact.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar (see docs/opencode-tools/AGENTS.md). It
// validates the proposal and POSTs it to manta-server (127.0.0.1:8787, same
// box — no SSH hop), which owns the durable queue and the gatekeeper
// (src/server/ctoFacts.mjs). execute() returns promptly with the gatekeeper
// verdict when it resolves fast, or a "queued" note if resolution is still
// pending (the server's durable queue resolves it regardless).
//
// Refs rule: every proposal needs at least one `refs` evidence pointer (a
// message id, commit sha, file path, issue key). A proposal submitted with no
// refs is rejected client-side here, with a nudge to attach evidence.

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

export const cto_fact = tool({
  description: [
    "Propose a fact onto the Adaptive CTO blackboard: a short, evidence-backed",
    "statement about a project (status, blocker, decision, theory, invariant,",
    "or anomaly). Facts become durable cross-session memory for the CTO and are",
    "surfaced to future sessions as context. Use it to record something you",
    "learned or settled (a root cause, a decision, a blocker you hit) so it is",
    "not lost when your session ends. Every proposal needs at least one `refs`",
    "evidence pointer (message id, commit sha, file path, issue key) — proposals",
    "without evidence are rejected.",
  ].join(" "),
  args: {
    project: z
      .string()
      .describe(
        "The project this fact is about (the session id or its name) — required.",
      ),
    kind: z
      .enum(["status", "blocker", "decision", "theory", "invariant", "anomaly"])
      .describe(
        "What kind of fact this is: status (current state), blocker (something blocking progress), " +
          "decision (a settled choice), theory (an unconfirmed hypothesis), invariant (something that must hold), " +
          "anomaly (unexpected behavior).",
      ),
    statement: z
      .string()
      .describe("The fact itself — a short, concrete, evidence-backed statement (≤ 200 chars)."),
    refs: z
      .array(z.string())
      .optional()
      .describe(
        "Evidence pointers for the claim — message ids, commit shas, file paths, issue keys. " +
          "At least one is required; a proposal with no refs is rejected and you must attach evidence.",
      ),
    valid_until: z
      .string()
      .optional()
      .describe("Optional ISO 8601 expiry; after this time the fact is dropped."),
    supersedes: z
      .string()
      .optional()
      .describe("Optional id of a prior fact that this statement revises or replaces."),
  },
  async execute(args, context) {
    const refs = Array.isArray(args.refs) ? args.refs : [];
    if (refs.length === 0) {
      return (
        "Rejected: a fact proposal requires at least one `refs` entry (an evidence pointer such as " +
        "a message id, commit sha, or file path). Attach evidence to your claim and retry."
      );
    }
    const result = await call("POST", "/api/cto/facts", {
      project: args.project,
      kind: args.kind,
      statement: args.statement,
      refs,
      ...(args.valid_until ? { valid_until: args.valid_until } : {}),
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      sessionID: context.sessionID,
    });
    if (result.queued) {
      return `Fact proposal queued for gatekeeper review (proposal ${result.proposalId}). It will be resolved shortly.`;
    }
    const action = result?.outcome?.action ?? "submitted";
    const reason = result?.outcome?.reason ? ` — ${result.outcome.reason}` : "";
    return `Fact proposal resolved: ${action}${reason} (proposal ${result.proposalId}).`;
  },
});

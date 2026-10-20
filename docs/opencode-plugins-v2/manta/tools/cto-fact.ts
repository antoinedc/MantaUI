// V2 twin of docs/opencode-tools/cto-fact.ts → cto_fact. Proposes a fact onto
// the Adaptive CTO blackboard via POST /api/cto/facts. Every proposal needs at
// least one `refs` evidence pointer; a proposal without refs is rejected here,
// client-side, with a nudge to attach evidence.

import { call } from "../lib/server.ts";
import { arr, input, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "cto_fact",
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
    input: input(
      {
        project: str("The project this fact is about (the session id or its name) — required."),
        kind: oneOf(
          ["status", "blocker", "decision", "theory", "invariant", "anomaly"],
          "What kind of fact this is: status (current state), blocker (something blocking progress), " +
            "decision (a settled choice), theory (an unconfirmed hypothesis), invariant (something that must hold), " +
            "anomaly (unexpected behavior).",
        ),
        statement: str(
          "The fact itself — a short, concrete, evidence-backed statement (≤ 200 chars).",
        ),
        refs: arr(
          str(),
          "Evidence pointers for the claim — message ids, commit shas, file paths, issue keys. " +
            "At least one is required; a proposal with no refs is rejected and you must attach evidence.",
        ),
        valid_until: str("Optional ISO 8601 expiry; after this time the fact is dropped."),
        supersedes: str("Optional id of a prior fact that this statement revises or replaces."),
      },
      ["refs", "valid_until", "supersedes"],
    ),
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
  },
];

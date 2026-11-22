// Agents Phase 2 (docs/superpowers/specs/2026-11-22-agents-phase2.md §5): `agent_handoff` — the lead hands a piece of
// real work to one of the user's agents. A thin registrar over manta-server (src/server/agents.mjs): the server checks
// that this really is the lead's live call (the execute context's `id` is forwarded as `callID`), then starts the job
// through the delegate engine. A refusal comes back as a sentence, never as an error, so the model can act on it.

import { call } from "../lib/server.ts";
import { input, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "agent_handoff",
    description: [
      "Hand a piece of real work to one of your team's agents (listed under 'Your team').",
      "It runs in the background in its own session (code-editing agents get their own branch).",
      "Returns immediately; the result arrives later as a separate message — do not guess it.",
    ].join(" "),
    input: input(
      {
        agent: str('The agent\'s slug, e.g. "dev" (the name after the @ in \'Your team\').'),
        title: str("A short title for the task, at most 80 characters; shown on the task card."),
        brief: str(
          "The self-contained task brief: goal, why, what done looks like, the output you want, scope (in / out) and the " +
            "decisions already made in this chat. The agent has not seen this conversation.",
        ),
        continueJob: str(
          "Optional: the id of a FINISHED task of this chat that you handed to the same agent, to send it another round " +
            "(same session and branch) instead of starting a new task.",
        ),
      },
      ["continueJob"],
    ),
    async execute(args, context) {
      let res: any;
      try {
        res = await call("POST", "/api/agents/handoff", {
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          agent: args.agent,
          title: args.title,
          brief: args.brief,
          ...(args.continueJob ? { continueJob: args.continueJob } : {}),
        });
      } catch (e: any) {
        return `Not handed off: ${e?.message ?? e}`;
      }
      if (res?.ok === true) {
        return `Handed to ${res.agentName} (job ${res.jobId}). Its result will arrive as a later message; tell the user in one line and stop.`;
      }
      return `Not handed off: ${res?.error ?? "the handoff was refused"}`;
    },
  },
];

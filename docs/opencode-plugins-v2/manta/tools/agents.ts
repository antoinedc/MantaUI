// Agents Phase 2 (docs/superpowers/specs/2026-11-22-agents-phase2.md §5): `agent_handoff` — the lead hands a piece of
// real work to one of the user's agents. A thin registrar over manta-server (src/server/agents.mjs): the server checks
// that this really is the lead's live call (the execute context's `id` is forwarded as `callID`), then starts the job
// through the delegate engine. A refusal comes back as a sentence, never as an error, so the model can act on it.
//
// Agents Phase 4 (docs/superpowers/specs/2026-11-23-agents-phase4-architect.md §2.3): `agent_change` — the lead creates a
// new agent or edits an existing one. Registered like every plugin tool; the server refuses it outside a chat Manta leads.

import { call } from "../lib/server.ts";
import { input, obj, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

const nullableStr = (description: string): Record<string, unknown> => ({ type: ["string", "null"], description });

// Every key is optional here: a create must carry name, description, isolation and instructions (the server says which
// is missing); an update carries only what changes. `null` clears an optional field on an update.
const draftSchema = (): Record<string, unknown> =>
  obj(
    {
      name: str("The agent's name, one line, at most 40 characters."),
      description: str("What the agent does, one line, at most 200 characters."),
      isolation: oneOf(["worktree", "none"], '"worktree" = works in its own branch and can edit code; "none" = read-only. Read-only unless it must change code.'),
      instructions: str("The agent's full instructions (Markdown): how it works and what it never does. At most 12,000 characters."),
      useWhen: nullableStr("One line (at most 200 characters): when to hand work to this agent."),
      notFor: nullableStr("One line (at most 200 characters): what not to hand it."),
      model: nullableStr('A "provider/model" the user approved for agents. Leave it out (Auto) unless the user named one; on an update, leaving it out keeps the current pin.'),
      color: nullableStr('A colour like "#5A88FF".'),
    },
    [],
    "The agent's fields. Create: name, description, isolation and instructions are required. Update: only the fields that change.",
  );

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
  {
    name: "agent_change",
    description: [
      "Create a new agent or change one of your team's agents (including yourself) — only in a chat you lead.",
      "Call it directly; don't ask first in words: the user approves on a card when their settings require it.",
      "Create needs a complete draft (name, description, isolation, instructions); update takes only the fields that change.",
    ].join(" "),
    // `agent` is optional and last: an optional key before a required one is silently dropped by strict tool schemas
    input: input(
      {
        action: oneOf(["create", "update"], "create a new agent, or update an existing one."),
        draft: draftSchema(),
        agent: str('Update only: the slug of the agent to change, e.g. "dev" (the name after the @ in \'Your team\'); "manta" is yourself.'),
      },
      ["agent"],
    ),
    async execute(args, context) {
      let res: any;
      try {
        res = await call("POST", "/api/agents/change", {
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          action: args.action,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          draft: args.draft,
        });
      } catch (e: any) {
        return `Not changed: ${e?.message ?? e}`;
      }
      const change = res?.change;
      if (res?.ok === true && change?.state === "applied") {
        return change.kind === "create"
          ? `Created ${change.agentName} (@${change.slug}). It is ready: you can hand work to @${change.slug} now. The user sees a card with Undo.`
          : `Updated ${change.agentName} (@${change.slug}). The user sees the change on a card with Undo.`;
      }
      if (res?.ok === true && change?.state === "pending") {
        return `Proposed. The user sees a card to ${change.kind === "create" ? "create it" : "apply it"}; nothing is written until they click. Tell them in one line and stop; don't claim it is done.`;
      }
      if (res?.ok === false && change?.state === "failed") {
        return `${res.error} The user sees a card with Retry.`;
      }
      return `Not changed: ${res?.error ?? "the change was refused"}`;
    },
  },
];

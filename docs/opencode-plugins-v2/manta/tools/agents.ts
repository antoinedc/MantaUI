// Agents Phase 2 (docs/superpowers/specs/2026-11-22-agents-phase2.md §5): `agent_handoff` — the lead hands a piece of
// real work to one of the user's agents. A thin registrar over manta-server (src/server/agents.mjs): the server checks
// that this really is the lead's live call (the execute context's `id` is forwarded as `callID`), then starts the job
// through the delegate engine. A refusal comes back as a sentence, never as an error, so the model can act on it.
//
// Agents Phase 4 (docs/superpowers/specs/2026-11-23-agents-phase4-architect.md §2.3): `agent_change` — the lead creates a
// new agent or edits an existing one. Registered like every plugin tool; the server refuses it outside a chat Manta leads.
//
// Agents Phase 5A (docs/superpowers/specs/2026-11-24-agents-phase5-builder.md §4.4): `agent_propose` — the Architect proposes a
// change from research. The server checks that this is the Architect's own live call inside its stamped task, verifies every
// quote against the sources it fetched, and holds the proposal until the task ends.

import { call } from "../lib/server.ts";
import { arr, input, obj, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

const nullableStr = (description: string): Record<string, unknown> => ({ type: ["string", "null"], description });

// An extra research source of the Architect (spec §4.3a): exactly one of `command` / `url`. Required keys first: an optional
// key before a required one is silently dropped by strict tool schemas.
const mapOf = (description: string): Record<string, unknown> => ({ type: "object", additionalProperties: { type: "string" }, description });
const sourceSchema = (): Record<string, unknown> =>
  obj(
    {
      id: str("Lowercase letters, digits and dashes, at most 30; not hn, arxiv, reddit, x, github or web."),
      name: str("A short display name, at most 60 characters."),
      description: str("One line, at most 300 characters: what the source is and what queries suit it. Shown to the Architect."),
      private: { type: "boolean", description: "Default true. False only if the user says the source is public." },
      command: arr(str(), 'A program and its arguments, run without a shell, e.g. ["yc","search","{query}","--limit","15"]; {query} exactly once as a whole word.'),
      url: str('A literal https address with {query} as the whole value of one query parameter, e.g. "https://search.example.com/api?q={query}".'),
      headers: mapOf("A url source only. A credential header holds only a reference: Authorization: Bearer {secret:NAME}."),
      env: mapOf("A command source only. A credential variable holds only a reference: {secret:NAME}."),
    },
    ["id", "name", "description"],
  );
const sourcesSchema = (): Record<string, unknown> => ({
  type: ["array", "null"],
  items: sourceSchema(),
  description: "ONLY when updating the Architect: its extra research sources (the whole list; null clears it). Never put a credential here; use {secret:NAME} references. The user approves on a card.",
});

// Every key is optional here: a create must carry name, description, isolation and instructions (the server says which
// is missing); an update carries only what changes. `null` clears an optional field on an update.
const draftProps = (): Record<string, Record<string, unknown>> => ({
  name: str("The agent's name, one line, at most 40 characters."),
  description: str("What the agent does, one line, at most 200 characters."),
  isolation: oneOf(["worktree", "none"], '"worktree" = works in its own branch and can edit code; "none" = read-only. Read-only unless it must change code.'),
  instructions: str("The agent's full instructions (Markdown): how it works and what it never does. At most 12,000 characters."),
  useWhen: nullableStr("One line (at most 200 characters): when to hand work to this agent."),
  notFor: nullableStr("One line (at most 200 characters): what not to hand it."),
  model: nullableStr('A "provider/model" the user approved for agents. Leave it out (Auto) unless the user named one; on an update, leaving it out keeps the current pin.'),
  color: nullableStr('A colour like "#5A88FF".'),
});
const draftSchema = (withSources = true): Record<string, unknown> =>
  obj(
    { ...draftProps(), ...(withSources ? { sources: sourcesSchema() } : {}) },
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
      "For a new agent or a substantial rework, write the charter yourself from the request (job, trigger, never-do, edits code or not; read-only unless the request implies changing things) and hand it straight to @architect, telling the user in one line what you assumed. Never ask the user to review a charter; only if something essential is genuinely unclear, ask targeted questions, all at once in one question call.",
      "Use agent_change yourself for small edits the user dictates, or when @architect isn't on the team.",
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
  {
    name: "agent_propose",
    description: [
      "Propose a change to the team's agents from your research — only inside a task Manta handed you (you are the Architect).",
      "Every proposal needs a summary, at least one quote copied exactly from a source you fetched with research_fetch, and your admission table (each candidate rule General, Scoped or Excluded).",
      "At most 3 per task. The proposal is held until your task ends; then the user's settings decide whether it is applied or waits for their click. Never say it is applied.",
      "An update needs the baseHash of the file you read (from your brief).",
    ].join(" "),
    // `agent` and `baseHash` are optional and LAST: an optional key before a required one is silently dropped by strict tool schemas
    input: input(
      {
        action: oneOf(["create", "update"], "create a new agent, or update an existing one."),
        draft: draftSchema(false),
        summary: str("1 to 600 characters: what you propose and why, for the person who reads the card."),
        evidence: arr(
          obj(
            {
              sourceId: str("The sourceId returned by research_fetch / research_search."),
              quote: str("20 to 300 characters copied EXACTLY from that source (whitespace may differ; case may not)."),
              claim: str("1 to 300 characters: what this quote supports."),
            },
            ["sourceId", "quote", "claim"],
          ),
          "1 to 12 items. Every quote is checked against the stored source text.",
        ),
        admission: arr(
          obj(
            {
              rule: str("The candidate rule, 1 to 300 characters."),
              verdict: oneOf(["general", "scoped", "excluded"], "general = well supported across contexts; scoped = true only for a named situation; excluded = weak, contradicted or already done by the model."),
              why: str("1 to 300 characters."),
            },
            ["rule", "verdict", "why"],
          ),
          "Up to 40 items: every rule you considered, including the excluded ones. Pass [] if you considered none.",
        ),
        agent: str('Update only: the slug of the agent to change, e.g. "dev" (the name after the @ in the roster).'),
        baseHash: str("Update only: the hash of the agent file you read, as given in your brief."),
      },
      ["agent", "baseHash"],
    ),
    async execute(args, context) {
      let res: any;
      try {
        res = await call("POST", "/api/agents/propose", {
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          action: args.action,
          draft: args.draft,
          summary: args.summary,
          evidence: args.evidence,
          admission: args.admission,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.baseHash !== undefined ? { baseHash: args.baseHash } : {}),
        });
      } catch (e: any) {
        return `Not proposed: ${e?.message ?? e}`;
      }
      if (res?.ok === true) {
        const n = res.used !== undefined ? ` (${res.used} of ${res.limit ?? 3} in this task)` : "";
        return `Proposed${n}. It is held until your task ends; then the user's settings decide whether it is applied or waits for their click. Don't say it is applied.`;
      }
      const current = res?.current?.text
        ? `\n\nThe current file (hash ${res.current.hash}):\n\n${res.current.text}`
        : "";
      return `Not proposed: ${res?.error ?? "the proposal was refused"}${current}`;
    },
  },
];

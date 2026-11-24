// ask_user: the generic way for any specialist's background task to put a question to the user (spec
// docs/superpowers/specs/2026-11-24-ask-user-tool.md). A thin registrar over manta-server (src/server/askUser.mjs): the
// server binds the call to the running task, stores the question on its record and marks the task "needs a decision". The tool
// does not wait for an answer; the task ends, the lead puts the question to the user and sends the answer back to the task.

import { call } from "../lib/server.ts";
import { bool, input, obj, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "ask_user",
    description: [
      "Put one decision to the user (only inside a task Manta handed you; you cannot wait for a person, so this ends your task).",
      "Call it when you need the user to choose, or when what you found says the request as given is likely a mistake and you would rather say so than silently comply or silently change it.",
      "It records the question and ends your task as \"needs a decision\": the lead asks the user and sends the answer back to this task.",
      "Give 2 to 4 options, each with a label and a one-line description; say which you recommend (recommended is the 0-based index of that option) and why, citing the library entries or sources you relied on.",
      "Set concern to true when you think the request as given is a mistake.",
      "After it returns, end your turn at once with one line; do no further work and do not answer the question yourself.",
    ].join(" "),
    // optional keys are LAST: an optional key before a required one is silently dropped by strict tool schemas
    input: input(
      {
        question: str("The decision, in one or two sentences, for someone who has not seen your work (at most 500 characters)."),
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: obj({ label: str("A short name for the option (at most 80 characters)."), description: str("What choosing it means, in one line (at most 300 characters).") }, ["label", "description"]),
          description: "2 to 4 options the user can choose between.",
        },
        recommended: { type: "integer", minimum: 0, maximum: 3, description: "The 0-based index of the option you recommend, if you have one." },
        why: str("Why you recommend it, in a few sentences; cite library entries or sources (at most 800 characters)."),
        concern: bool("true when you think the request as given is a mistake."),
      },
      ["recommended", "why", "concern"],
    ),
    async execute(args, context) {
      let res: any;
      try {
        res = await call("POST", "/api/ask-user", {
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          question: args.question,
          options: args.options,
          ...(args.recommended !== undefined ? { recommended: args.recommended } : {}),
          ...(args.why !== undefined ? { why: args.why } : {}),
          ...(args.concern !== undefined ? { concern: args.concern } : {}),
        });
      } catch (e: any) {
        return `Not recorded: ${e?.message ?? e}`;
      }
      if (res?.ok !== true) return `Not recorded: ${res?.error ?? "the question was refused"}`;
      return "Recorded. Your task ends as \"needs a decision\" and the lead will put this to the user. End your turn now with one line saying you asked; do no further work and do not answer it yourself.";
    },
  },
];

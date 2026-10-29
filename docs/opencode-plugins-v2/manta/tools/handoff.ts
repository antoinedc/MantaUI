// V2-only tool (no V1 twin): `handoff`. Thin registrar over POST /api/handoff;
// manta-server owns the handoff record, the appended observed facts, and the
// start protocol. Spec: docs/superpowers/specs/2026-10-26-auto-handoff.md §3, §4.1, §11, §15.
//
// Unlike the other tools this one does NOT go through lib/server.ts `call`: that
// helper throws only the error CODE, and the model needs the server's message too
// (it is the actionable part), so the error body is read here.

import { authHeaders, serverUrl } from "../lib/server.ts";
import { input, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

const RECORD_ID_RE = /^[A-Za-z0-9_-]+$/;
const TIMEOUT_MS = 30_000;

// The line follows what the server DID (the record's kind), not what was asked: `auto` is a start planned
// for the end of this turn; anything else is a card for the user.
const QUEUED_LINE = "Handoff queued — it happens when this turn ends. End your turn now.";
const READY_LINE = "Handoff prompt ready below.";

function failure(detail: string): string {
  return (
    `Handoff failed: ${detail} Nothing was started, and no handoff will happen. ` +
    "Carry on with the current task; do not retry in a loop — tell the user if it matters."
  );
}

export const tools: ToolDef[] = [
  {
    name: "handoff",
    description: [
      "Hand this conversation off to a fresh session with a structured summary, instead of",
      "letting the context grow until it is compacted in place. Two actions.",
      "`suggest`: prepare a handoff prompt and show it to the user as a card they can copy,",
      "start in a new session, or edit — use it when YOU propose a fresh start and the user",
      "decides. Nothing starts by itself.",
      "`handoff`: you have reached a natural stopping point, your context is over or near its",
      "working budget, and you intend to keep working — manta starts a replacement session",
      "with your handoff as its first turn once this turn ends, and the work continues there.",
      "After `action: handoff` END YOUR TURN IMMEDIATELY (no more tool calls, no further",
      "work): the handoff happens when the turn completes. If the user's mode is `suggest` or",
      "`off`, or the turn fails, it becomes a card for the user instead.",
      "In a background job the mode defaults to auto: both actions start the handoff when this",
      "turn ends, so end your turn right after calling it.",
      "NEVER call it mid-task or while work is half-done; if you are simply finished, just",
      "finish — do not hand off.",
      "`body` is the handoff text and MUST use exactly these six headings, in order:",
      "`## Goal`, `## Current state`, `## Decisions (and why)`, `## Dead ends tried`,",
      "`## Next step`, `## Open questions`. Write it so a session with NO memory of this one",
      "can continue: concrete, specific, no pleasantries. Do NOT list files, git branch,",
      "uncommitted changes or the todo list — manta appends those as observed facts. If a",
      "heading is missing, manta regenerates the body itself after your turn. `goal` is an",
      "optional one-line steer for what the next session should accomplish.",
    ].join(" "),
    input: input(
      {
        action: oneOf(
          ["suggest", "handoff"],
          "`suggest` shows the user a handoff card; `handoff` starts a replacement " +
            "session when this turn ends (then end your turn).",
        ),
        body: str(
          "The handoff text, using the six headings: ## Goal, ## Current state, " +
            "## Decisions (and why), ## Dead ends tried, ## Next step, ## Open questions. " +
            "Do not list files/branch/todos — manta appends them.",
        ),
        goal: str("Optional one-line steer for the next session's objective."),
      },
      ["goal"],
    ),
    async execute(args, context) {
      const action: "suggest" | "handoff" = args.action === "handoff" ? "handoff" : "suggest";
      const payload = {
        sessionId: context.sessionID,
        trigger: "agent",
        action,
        goal: args.goal,
        body: args.body,
      };
      let res: Response;
      try {
        res = await fetch(`${serverUrl()}/api/handoff`, {
          method: "POST",
          headers: authHeaders(payload),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e: any) {
        return failure(`could not reach manta-server (${e?.message ?? e}).`);
      }
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { message: text };
      }
      if (!res.ok) {
        const code = typeof json?.error === "string" && json.error ? json.error : `http_${res.status}`;
        const message = typeof json?.message === "string" && json.message ? ` ${json.message}` : "";
        return failure(`manta-server refused it (${code}).${message}`);
      }
      const id = json?.handoff?.id;
      if (typeof id !== "string" || !RECORD_ID_RE.test(id)) {
        return failure("manta-server returned no handoff id.");
      }
      const line = json?.handoff?.kind === "auto" ? QUEUED_LINE : READY_LINE;
      return `${line}\n<!-- manta-handoff:${id} -->`;
    },
  },
];

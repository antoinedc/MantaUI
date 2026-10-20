// todo_write — the structured task list.
//
// V1 had a built-in `todowrite` tool and a `todo.updated` event that drove the
// pinned ActiveTodos card. V2 REMOVED both on purpose (the name `todowrite` is
// reserved and answers with a removal notice — docs/opencode-v2/spikes/p3,
// item 1), so Manta ships its own. The input shape is IDENTICAL to V1's
// TodoWrite so the transcript parsing carries over.
//
// This tool is deliberately side-effect free: it only acknowledges. The todo
// state lives in the transcript — the tool call's INPUT is the full list, and
// Phase 2's event mapper derives the `todos` frame from it. Do NOT name this
// `todowrite`.

import { arr, input, obj, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "todo_write",
    description: [
      "Use this tool to create and manage a structured task list for your current session.",
      "It helps you track progress, organize complex tasks, and shows the user the progress of their request.",
      "Each call REPLACES the whole list, so always send every task, not just the ones that changed.",
      "",
      "When to use it:",
      "- Complex multi-step work (3 or more distinct steps) or non-trivial tasks that need planning.",
      "- The user gives you several tasks, or explicitly asks for a todo list.",
      "- After receiving new instructions: capture them as todos right away.",
      "- When you start a task: mark it in_progress BEFORE beginning work.",
      "- After finishing a task: mark it completed immediately and add any follow-up tasks you discovered.",
      "",
      "When NOT to use it: a single straightforward task, a trivial task, or a purely conversational or informational request.",
      "",
      "Task states:",
      "- pending: not yet started",
      "- in_progress: currently working on (keep exactly ONE in_progress at a time)",
      "- completed: finished successfully",
      "- cancelled: no longer needed",
      "",
      "Task management:",
      "- Update statuses in real time as you work, and mark tasks completed as soon as they are done — never batch completions.",
      "- Only mark a task completed when it is FULLY accomplished; if you hit errors or blockers, keep it in_progress and add a task for what needs resolving.",
      "- Cancel tasks that become irrelevant instead of leaving them to linger.",
      "- Create specific, actionable items and break complex tasks into smaller steps.",
      "When in doubt, use this tool: proactive task management shows attentiveness and ensures every requirement is completed.",
    ].join("\n"),
    input: input({
      todos: arr(
        obj(
          {
            content: str("Brief description of the task"),
            status: oneOf(
              ["pending", "in_progress", "completed", "cancelled"],
              "Current status of the task: pending, in_progress, completed, cancelled",
            ),
            priority: oneOf(
              ["high", "medium", "low"],
              "Priority level of the task: high, medium, low",
            ),
          },
          ["content", "status", "priority"],
        ),
        "The updated todo list",
      ),
    }),
    async execute() {
      return "Todos updated";
    },
  },
];

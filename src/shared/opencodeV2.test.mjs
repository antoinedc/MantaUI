// Pure V2 → Manta converters (src/shared/opencodeV2.mjs), tested on the recorded
// corpus in src/server/fixtures/opencodeV2Events/ (opencode 2.0.30, Haiku).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapTimeline,
  toolNameFromV2,
  permissionKeyToV2,
  normalizeToolInput,
  errorFromV2,
  contentText,
  toolOutputText,
  normalizeToolMetadata,
  sessionFromV2,
  permissionFromV2,
  isQuestionForm,
  questionFromForm,
  formAnswerFromAnswers,
  createLifecycleAdapter,
} from "./opencodeV2.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "fixtures", "opencodeV2Events");
const timeline = (n) => JSON.parse(readFileSync(join(DIR, `${n}.timeline.json`), "utf8"));
const events = (n) => readFileSync(join(DIR, `${n}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const names = ["01-plain-text", "02-slow-bash", "03-edit-todo", "04-task-subagent", "05-question", "06-abort", "07-command-compact", "08-permission"];

test("tool names: V2's shell/subagent are bash/task for every reader; others pass through", () => {
  assert.equal(toolNameFromV2("shell"), "bash");
  assert.equal(toolNameFromV2("subagent"), "task");
  assert.equal(toolNameFromV2("edit"), "edit");
  assert.equal(permissionKeyToV2("bash"), "shell");
  assert.equal(permissionKeyToV2("task"), "subagent");
  assert.equal(permissionKeyToV2("edit"), "edit");
});

test("normalizeToolInput adds the V1 spellings without dropping V2's", () => {
  assert.deepEqual(normalizeToolInput("read", { path: "a" }), { path: "a", filePath: "a" });
  assert.deepEqual(normalizeToolInput("subagent", { agent: "explore" }), { agent: "explore", subagent_type: "explore" });
  assert.deepEqual(normalizeToolInput("shell", null), {});
});

test("errorFromV2: typed classes get the V1 names; status → statusCode + isRetryable; response body kept", () => {
  assert.deepEqual(errorFromV2({ type: "provider.no-route", message: "m" }), { name: "APIError", data: { message: "m", type: "provider.no-route" } });
  assert.equal(errorFromV2({ type: "provider.auth", message: "m" }).name, "ProviderAuthError");
  assert.equal(errorFromV2({ type: "context.length", message: "m" }).name, "ContextOverflowError");
  assert.equal(errorFromV2({ type: "aborted", message: "m" }).name, "MessageAbortedError");
  const e = errorFromV2({ type: "provider.internal", message: "Overloaded", status: 529, response: { body: "{}" } });
  assert.deepEqual(e.data, { message: "Overloaded", statusCode: 529, isRetryable: true, responseBody: "{}", type: "provider.internal" });
  assert.equal(errorFromV2({ type: "x", message: "m", status: 402 }).data.isRetryable, false);
  assert.equal(errorFromV2(null), undefined);
  assert.equal(errorFromV2({ type: "weird" }).name, "UnknownError");
});

test("contentText / toolOutputText: text joins, files become a marker, the subagent wrapper is unwrapped", () => {
  assert.equal(contentText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(contentText([{ type: "file", name: "x.png", mime: "image/png" }]), "[file x.png image/png]");
  assert.equal(contentText(undefined), "");
  assert.equal(toolOutputText("subagent", [{ type: "text", text: '<subagent sessionID="s" state="completed">\nres\n</subagent>' }]), "res");
  assert.equal(toolOutputText("shell", [{ type: "text", text: "<subagent>x</subagent>" }]), "<subagent>x</subagent>");
});

test("normalizeToolMetadata: sessionID → sessionId; a patch becomes diff/filediff", () => {
  assert.equal(normalizeToolMetadata("subagent", { sessionID: "ses_c" }).sessionId, "ses_c");
  const md = normalizeToolMetadata("edit", { files: [{ file: "a", patch: "P", additions: 2, deletions: 1 }] });
  assert.equal(md.diff, "P");
  assert.deepEqual(md.filediff, { file: "a", patch: "P", additions: 2, deletions: 1 });
  assert.equal(normalizeToolMetadata("edit", { diff: "keep", files: [{ patch: "P" }] }).diff, "keep");
});

test("sessionFromV2 exposes the V1 `directory` and a string title", () => {
  assert.equal(sessionFromV2({ id: "s", location: { directory: "/d" } }).directory, "/d");
  assert.equal(sessionFromV2({ id: "s" }).title, "");
  assert.equal(sessionFromV2(null), null);
});

test("permissionFromV2: file actions get filepath metadata, shell gets command; tool ref kept", () => {
  const edit = permissionFromV2({ id: "p", sessionID: "s", action: "edit", resources: ["/a/b"], save: ["/a/*"] });
  assert.equal(edit.permission, "edit");
  assert.equal(edit.metadata.filepath, "/a/b");
  assert.equal("tool" in edit, false);
  const sh = permissionFromV2({ id: "p", sessionID: "s", action: "shell", resources: ["ls"], save: [], source: { type: "tool", messageID: "m", id: "t" } });
  assert.equal(sh.permission, "bash");
  assert.equal(sh.metadata.command, "ls");
  assert.deepEqual(sh.tool, { messageID: "m", callID: "t" });
});

test("questions: kind gate, shape and the answer mapping (single, multiselect, free text, missing)", () => {
  const form = { id: "frm", sessionID: "s", metadata: { kind: "question", tool: { messageID: "m", id: "t" } }, fields: [
    { key: "a", title: "A", description: "Q A?", type: "string", options: [{ value: "x", label: "X" }], custom: false },
    { key: "b", title: "B", description: "Q B?", type: "multiselect", options: [{ value: "1", label: "One" }] },
  ] };
  assert.equal(isQuestionForm(form), true);
  assert.equal(isQuestionForm({ metadata: { kind: "oauth" } }), false);
  const q = questionFromForm(form);
  assert.equal(q.id, "frm");
  assert.equal(q.questions[0].custom, false);
  assert.equal(q.questions[1].multiple, true);
  assert.deepEqual(formAnswerFromAnswers(form, [["X", "typed"], ["One"]]), { a: "X, typed", b: ["One"] });
  assert.deepEqual(formAnswerFromAnswers(form, []), { a: "", b: [] });
});

// ---- the recorded timelines ----

test("every recorded timeline maps to well-formed messages: unique part ids, known part types, chronological", () => {
  for (const n of names) {
    const msgs = mapTimeline(timeline(n), { sessionID: "ses_x" });
    assert.ok(msgs.length >= 2, n);
    const ids = msgs.flatMap((m) => m.parts.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length, `${n}: part ids unique`);
    for (const m of msgs) {
      assert.ok(["user", "assistant"].includes(m.info.role), n);
      assert.equal(m.info.sessionID, "ses_x");
      for (const p of m.parts) {
        assert.ok(["text", "reasoning", "tool", "step-finish", "file", "agent"].includes(p.type), `${n}: ${p.type}`);
        assert.equal(p.messageID, m.info.id);
      }
    }
    assert.equal(msgs[0].info.role, "user", n);
  }
});

test("03-edit-todo: tools keep their ids/order; todo_write input is the full list; edit carries a diff", () => {
  const tools = mapTimeline(timeline("03-edit-todo")).flatMap((m) => m.parts).filter((p) => p.type === "tool");
  assert.deepEqual(tools.map((t) => t.tool), ["todo_write", "read", "edit", "todo_write"]);
  assert.equal(tools[0].state.input.todos.length, 2);
  assert.ok(tools.every((t) => t.state.status === "completed" && t.callID === t.id));
  assert.match(tools[2].state.metadata.diff, /-beta\n\+BETA/);
  assert.equal(tools[1].state.input.filePath, tools[1].state.input.path);
});

test("04-task-subagent: the subagent block is a `task` part carrying the child id and the unwrapped result", () => {
  const task = mapTimeline(timeline("04-task-subagent")).flatMap((m) => m.parts).find((p) => p.tool === "task");
  assert.match(task.state.metadata.sessionId, /^ses_/);
  assert.equal(task.state.input.subagent_type, "explore");
  assert.ok(!task.state.output.includes("<subagent"));
});

test("06-abort: the interrupted shell is an errored bash part; the assistant row carries the error", () => {
  const [, a] = mapTimeline(timeline("06-abort"));
  const t = a.parts.find((p) => p.type === "tool");
  assert.equal(t.tool, "bash");
  assert.equal(t.state.status, "error");
  assert.equal(a.info.error.name, "MessageAbortedError");
});

test("07-command-compact: the completed compaction is a summary message holding the summary text", () => {
  const msgs = mapTimeline(timeline("07-command-compact"));
  const summary = msgs.find((m) => m.info.summary);
  assert.ok(summary);
  assert.match(summary.parts[0].text, /^## Objective/);
});

test("assistant token usage rides a step-finish part so the token selectors keep working", () => {
  const a = mapTimeline(timeline("01-plain-text")).find((m) => m.info.role === "assistant");
  assert.ok(a.info.tokens.input >= 0);
  const sf = a.parts.at(-1);
  assert.equal(sf.type, "step-finish");
  assert.deepEqual(sf.tokens, a.info.tokens);
  assert.equal(a.info.modelID, "claude-haiku-4-5");
});

test("mapTimeline tolerates junk", () => {
  assert.deepEqual(mapTimeline(null), []);
  assert.deepEqual(mapTimeline([null, 5, { type: "idle" }, { id: "x", type: "agent-switched" }]), []);
});

// ---- lifecycle adapter ----

const adaptAll = (name) => {
  const a = createLifecycleAdapter();
  return events(name).flatMap((e) => a.adapt(e));
};
const types = (list) => list.map((e) => e.type);

test("lifecycle: a plain turn is busy → … → idle + session.idle, with step.ended usage", () => {
  const out = adaptAll("01-plain-text");
  assert.equal(out.find((e) => e.type === "session.status").properties.status.type, "busy");
  const tail = types(out).slice(-2);
  assert.deepEqual(tail, ["session.status", "session.idle"]);
  const step = out.find((e) => e.type === "session.next.step.ended");
  assert.equal(step.properties.providerID, "anthropic");
  assert.equal(step.properties.finish, "end_turn");
  assert.ok(step.properties.tokens);
});

test("lifecycle: tools surface as message.part.updated tool parts (running → completed) under their V1 name", () => {
  const parts = adaptAll("02-slow-bash").filter((e) => e.type === "message.part.updated").map((e) => e.properties.part);
  assert.deepEqual(parts.map((p) => [p.tool, p.state.status]), [["bash", "running"], ["bash", "completed"]]);
  assert.equal(parts[0].state.input.command.startsWith("for i in"), true);
  assert.equal(parts[0].callID, parts[1].callID);
});

test("lifecycle: an aborted turn → session.error MessageAbortedError, then the idle edge; the tool part errors", () => {
  const out = adaptAll("06-abort");
  const err = out.find((e) => e.type === "session.error");
  assert.equal(err.properties.error.name, "MessageAbortedError");
  const i = types(out);
  assert.ok(i.indexOf("session.error") < i.lastIndexOf("session.idle"));
  assert.equal(out.filter((e) => e.type === "message.part.updated").at(-1).properties.part.state.status, "error");
});

test("lifecycle: a failed turn → session.error (+ an assistant error row for the health registers) then idle", () => {
  const a = createLifecycleAdapter();
  a.adapt({ id: "1", type: "session.step.started", data: { sessionID: "s", model: { providerID: "p", id: "m" }, assistantMessageID: "a" } });
  const out = a.adapt({ id: "2", type: "session.execution.failed", data: { sessionID: "s", error: { type: "provider.internal", message: "Overloaded", status: 529 } } });
  assert.deepEqual(types(out), ["session.error", "message.updated", "session.status", "session.idle"]);
  assert.equal(out[0].properties.error.data.statusCode, 529);
  assert.equal(out[1].properties.info.providerID, "p");
  assert.equal(out[1].properties.info.error.data.statusCode, 529);
});

test("lifecycle: a retry is a session.status retry with attempt/message/next", () => {
  const [r] = createLifecycleAdapter().adapt({ id: "1", type: "session.retry.scheduled", data: { sessionID: "s", attempt: 3, at: 99, error: { message: "Overloaded", status: 529 } } });
  assert.deepEqual(r.properties.status, { type: "retry", attempt: 3, message: "Overloaded", next: 99, statusCode: 529 });
});

test("lifecycle: subagent progress yields a task part with the child id; session.created announces parent", () => {
  const out = adaptAll("04-task-subagent");
  const running = out.filter((e) => e.type === "message.part.updated" && e.properties.part.tool === "task");
  const withChild = running.find((e) => e.properties.part.state.metadata?.sessionId);
  assert.equal(withChild.properties.part.state.status, "running");
  assert.match(withChild.properties.part.state.metadata.sessionId, /^ses_/);
  assert.equal(running.at(-1).properties.part.state.status, "completed");
  const created = out.filter((e) => e.type === "session.created");
  assert.ok(created.some((e) => typeof e.properties.info.parentID === "string"));
});

test("lifecycle: forms → question.asked/replied; permissions keep their names with the card shape", () => {
  const q = adaptAll("05-question");
  const asked = q.find((e) => e.type === "question.asked");
  assert.match(asked.properties.id, /^frm_/);
  assert.equal(asked.properties.questions[0].options.length, 3);
  assert.ok(q.some((e) => e.type === "question.replied" && e.properties.requestID === asked.properties.id));
  const p = adaptAll("08-permission");
  assert.equal(p.find((e) => e.type === "permission.asked").properties.permission, "bash");
  assert.ok(p.some((e) => e.type === "permission.replied"));
});

test("lifecycle: a user prompt entering the inbox is a user.message.created; a non-user item is not", () => {
  const a = createLifecycleAdapter();
  const [u] = a.adapt({ id: "1", type: "session.inbox.enqueued", data: { sessionID: "s", item: { type: "user", payload: { text: "hi" } } } });
  assert.deepEqual(u.properties.message, { role: "user", text: "hi" });
  assert.deepEqual(a.adapt({ id: "2", type: "session.inbox.enqueued", data: { sessionID: "s", item: { type: "compaction" } } }), []);
});

test("lifecycle: events the adapter does not translate produce nothing; junk is safe", () => {
  const a = createLifecycleAdapter();
  for (const t of ["session.text.delta", "project.updated", "shell.created", "session.usage.updated"]) assert.deepEqual(a.adapt({ id: "x", type: t, data: { sessionID: "s" } }), []);
  assert.deepEqual(a.adapt(null), []);
  assert.deepEqual(a.adapt({ type: 5 }), []);
});

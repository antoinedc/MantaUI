// v1EventsAsV2.mjs — TEST SUPPORT. Re-expresses a legacy (OpenCode V1-shaped)
// raw event as the V2 event(s) the stream interpreter consumes.
//
// The renderer's component-test harness (src/renderer/testHarness.tsx) was written
// when the interpreter read V1 events and feeds it hand-built V1 events from ~100
// tests. After the V2 cutover (slice C1) the interpreter reads V2 events; rather
// than rewrite every renderer test's event literals, the harness passes each one
// through this translator. Production never uses it. It covers exactly the event
// families those tests emit; anything else is returned unchanged (the interpreter
// ignores unknown types).

const V1_TO_V2_TOOL = { bash: "shell", task: "subagent" };

/** A translator with the little state it needs (plan calls are de-duplicated per callID, as the V1 box did). */
export function createV1ToV2() {
  const planCalls = new Set();
  return (ev) => v1EventToV2(ev, planCalls);
}

export function v1EventToV2(ev, planCalls = new Set()) {
  if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return [ev];
  const p = ev.properties ?? {};
  const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
  const id = ev.id;
  const out = [];
  const add = (type, data, suffix = "") => out.push({ ...(id ? { id: `${id}${suffix}` } : {}), type, data: { sessionID: sid, ...data } });

  switch (ev.type) {
    case "session.status": {
      const t = p.status?.type ?? p.type;
      if (t === "busy" || t === "working") add("session.execution.started", {});
      else if (t === "retry") {
        // A V1 retry status was itself "a live turn"; V2 retries inside an execution.
        add("session.execution.started", {}, "~run");
        add("session.retry.scheduled", {
          attempt: p.status?.attempt ?? 0,
          at: p.status?.next,
          error: { type: "provider.internal", message: p.status?.message ?? "" },
        });
      } else add("session.execution.succeeded", {});
      return out;
    }
    case "session.idle":
      add("session.execution.succeeded", {});
      return out;
    case "session.error": {
      const e = p.error ?? {};
      if (e.name === "MessageAbortedError") add("session.execution.interrupted", { reason: "user" });
      else {
        const type = e.name === "ProviderAuthError" ? "provider.auth" : e.name === "ContextOverflowError" ? "context.length" : "provider.internal";
        add("session.execution.failed", { error: { type, message: e.data?.message ?? e.message ?? "", ...(typeof e.data?.statusCode === "number" ? { status: e.data.statusCode } : {}) } });
      }
      return out;
    }
    case "message.part.updated": {
      const part = p.part ?? {};
      const mid = part.messageID ?? p.messageID;
      if (part.type === "tool") {
        const v2 = V1_TO_V2_TOOL[part.tool] ?? part.tool;
        const callID = part.callID ?? part.id;
        const status = part.state?.status;
        const input = part.state?.input ?? {};
        if (status === "completed" && (part.tool === "plan_enter" || part.tool === "plan_exit") && !planCalls.has(callID)) {
          planCalls.add(callID);
          add("session.agent.selected", { agent: part.tool === "plan_enter" ? "plan" : "build" }, "~plan");
        }
        add("session.tool.input.started", { assistantMessageID: mid, id: callID, name: v2 }, "~s");
        if (status === "pending" || status === "running") {
          add("session.tool.called", { assistantMessageID: mid, id: callID, input }, "~c");
          if (typeof part.state?.metadata?.sessionId === "string") {
            add("session.tool.progress", { assistantMessageID: mid, id: callID, metadata: { sessionID: part.state.metadata.sessionId, status: "running" } }, "~p");
          }
        } else if (status === "completed") {
          add("session.tool.called", { assistantMessageID: mid, id: callID, input }, "~c");
          add("session.tool.success", { assistantMessageID: mid, id: callID, content: [{ type: "text", text: String(part.state?.output ?? "") }], metadata: part.state?.metadata ?? {} }, "~ok");
        } else if (status === "error") {
          add("session.tool.called", { assistantMessageID: mid, id: callID, input }, "~c");
          add("session.tool.failed", { assistantMessageID: mid, id: callID, error: { type: "tool", message: String(part.state?.error ?? "") } }, "~err");
        }
        return out;
      }
      if (part.type === "step-finish") {
        add("session.step.ended", { assistantMessageID: mid, rawFinish: part.reason, finish: part.reason, cost: part.cost, tokens: part.tokens });
        return out;
      }
      add("session.text.ended", { assistantMessageID: mid, ordinal: 0, text: part.text ?? "" });
      return out;
    }
    case "message.updated": {
      add("session.text.ended", { assistantMessageID: p.messageID ?? p.info?.id, ordinal: 0, text: "" });
      return out;
    }
    case "message.part.removed":
    case "message.removed":
      add("session.text.ended", { assistantMessageID: p.messageID ?? p.part?.messageID ?? p.info?.id, ordinal: 0, text: "" });
      return out;
    case "message.part.delta":
      add("session.text.delta", { assistantMessageID: p.messageID, ordinal: 0, delta: p.delta });
      return out;
    case "session.next.step.ended":
      add("session.step.ended", { assistantMessageID: p.messageID, rawFinish: p.finish, finish: p.finish, cost: p.cost, tokens: p.tokens ?? p.usage });
      return out;
    case "session.next.agent.switched":
      add("session.agent.selected", { agent: p.agent });
      return out;
    case "session.created":
      out.push({ ...(id ? { id } : {}), type: "session.created", data: { sessionID: p.info?.id ?? sid, parentID: p.info?.parentID } });
      return out;
    case "permission.asked":
      add("permission.asked", { id: p.id, action: p.permission === "bash" ? "shell" : p.permission, resources: p.patterns ?? [], save: p.always ?? [] });
      return out;
    case "permission.replied":
    case "permission.rejected":
      add("permission.replied", { requestID: p.requestID ?? p.id, reply: p.reply });
      return out;
    case "question.asked":
      add("form.created", {
        form: {
          id: p.id,
          sessionID: sid,
          metadata: { kind: "question", ...(p.tool ? { tool: { messageID: p.tool.messageID, id: p.tool.callID } } : {}) },
          fields: (p.questions ?? []).map((q, i) => ({ key: `q${i}`, title: q.header ?? "", description: q.question ?? "", type: q.multiple ? "multiselect" : "string", options: (q.options ?? []).map((o) => ({ value: o.label, label: o.label, description: o.description })), custom: q.custom !== false })),
        },
      });
      return out;
    case "question.replied":
      add("form.replied", { id: p.requestID ?? p.id });
      return out;
    case "question.rejected":
      add("form.cancelled", { id: p.requestID ?? p.id });
      return out;
    case "session.next.compaction.started":
      add("session.compaction.started", { reason: p.reason });
      return out;
    case "session.next.compaction.delta":
      add("session.compaction.delta", { text: p.delta });
      return out;
    case "session.next.compaction.ended":
      add("session.compaction.ended", {});
      return out;
    default:
      return [ev];
  }
}

// Shared fixtures for the sticky-trims planner tests (spec §8): the pure planner
// (src/shared/maskPlan.test.ts), the V1 plugin's inlined copy
// (docs/opencode-plugins/manta-optimizer.test.ts) and the V2 port
// (scripts/opencode-v2/optimizer.test.mjs) all run the SAME scenarios built here,
// so a drift between the three copies shows up as a parity failure.
//
// One abstract history ("calls") renders into either plugin's message shape:
//   toV1 — opencode V1 [{info, parts}]   (one assistant message per tool call)
//   toV2 — the LOWERED V2 `context` hook shape, observed on opencode 2.0.30:
//          user/assistant messages carry an `id`; the `role:"tool"` message that
//          follows an assistant tool-call carries NONE.

export const PROVIDER = "anthropic";
export const MODEL = "claude-opus-5-5";
export const MODEL_KEY = `${PROVIDER}/${MODEL}`;

export const POLICY = Object.freeze({
  enabled: true,
  maskAfterUses: 2,
  batchTokens: 1000,
  margin: 1.5,
  protectTailTokens: 1000,
  placeholderFormat: "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: 4_000,
  transformBudgetMs: 25,
});

/** $/Mtok. Opus-like: a 25× write premium. */
export const PRICE_OPUS = Object.freeze({ input: 4, cacheRead: 0.2, cacheWrite: 5, source: "catalog" });
/** A provider with no write premium (cacheWrite missing → input). */
export const PRICE_NO_PREMIUM = Object.freeze({ input: 1, cacheRead: 0.1, source: "config" });

export const ratesOf = (record) => ({
  cacheRead: record.cacheRead,
  cacheWrite: record.cacheWrite ?? record.input,
  source: record.source,
  fetchedAt: 1,
});

export const emptyState = (over = {}) => ({
  version: 1,
  renderVersion: 1,
  real: {},
  shadow: {},
  reqCount: 0,
  nextGrowthAllowedAt: 0,
  shadowNextGrowthAllowedAt: 0,
  lastModel: null,
  updatedAt: 0,
  ...over,
});

/** n tool calls, each with an output of `outTokens` estimated tokens. */
export function calls(n, { outTokens = 2000, tool = "bash", from = 0 } = {}) {
  return Array.from({ length: n }, (_, j) => {
    const i = from + j;
    return { id: `call_${i}`, tool, input: { n: i }, output: "x".repeat(outTokens * 4) };
  });
}

export function toV1(list, { sessionID = "ses_fx", completedAt = 1_000, withId = true } = {}) {
  const msgs = [
    {
      info: { id: "msg_u0", sessionID, role: "user", time: { created: 1 }, model: { providerID: PROVIDER, modelID: MODEL } },
      parts: [{ type: "text", text: "do the thing" }],
    },
  ];
  list.forEach((c, i) => {
    msgs.push({
      info: {
        id: `msg_a${c.id}`,
        sessionID,
        role: "assistant",
        providerID: PROVIDER,
        modelID: MODEL,
        time: { created: 2 + i, completed: completedAt + i },
      },
      parts: [
        {
          type: "tool",
          ...(withId ? { callID: c.id } : {}),
          tool: c.tool,
          state: { status: "completed", input: c.input, output: c.output },
        },
      ],
    });
  });
  return msgs;
}

export function toV2(list) {
  const msgs = [{ id: "msg_u0", role: "user", content: [{ type: "text", text: "do the thing" }], metadata: {} }];
  for (const c of list) {
    msgs.push({
      id: `msg_a${c.id}`,
      role: "assistant",
      content: [{ type: "tool-call", id: c.id, name: c.tool, input: c.input, providerExecuted: false }],
    });
    msgs.push({
      role: "tool",
      content: [{ type: "tool-result", id: c.id, name: c.tool, result: { type: "text", value: c.output }, providerExecuted: false }],
    });
  }
  return msgs;
}

/** V1: apply a committed `real` map onto a history, the way the plugin does. */
export function applyV1(messages, real) {
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (p?.type === "tool" && p.state?.status === "completed" && typeof p.callID === "string" && Object.prototype.hasOwnProperty.call(real, p.callID)) {
        p.state.output = real[p.callID];
      }
    }
  }
}

/** The outputs the model would see, in order — for "history identical between requests" assertions. */
export const v1Outputs = (messages) => messages.flatMap((m) => (m.parts ?? []).filter((p) => p.type === "tool").map((p) => p.state.output));
export const v2Outputs = (messages) => messages.filter((m) => m.role === "tool").map((m) => m.content[0].result.value);

/** Boundary a plugin would have recorded after sending `messages` (V1 / V2). */
export const boundaryV1 = (messages) => ({ messageCount: messages.length, lastMessageKey: messages.at(-1).info.id });

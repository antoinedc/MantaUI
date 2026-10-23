// A scripted stand-in for the Anthropic Messages API, for smokes that need a
// running turn but not a real model (the key's monthly quota can be exhausted,
// and the V2 inbox / interrupt / command semantics under test are the real
// opencode binary's — only the model is faked).
//
// It answers `POST /v1/messages` with an SSE stream. What it says is a pure
// function of the conversation, so a test controls it through its prompts:
//   • "Run exactly this shell command and nothing else: CMD ." → a bash tool_use
//     (the REAL tool then runs CMD in the sandbox), until its tool_result exists;
//   • "Use the question tool to ask …" → a `question` tool_use;
//   • otherwise a text reply assembled from the user messages not yet answered:
//       "Reply with exactly[ these words]: X" → X, "also say the word W" → W,
//       "reply with the single word W" → W.
// Every request is recorded (`requests`). `delayMs` holds the first byte back so
// a turn is in flight long enough to be interrupted.

import { createServer } from "node:http";

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const textsOf = (m) =>
  typeof m.content === "string" ? [m.content] : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
const hasToolResult = (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result");
const hasToolUse = (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_use");
const hasText = (m) => textsOf(m).some((t) => t.trim());

/** What the "model" does for this request: `{kind:"tool", name, input}` | `{kind:"text", text}`. */
export function decide(body) {
  const msgs = body.messages ?? [];
  const toolNames = (body.tools ?? []).map((t) => t.name);
  const pick = (re) => toolNames.find((n) => re.test(n));

  // The last user text that asks for a tool, if no tool_result has followed it yet.
  let asked = null;
  for (let i = msgs.length - 1; i >= 0 && !asked; i--) {
    if (msgs[i].role !== "user" || hasToolResult(msgs[i])) continue;
    for (const t of textsOf(msgs[i])) {
      if (/Run exactly this shell command/.test(t) || /Use the question tool/.test(t)) asked = { i, t };
    }
  }
  if (asked) {
    const answered = msgs.slice(asked.i + 1).some(hasToolResult);
    if (!answered) {
      const cmd = asked.t.match(/nothing else:\s*([\s\S]*?)\s+\.\s+Then reply/);
      if (cmd) {
        const name = pick(/^(bash|shell)$/i);
        if (name) return { kind: "tool", name, input: { command: cmd[1], description: "smoke command" } };
      }
      if (/Use the question tool/.test(asked.t)) {
        const name = pick(/^question$/i);
        if (name) {
          return {
            kind: "tool",
            name,
            input: { questions: [{ question: "Which fruit do you prefer?", header: "Fruit", options: [{ label: "Apple", description: "red" }, { label: "Pear", description: "green" }] }] },
          };
        }
      }
    }
  }

  // Unanswered user texts: everything after the last assistant message that carried text.
  let from = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && hasText(msgs[i]) && !hasToolUse(msgs[i])) {
      from = i + 1;
      break;
    }
  }
  const parts = [];
  for (const m of msgs.slice(from)) {
    if (m.role !== "user") continue;
    for (const t of textsOf(m)) {
      const a = t.match(/Reply with exactly(?: these words)?:\s*(.+)$/im);
      if (a) parts.push(a[1].trim());
      const b = t.match(/also say the word (\w+)/i);
      if (b) parts.push(b[1]);
      const c = t.match(/reply with the single word (\w+)/i);
      if (c) parts.push(c[1]);
    }
  }
  return { kind: "text", text: parts.length ? parts.join(" ") : "ok" };
}

export async function startMockAnthropic({ delayMs = 0, log = () => {} } = {}) {
  const requests = [];
  const state = { delayMs };
  let n = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      /* not JSON */
    }
    if (req.method !== "POST" || !/\/v1\/messages$/.test(req.url.split("?")[0])) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `mock: ${req.method} ${req.url}` } }));
      return;
    }
    const d = decide(body);
    requests.push({ at: Date.now(), body, decision: d });
    log(`[mock] request ${requests.length} → ${d.kind === "tool" ? `tool ${d.name}` : `text "${d.text}"`}`);
    const id = `msg_mock${++n}`;
    const out = [];
    out.push(sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model ?? "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }));
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: d.kind === "text" ? [{ type: "text", text: d.text }] : [], stop_reason: "end_turn", usage: { input_tokens: 25, output_tokens: 5 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(out.join(""));
    if (state.delayMs) await sleep(state.delayMs);
    if (res.destroyed) return;
    if (d.kind === "tool") {
      const toolId = `toolu_mock${n}`;
      res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: d.name, input: {} } }));
      res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(d.input) } }));
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }));
    } else {
      res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d.text } }));
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }));
    }
    res.write(sse("message_stop", { type: "message_stop" }));
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setDelay: (ms) => (state.delayMs = ms),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

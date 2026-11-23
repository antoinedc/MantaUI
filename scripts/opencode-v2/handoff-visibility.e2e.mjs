#!/usr/bin/env node
// Probe for Agents Phase 2 §5 step 1 ("live invocation"), on the REAL pinned OpenCode V2 binary, no API spend.
//
//   node scripts/opencode-v2/handoff-visibility.e2e.mjs
//
// `agent_handoff` is only honoured when the box can see the lead's own LIVE call: the calling assistant message
// holds a tool part with the execute context's id, still `running`, whose input equals what the tool posted. This
// checks that, through the production client (src/server/opencode.mjs listMessages → mapTimeline), at the moment
// the tool's HTTP request reaches the server — with the manta plugin loaded and a scripted stand-in for the model.
//
// Asserts: the plugin forwards a call id; the running part is visible AT EXECUTE TIME with that id and the exact
// input; the calling assistant message has `parentID` (the turn key) and `agent`; the part is no longer `running`
// once the call has returned (so a replay of the same call cannot match).
//
// Agents Phase 4 adds `agent_change` to the same run: its input carries a NESTED `draft` object, and the server's binding
// check compares it field by field, so the running part must expose that object as the model sent it (an object, not a
// string; `agent` absent, not null).
//
// SAFETY: sandbox only (sandbox.mjs: own port, random password, own HOME/XDG). The live opencode (:4096) and
// manta-server (:8787) are never contacted.

import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const TOKEN = "ef12".repeat(8);
const INPUT = { agent: "dev", title: "Fix login", brief: "Fix the flaky login test. Done when green." };
const CHANGE_INPUT = {
  action: "create",
  draft: { name: "Reviewer", description: "Reviews code.", isolation: "none", instructions: "You review code.\nYou never edit files.", model: null },
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 600)}` : ""}`);
};
const j = (v) => JSON.stringify(v);

// the scripted "model": one agent_handoff call, then one agent_change call, then a closing line
const decideFn = (body) => {
  const answered = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "tool_result").length;
  const names = (body.tools ?? []).map((t) => t.name);
  const handoff = names.find((n) => /agent_handoff$/.test(n));
  const change = names.find((n) => /agent_change$/.test(n));
  if (answered === 0 && handoff) return { kind: "tool", name: handoff, input: INPUT };
  if (answered === 1 && change) return { kind: "tool", name: change, input: CHANGE_INPUT };
  return { kind: "text", text: "Handed off." };
};

let sb;
let box; // the fake manta-server
const seen = { handoff: [], reads: [], change: [], changeReads: [] };
const mock = await startMockAnthropic({ decideFn });
const oc = await import("../../src/server/opencode.mjs");

// A fake manta-server that, on the handoff POST, reads the transcript the way the real server will.
box = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url, "http://fake");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
  if (url.pathname === "/api/agents/lead-brief") return send(200, { text: "" });
  if (url.pathname === "/api/agents/handoff") {
    const body = JSON.parse(raw);
    seen.handoff.push(body);
    const messages = await oc.listMessages(body.sessionID, { limit: 200 });
    seen.reads.push({ at: "execute", messages });
    return send(200, { ok: true, jobId: "job00001", agentName: "Dev" });
  }
  if (url.pathname === "/api/agents/change") {
    const body = JSON.parse(raw);
    seen.change.push(body);
    seen.changeReads.push(await oc.listMessages(body.sessionID, { limit: 200 }));
    return send(200, { ok: true, change: { state: "applied", kind: "create", agentName: "Reviewer", slug: "reviewer" } });
  }
  send(404, { error: `no route ${url.pathname}` });
});
await new Promise((r) => box.listen(0, "127.0.0.1", r));

try {
  sb = await startSandbox({
    binary: await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) }),
    plugins: [PLUGIN_DIR],
    config: { provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } } },
    env: { ANTHROPIC_API_KEY: "mock", MANTA_SERVER_URL: `http://127.0.0.1:${box.address().port}`, MANTA_BOX_TOKEN: TOKEN },
  });
  process.env.MANTA_OPENCODE_PASSWORD = sb.password;
  oc._setApiBase(sb.url);

  const api = async (method, path, body) => {
    const res = await fetch(sb.url + path, { method, headers: { authorization: sb.auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const created = await api("POST", "/api/session", { location: { directory: sb.projectDir }, model: { providerID: "anthropic", id: "claude-haiku-4-5" } });
  const sessionID = created.data.id;
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "Hand the login fix to dev." });
  await Promise.race([api("POST", `/api/experimental/session/${sessionID}/wait`), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 60_000))]);

  check("the tool posted to the box", seen.handoff.length === 1, j(seen.handoff));
  const body = seen.handoff[0] ?? {};
  check("the plugin forwarded the call id (execute context `id`)", typeof body.callID === "string" && body.callID !== "", j(body));
  check("the plugin forwarded the assistant message id", typeof body.messageID === "string" && body.messageID.startsWith("msg_"), j(body));
  check("session id and arguments are the model's", body.sessionID === sessionID && body.agent === INPUT.agent && body.title === INPUT.title && body.brief === INPUT.brief, j(body));

  const atExecute = seen.reads[0]?.messages ?? [];
  const msg = atExecute.find((m) => m?.info?.id === body.messageID);
  check("AT EXECUTE TIME the calling assistant message is listed", !!msg && msg.info.role === "assistant", j(atExecute.map((m) => m.info)));
  const part = (msg?.parts ?? []).find((p) => p.type === "tool" && p.tool === "agent_handoff" && p.callID === body.callID);
  check("AT EXECUTE TIME the tool part with that call id is visible", !!part, j(msg?.parts));
  check("…and it is still `running`", part?.state?.status === "running", j(part?.state));
  check("…and its input equals the posted body", !!part && part.state.input.agent === body.agent && part.state.input.title === body.title && part.state.input.brief === body.brief, j(part?.state?.input));
  check("the message carries `parentID` (the turn key: the user message that started the turn)", typeof msg?.info?.parentID === "string" && atExecute.some((m) => m.info.id === msg.info.parentID && m.info.role === "user"), j(msg?.info));
  check("the message carries `agent` (the mode the plan gate reads)", typeof msg?.info?.agent === "string" && msg.info.agent !== "", j(msg?.info));
  console.log(`  [info] assistant message info at execute: ${j(msg?.info)}`);

  const after = await oc.listMessages(sessionID, { limit: 200 });
  const donePart = after.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool" && p.tool === "agent_handoff" && p.callID === body.callID);
  check("after the call returned the part is no longer `running` (a replay cannot match it)", !!donePart && donePart.state.status !== "running", j(donePart?.state?.status));
  check("the tool's result text reached the model", mock.requests.some((r) => JSON.stringify(r.body.messages).includes("Handed to Dev (job job00001)")), "");

  // ---- agent_change: the nested draft ----
  check("agent_change posted to the box once", seen.change.length === 1, j(seen.change));
  const cbody = seen.change[0] ?? {};
  check("the plugin forwarded the call identity and the model's arguments", cbody.sessionID === sessionID && typeof cbody.callID === "string" && cbody.callID !== "" && typeof cbody.messageID === "string" && cbody.action === "create", j(cbody));
  check("the posted draft is the model's nested object, field for field", isDeepStrictEqual(cbody.draft, CHANGE_INPUT.draft), j(cbody.draft));
  check("`agent` was not sent (omitted stays omitted)", !Object.hasOwn(cbody, "agent"), j(cbody));
  const cmsg = (seen.changeReads[0] ?? []).find((m) => m?.info?.id === cbody.messageID);
  const cpart = (cmsg?.parts ?? []).find((p) => p.type === "tool" && p.tool === "agent_change" && p.callID === cbody.callID);
  check("AT EXECUTE TIME the agent_change part is visible and still `running`", cpart?.state?.status === "running", j(cmsg?.parts));
  check("…its input carries the nested draft as an OBJECT, equal to what the tool posted", !!cpart && typeof cpart.state.input.draft === "object" && isDeepStrictEqual(cpart.state.input.draft, cbody.draft), j(cpart?.state?.input));
  check("…with exactly the model's keys (action + draft: no agent, nothing added)", !!cpart && isDeepStrictEqual(Object.keys(cpart.state.input).sort(), ["action", "draft"]), j(cpart?.state?.input));
  check("…and `null` stays null (omitted is not null)", !!cpart && cpart.state.input.draft.model === null && Object.hasOwn(cpart.state.input.draft, "model"), j(cpart?.state?.input));
  const cafter = (await oc.listMessages(sessionID, { limit: 200 })).flatMap((m) => m.parts ?? []).find((p) => p.type === "tool" && p.tool === "agent_change" && p.callID === cbody.callID);
  check("after the call returned the agent_change part is no longer `running`", !!cafter && cafter.state.status !== "running", j(cafter?.state?.status));
  check("the agent_change result text reached the model", mock.requests.some((r) => JSON.stringify(r.body.messages).includes("Created Reviewer (@reviewer)")), "");
} catch (e) {
  check("probe ran to completion", false, e?.stack ?? String(e));
} finally {
  await sb?.stop();
  await mock.close();
  await new Promise((r) => box.close(() => r()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

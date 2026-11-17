#!/usr/bin/env node
// Shared-knowledge spike (spec 2026-11-16 §0). Sandbox + mock Anthropic; no paid calls.
//   node docs/opencode-v2/spikes/knowledge/run.mjs
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "../../../../scripts/opencode-v2/fetch-binary.mjs";
import { startSandbox } from "../../../../scripts/opencode-v2/sandbox.mjs";
import { startMockAnthropic } from "../../../../scripts/opencode-v2/mock-anthropic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-haiku-4-5";
const scratch = mkdtempSync(join(tmpdir(), "manta-knowledge-spike-"));
const LOG = join(scratch, "probe.jsonl");
writeFileSync(LOG, "");

const skill = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}.\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = await startMockAnthropic();
const sb = await startSandbox({
  binary: await ensureBinary({ log: console.log }),
  plugins: [{ src: join(HERE, "knowledge-probe.ts"), name: "knowledge-probe.ts" }],
  config: { provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } } },
  env: { ANTHROPIC_API_KEY: "mock", KNOW_LOG: LOG },
  files: [
    { path: "xdg/config/opencode/AGENTS.md", content: "GLOBAL_AGENTS_V1_marker_aa11\n" },
    { path: "xdg/config/opencode/skills/alpha-skill/SKILL.md", content: skill("alpha-skill", "SKILL_ALPHA_desc_aa11") },
  ],
});
const cfg = join(sb.root, "xdg", "config", "opencode");
const api = async (method, path, body) => {
  const res = await fetch(sb.url + path, { method, headers: { authorization: sb.auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
};
const mk = (extra = {}) => api("POST", "/api/session", { location: { directory: sb.projectDir }, model: { providerID: "anthropic", id: MODEL }, ...extra }).then((r) => r.data.id);
const turn = async (sid, text) => {
  const from = mock.requests.length;
  await api("POST", `/api/session/${sid}/prompt`, { text });
  await api("POST", `/api/experimental/session/${sid}/wait`);
  await sleep(500); // let title/other side requests land
  return mock.requests.slice(from);
};
const flat = (b) => JSON.stringify(b);
const has = (reqs, s) => reqs.map((r) => flat(r.body).includes(s));
const sysText = (b) => (Array.isArray(b.system) ? b.system.map((s) => s.text ?? "").join("\n") : String(b.system ?? ""));
const where = (b, s) => [JSON.stringify(b.system ?? "").includes(s) && "system", (b.tools ?? []).some((t) => JSON.stringify(t).includes(s)) && "tools", JSON.stringify(b.messages ?? []).includes(s) && "messages"].filter(Boolean);
const summ = (reqs) => reqs.map((r) => ({ systemBlocks: Array.isArray(r.body.system) ? r.body.system.length : 1, tools: (r.body.tools ?? []).length, msgs: (r.body.messages ?? []).length, asyncMarker: where(r.body, "SPIKE_ASYNC_MARKER_7f3a"), agentsV1: where(r.body, "GLOBAL_AGENTS_V1_marker_aa11"), agentsV2: where(r.body, "GLOBAL_AGENTS_V2_marker_bb22"), skillAlpha: where(r.body, "SKILL_ALPHA_desc_aa11"), skillBeta: where(r.body, "SKILL_BETA_desc_bb22") }));
const out = { binary: (await api("GET", "/api/plugin")).data?.map((p) => [p.id, p.state?.status]) };

try {
  // ---- Q1 + Q2 + Q3 phase 1
  const A = await mk();
  const r1 = await turn(A, "Reply with exactly these words: one");
  const mainReq = (rs) => rs.filter((r) => (r.body.tools ?? []).length > 0 || sysText(r.body).includes("GLOBAL_AGENTS"));
  out.phase1 = summ(r1);
  const q1Req = mainReq(r1)[0] ?? r1[0];
  out.q1SystemTail = sysText(q1Req.body).slice(-160);

  // ---- change files, same session
  writeFileSync(join(cfg, "AGENTS.md"), "GLOBAL_AGENTS_V2_marker_bb22\n");
  mkdirSync(join(cfg, "skills", "beta-skill"), { recursive: true });
  writeFileSync(join(cfg, "skills", "beta-skill", "SKILL.md"), skill("beta-skill", "SKILL_BETA_desc_bb22"));
  const r2 = await turn(A, "Reply with exactly these words: two");
  out.phase2_sameSession = summ(r2);

  // ---- same session again after a delay (file watcher / TTL?)
  await sleep(5000);
  const r2b = await turn(A, "Reply with exactly these words: two-b");
  out.phase2b_sameSession_after5s = summ(r2b);
  // ---- same session after an explicit compaction
  try {
    await api("POST", `/api/session/${A}/compact`, {});
    await api("POST", `/api/experimental/session/${A}/wait`);
    await sleep(500);
    const from = mock.requests.length;
    const r2c = await turn(A, "Reply with exactly these words: two-c");
    out.phase2c_sameSession_after_compact = summ(r2c);
  } catch (e) { out.phase2c_error = String(e.message).slice(0, 300); }

  // ---- new session
  const B = await mk();
  const r3 = await turn(B, "Reply with exactly these words: three");
  out.phase3_newSession = summ(r3);

  // ---- child session (parentID) for Q2 field coverage
  let childId = null;
  try { childId = await mk({ parentID: A }); } catch (e) { out.childCreateError = String(e.message).slice(0, 200); }
  out.childId = childId;
  await sleep(800);

  // ---- when does a changed AGENTS.md reach an EXISTING session? write v3, then prompt after growing delays
  writeFileSync(join(cfg, "AGENTS.md"), "GLOBAL_AGENTS_V3_marker_cc33\n");
  const tWrite = Date.now();
  out.phase4_timing = [];
  for (const gap of [0, 500, 1000, 2000, 4000]) {
    await sleep(gap);
    const rq = await turn(A, "Reply with exactly these words: timing");
    const main = rq.find((q) => (q.body.tools ?? []).length > 0) ?? rq[0];
    out.phase4_timing.push({ sinceWriteMs: Date.now() - tWrite, sawV3: where(main.body, "GLOBAL_AGENTS_V3_marker_cc33") });
    if (out.phase4_timing.at(-1).sawV3.length) {
      const m = JSON.stringify(main.body.messages);
      const i = m.indexOf("GLOBAL_AGENTS_V3_marker_cc33");
      out.phase4_v3_message_excerpt = m.slice(Math.max(0, i - 400), i + 120);
      break;
    }
  }
} finally {
  const probe = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  out.probe = probe.filter((p) => p.what !== "event.other");
  out.eventOtherTypes = [...new Set(probe.filter((p) => p.what === "event.other").map((p) => p.type))];
  console.log(JSON.stringify(out, null, 2));
  writeFileSync(join(HERE, "last-run.json"), JSON.stringify(out, null, 2));
  await sb.stop();
  await mock.close();
}

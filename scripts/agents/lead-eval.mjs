#!/usr/bin/env node
// Routing evaluation for the lead (Agents Phase 2 spec §10). Not part of `npm test`: it asks a model, so it costs a
// few cents. Run it ON THE BOX (it talks to the box's own opencode, read-only) before merging, and again after any
// change to the lead's instructions (src/server/agentTemplates/manta/agent.md, buildLeadBrief in src/server/agents.mjs).
//
//   node scripts/agents/lead-eval.mjs                      # a cheap connected model is picked automatically
//   node scripts/agents/lead-eval.mjs --model anthropic/claude-haiku-5-5
//   node scripts/agents/lead-eval.mjs --print-brief dev,seo   # show the lead brief for a team and stop (no model call)
//
// For each case in docs/agents/lead-routing-eval.jsonl ({message, team, expect}) the model is shown the real lead brief
// (the lead's own instructions + the roster of `team` + the autonomy rules + the handoff mechanics) and the user's
// message, and answers with JSON {action: "answer" | "handoff" | "ask", agent?}. A one-shot text generation: no tools run,
// nothing is changed. Prints accuracy, MISSED handoffs (should have handed off, did not) and NEEDLESS handoffs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLeadBrief, parseAgentMd } from "../../src/server/agents.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASES = join(ROOT, "docs", "agents", "lead-routing-eval.jsonl");
const TEMPLATES = join(ROOT, "src", "server", "agentTemplates");
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// The fixed team: the shipped Dev, and a read-only SEO agent like the one a user would create.
function teamInfo(slug) {
  if (slug === "dev") {
    const p = parseAgentMd(readFileSync(join(TEMPLATES, "dev", "agent.md"), "utf-8"));
    return { slug, ...p.meta };
  }
  if (slug === "seo") {
    return {
      slug,
      name: "SEO",
      description: "Audits pages, copy and metadata for search and AI-search visibility and recommends concrete fixes.",
      isolation: "none",
      useWhen: "Audits and reviews of pages, titles, metadata, sitemaps and content for search visibility.",
      notFor: "Changing code.",
    };
  }
  throw new Error(`unknown team member ${slug}`);
}

const lead = parseAgentMd(readFileSync(join(TEMPLATES, "manta", "agent.md"), "utf-8"));
if (!lead.ok) throw new Error(`the Manta template does not parse: ${lead.error}`);
const briefFor = (team) => buildLeadBrief({ body: lead.body, roster: team.map(teamInfo) });

if (flag("--print-brief") !== undefined) {
  console.log(briefFor(flag("--print-brief").split(",").filter(Boolean)));
  process.exit(failedCalls > 0 ? 1 : 0);
}

const oc = await import("../../src/server/opencode.mjs");

async function pickModel() {
  const named = flag("--model") ?? process.env.LEAD_EVAL_MODEL;
  if (named) {
    const i = named.indexOf("/");
    if (i <= 0) throw new Error('--model must look like "provider/model"');
    return { providerID: named.slice(0, i), id: named.slice(i + 1) };
  }
  // Free tiers are rate-limited (a run would fail halfway) and aggregator credit comes and goes: prefer a priced model
  // from a first-party provider, cheapest first.
  const models = (await oc.listModels()).filter((m) => (m.status ?? "active") === "active" && m.enabled !== false && m.cost?.input > 0 && !/free/i.test(m.id));
  const firstParty = models.filter((m) => m.providerID === "anthropic" || m.providerID === "openai");
  const cheap = (firstParty.length > 0 ? firstParty : models).filter((m) => /haiku|mini|flash|nano|lite|small/i.test(`${m.id} ${m.name}`));
  const pool = (cheap.length > 0 ? cheap : firstParty.length > 0 ? firstParty : models).filter((m) => Number.isFinite(m.cost?.input));
  pool.sort((a, b) => a.cost.input - b.cost.input);
  if (!pool[0]) throw new Error("no connected model with a known price; pass --model provider/model");
  return { providerID: pool[0].providerID, id: pool[0].id };
}

const cases = readFileSync(CASES, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const instruction = (team, message) =>
  [
    "The text between the markers is the system prompt you run under as the lead of a chat.",
    "<<<SYSTEM PROMPT",
    briefFor(team).trim(),
    "SYSTEM PROMPT>>>",
    "",
    "The user just wrote:",
    "<<<MESSAGE",
    message,
    "MESSAGE>>>",
    "",
    "Decide what you do FIRST, following your instructions exactly:",
    '- "answer": you answer, do the work yourself (questions, explanations, plans, small reads, small edits, or nothing on your team fits).',
    '- "handoff": you call agent_handoff for the one teammate it matches (give "agent": its slug without the @).',
    '- "ask": you must ask the user before doing anything.',
    'Reply with ONLY a JSON object, e.g. {"action":"handoff","agent":"dev"} — no other text.',
  ].join("\n");

function parseDecision(text) {
  const m = /\{[\s\S]*?\}/.exec(String(text ?? ""));
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    if (!["answer", "handoff", "ask"].includes(d?.action)) return null;
    return { action: d.action, agent: typeof d.agent === "string" ? d.agent.replace(/^@/, "").toLowerCase() : undefined };
  } catch {
    return null;
  }
}

const model = await pickModel();
console.log(`lead routing eval — ${cases.length} cases on ${model.providerID}/${model.id}`);

const rows = new Array(cases.length);
let next = 0;
async function worker() {
  while (next < cases.length) {
    const i = next++;
    const c = cases[i];
    let reply = "";
    try {
      reply = await oc.generateTextStrict({ instruction: instruction(c.team, c.message), model });
    } catch (e) {
      reply = "";
      rows[i] = { c, got: null, error: String(e?.message ?? e) };
      continue;
    }
    rows[i] = { c, got: parseDecision(reply), reply };
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));

const label = (d) => (d ? (d.action === "handoff" ? `handoff:${d.agent ?? "?"}` : d.action) : "unparseable");
let correct = 0;
const missed = [];
const needless = [];
const other = [];
for (const r of rows) {
  const got = label(r.got);
  const ok = got === r.c.expect;
  if (ok) correct++;
  else if (r.c.expect.startsWith("handoff:") && !got.startsWith("handoff:")) missed.push(r);
  else if (!r.c.expect.startsWith("handoff:") && got.startsWith("handoff:")) needless.push(r);
  else other.push(r);
  console.log(`${ok ? "  ok  " : " MISS "} expect ${r.c.expect.padEnd(11)} got ${got.padEnd(11)} ${r.c.message.slice(0, 80)}${r.error ? `  [error: ${r.error}]` : ""}`);
}
const pct = (n) => `${Math.round((n / cases.length) * 100)}%`;
const failedCalls = rows.filter((r) => r.error).length;
if (failedCalls > 0) {
  console.log(`\n${failedCalls} of ${cases.length} model calls FAILED — the numbers below are not a measurement. Fix the model / quota and run again.`);
}
console.log(`\naccuracy: ${correct}/${cases.length} (${pct(correct)})`);
console.log(`missed handoffs (should hand off, did not): ${missed.length}`);
console.log(`needless handoffs (handed off when none was expected): ${needless.length}`);
console.log(`other mismatches (wrong agent for a handoff, ask vs answer): ${other.length}`);
process.exit(failedCalls > 0 ? 1 : 0);

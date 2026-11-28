#!/usr/bin/env node
// Opt-in, NOT run by CI: re-labels the similarity fixture with a live model and records the answers in src/server/fixtures/briefLabels.json,
// which src/server/briefLabel.test.mjs replays offline. Uses only the session-less one-shot route of the box's opencode
// (POST /api/experimental/generate): it creates no session and prompts none.
//
//   OPENCODE_PASSWORD=… node scripts/research/label-fixture.mjs --model openai/gpt-6-luna [--passes 2] [--out file] [--url http://127.0.0.1:4096]
//
// The briefs are labelled one after the other, the way the box does it: each call is offered the labels already coined in the pass, most
// used first. Pass 1 uses the fixture's order; later passes use a seeded shuffle, so the order effect is part of what is measured.
// A brief whose call fails twice gets no label (and the test then fails on the gap).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLabelPrompt, parseLabel, labelKey, LABEL_PROMPT_VERSION, EXISTING_LABELS_MAX } from "../../src/server/briefLabel.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const fixturePath = fileURLToPath(new URL("../../src/server/fixtures/briefSimilarity.json", import.meta.url));
const outPath = arg("out", fileURLToPath(new URL("../../src/server/fixtures/briefLabels.json", import.meta.url)));
const model = arg("model", "");
const passes = Math.max(1, Number(arg("passes", "2")) || 2);
const base = (arg("url", process.env.OPENCODE_URL || "http://127.0.0.1:4096") || "").replace(/\/+$/, "");
const password = process.env.OPENCODE_PASSWORD || "";
if (!model.includes("/") || !password) {
  console.error("usage: OPENCODE_PASSWORD=… node scripts/research/label-fixture.mjs --model <provider>/<model> [--passes N] [--out file] [--url URL]");
  process.exit(2);
}
const [providerID, ...rest] = model.split("/");

async function generate(prompt) {
  const res = await fetch(`${base}/api/experimental/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    body: JSON.stringify({ prompt, model: { providerID, id: rest.join("/") } }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  const body = JSON.parse(text);
  return typeof body?.data?.text === "string" ? body.data.text : typeof body?.text === "string" ? body.text : "";
}

function shuffled(items, seed) {
  const a = [...items];
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const briefs = fixture.pairs.flatMap((p) => [
  { id: `${p.id}.a`, ...p.a },
  { id: `${p.id}.b`, ...p.b },
]);

const record = { version: 1, promptVersion: LABEL_PROMPT_VERSION, model, recordedAt: new Date().toISOString(), passes: [] };
for (let n = 0; n < passes; n++) {
  const order = n === 0 ? briefs : shuffled(briefs, 1000 + n);
  const counts = new Map(); // key → { label, count, last }
  const labels = {};
  const failed = [];
  let tick = 0;
  for (const b of order) {
    const existing = [...counts.values()].sort((x, y) => y.count - x.count || y.last - x.last).slice(0, EXISTING_LABELS_MAX).map((e) => e.label);
    let label = null;
    for (let attempt = 0; attempt < 2 && !label; attempt++) {
      try {
        label = parseLabel(await generate(buildLabelPrompt({ title: b.title, brief: b.brief, existing })));
      } catch (e) {
        console.error(`  ${b.id}: ${e.message}`);
      }
    }
    if (!label) {
      failed.push(b.id);
      continue;
    }
    labels[b.id] = label;
    const key = labelKey(label);
    const hit = counts.get(key);
    counts.set(key, { label: hit?.label ?? label, count: (hit?.count ?? 0) + 1, last: tick++ });
    process.stderr.write(".");
  }
  process.stderr.write(`\npass ${n + 1}: ${Object.keys(labels).length}/${briefs.length} labelled, ${counts.size} distinct labels, ${failed.length} failed\n`);
  record.passes.push({ order: order.map((b) => b.id), labels, failed });
}
writeFileSync(outPath, `${JSON.stringify(record, null, 1)}\n`);
console.error(`wrote ${outPath}`);

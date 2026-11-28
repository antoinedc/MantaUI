// The closed set of places that write a message into an opencode session
// (spec §6.1: "a source test fails if a sendPrompt call site does not go
// through the resolver"). Same idea as commandOrigins.test.mjs's closed set of
// /prompt writers, one level up: a NEW writer must either be routed through the
// handoff engine's admission seam (admitPrompt / admitSynthetic / guardCommand)
// or be added to the table below with the reason it can never target a
// conversation a handoff replaces or fences.
//
// A message that bypasses the resolver is not a cosmetic bug: it lands in a
// replaced predecessor nobody is looking at, or overtakes a held message.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "fixtures" || name === "node_modules") continue;
      yield* walk(p);
    } else if (name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "testWorld.mjs") yield p;
  }
}

// A raw write: the opencode client's prompt / command / synthetic calls, a
// default-wired alias of them, or the delegate's child-prompt seams.
const RAW = /\boc\.(?:sendPrompt|runCommand|postSynthetic)\b|\bocSendPrompt\b|\bsendChildPrompt\(|\brunCommandOnChild\(/;

/** file → { count of raw sites, why they are safe } */
const EXEMPT = {
  "opencode.mjs": { count: 0, why: "the client itself (definitions only)" },
  "handoff/engine.mjs": { count: 1, why: "the engine's own poster: it posts to targets it already resolved/fenced/claimed" },
  "handoff/wiring.mjs": { count: 2, why: "adapter handing the raw client to the engine" },
  "delegate.mjs": { count: 3, why: "the opening prompt / command of a child session created seconds earlier — nothing can replace or fence it yet; and the answer to a task's question steered into the task's RUNNING child (`deliverToTask`): a child with a handoff pending is never steered into (it waits for the round to end, deferSettlement), and the record points at the live child" },
  "rpc.mjs": { count: 5, why: "forge ship-preview's own throwaway session; the user send + command paths each run behind handoff.admitPrompt / handoff.guardCommand (asserted below), the raw fallback is only for an engine-less test build" },
  "index.mjs": { count: 6, why: "CTO conversation admission (a role session, never handed off), a delegate child's opening prompt, the CTO runner's own sessions, and the knowledge skill trial's session client (a headless session the trial creates itself, marked manta.knowledgeTrial and never auto-handed-off)" },
  "routines.mjs": { count: 3, why: "a routine run's own headless session (opening prompt, the one missing-report re-prompt, a crash-recovery resend): created by the engine, marked manta.routineId, and never auto-handed-off (maybeAuto skips it)" },
  "knowledge/trial.mjs": { count: 1, why: "the skill trial's opening prompt to a headless session it created seconds earlier, marked manta.knowledgeTrial; maybeAuto skips it and nothing can replace or fence it" },
  "agentTrials.mjs": { count: 1, why: "an Architect trial case's opening prompt to a headless session it created seconds earlier, marked manta.agentTrial; maybeAuto skips it and nothing can replace or fence it" },
  "peers.mjs": { count: 1, why: "default dep; production injects promptDelivery.deliver (asserted below)" },
  "capNotifier.mjs": { count: 1, why: "default dep; production injects promptDelivery.deliver (asserted below)" },
  "forge/index.mjs": { count: 2, why: "forge ship-preview's own freshly created session" },
};

test("every raw session-write call site is accounted for (a new one must go through the handoff admission seam)", () => {
  const seen = {};
  for (const file of walk(SERVER_DIR)) {
    const rel = relative(SERVER_DIR, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        if (RAW.test(code)) seen[rel] = (seen[rel] ?? 0) + 1;
      });
  }
  const problems = [];
  for (const [rel, n] of Object.entries(seen)) {
    const want = EXEMPT[rel];
    if (!want) problems.push(`${rel}: ${n} raw session write(s) outside the admission seam — route them through handoffEngine.admitPrompt/admitSynthetic/guardCommand (src/server/handoff) or list the file here with the reason it is safe`);
    else if (want.count !== n) problems.push(`${rel}: expected ${want.count} raw call site(s), found ${n} — a call site was added or removed; re-check it against the resolver (${want.why})`);
  }
  for (const [rel, want] of Object.entries(EXEMPT)) if (want.count > 0 && !seen[rel]) problems.push(`${rel}: listed with ${want.count} raw site(s) but none found — update the table`);
  assert.deepEqual(problems, []);
});

const read = (rel) => readFileSync(join(SERVER_DIR, rel), "utf8");

test("the senders that DO reach a session are wired through the resolver in index.mjs", () => {
  const index = read("index.mjs");
  // promptDelivery: the resolver + the admission-aware send
  assert.match(index, /createPromptDelivery\(\{[^}]*sendPrompt: \(args\) => handoffEngine\.admitPrompt\(args\),\s*resolveTarget: \(sid\) => handoffEngine\.resolveAdmissionTarget\(sid\)/s);
  // the raw webhook dep never bypasses it either
  assert.match(index, /createWebhookEngine\(\{\s*sendPrompt: \(args\) => handoffEngine\.admitPrompt\(args\)/);
  // delegate results (N7 synthetics) are admissions too
  assert.match(index, /postSynthetic: \(sid, body\) => handoffEngine\.admitSynthetic\(sid, body\)/);
  // schedule, peers, cap notifier, spawn-and-deliver all go through promptDelivery.deliver
  assert.equal((index.match(/sendPrompt: \(args\) => promptDelivery\.deliver\(args\)/g) ?? []).length, 3, "schedule x2 (boot + resume) and peers");
  assert.match(index, /notifyCapSession\(args, \{ deliver: promptDelivery\.deliver \}\)/);
});

test("promptDelivery resolves before the redirect/busy check, and again at drain time", () => {
  const pd = read("promptDelivery.mjs");
  const deliver = pd.slice(pd.indexOf("async function deliver("));
  assert.ok(deliver.indexOf("resolveTarget(") > 0 && deliver.indexOf("resolveTarget(") < deliver.indexOf("if (redirect)"), "resolve is the first thing deliver does");
  const drain = pd.slice(pd.indexOf("async function drain("), pd.indexOf("function forget("));
  assert.match(drain, /resolveTarget\(sessionId\)/, "a queued item is re-resolved when it is finally sent");
});

test("the client send and command rpc handlers run the resolver before anything else", () => {
  const rpc = read("rpc.mjs");
  assert.match(rpc, /const result = handoff && userInput \? await handoff\.admitPrompt\(userInput\) : await oc\.sendPrompt\(userInput\);/);
  assert.match(rpc, /const \{ appGenerated, \.\.\.clientInput \} = input \?\? \{\};\s*const userInput = input && \{ \.\.\.clientInput, origin: appGenerated === true \? "unknown" : "user" \};/, "the user origin is set server-side, after the client's fields; a client can only lower it");
  assert.match(rpc, /if \(handoff && input\) input = \{ \.\.\.input, sessionId: handoff\.guardCommand\(input\.sessionId\)\.target \};/);
  const cmd = rpc.slice(rpc.indexOf('"opencode:run-command"'));
  assert.ok(cmd.indexOf("handoff.guardCommand(") < cmd.indexOf("runBackgroundCommand(input)"), "the guard precedes the background-run branch");
  assert.ok(cmd.indexOf("handoff.guardCommand(") < cmd.indexOf("oc.runCommand("), "…and the direct run");
});

// Every place that can STAMP a prompt as user-authored: an `origin` field/argument that can evaluate to "user"
// (plain, ternary or any expression on the same line). Evidence for rules and preferences rests on these, so a new
// one must be a deliberate decision made here.
const USER_ORIGIN_SITES = {
  "rpc.mjs": { count: 1, why: "the opencode:prompt handler: the one place a client's send becomes user-authored (a client can only lower it)" },
  "ctoAdmission.mjs": { count: 1, why: "the CTO conversation's dispatch: a HUMAN-origin submission (typed by the user in the CTO conversation, the origin set by the admission engine itself) is user-authored; background submissions are never" },
};

test("only the allow-listed sites stamp a prompt origin of user (shared-knowledge §9.2)", () => {
  const seen = {};
  for (const file of walk(SERVER_DIR)) {
    const rel = relative(SERVER_DIR, file);
    if (/\.test\.mjs$/.test(rel) || rel === "promptOrigins.mjs") continue;
    const text = readFileSync(file, "utf8");
    if (!/sendPrompt|admitPrompt|promptOrigins/.test(text)) continue; // unrelated `origin` fields (artifact links, handoff origins)
    text.split("\n").forEach((line) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      // an `origin:` property whose value can be the "user" literal: `origin: "user"`, `origin: cond ? "user" : …`
      if (/\borigin:\s*[^,}]*["']user["']/.test(code)) seen[rel] = (seen[rel] ?? 0) + 1;
    });
  }
  const problems = [];
  for (const [rel, n] of Object.entries(seen)) {
    const want = USER_ORIGIN_SITES[rel];
    if (!want) problems.push(`${rel}: ${n} site(s) that can stamp a prompt origin of "user" — only the opencode:prompt handler and the CTO admission may; add it to USER_ORIGIN_SITES with the reason only if it is truly user-typed`);
    else if (want.count !== n) problems.push(`${rel}: expected ${want.count} stamping site(s), found ${n} (${want.why})`);
  }
  for (const rel of Object.keys(USER_ORIGIN_SITES)) if (!seen[rel]) problems.push(`${rel}: listed but no stamping site found — update the table`);
  assert.deepEqual(problems, []);
  assert.match(read("ctoAdmission.mjs"), /origin: claimed\.origin === "human" \? "user" : undefined/, "admission stamps user only for a human submission");
});

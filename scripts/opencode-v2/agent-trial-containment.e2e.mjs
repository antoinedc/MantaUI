#!/usr/bin/env node
// Probe for the Architect v2 trial containment (docs/superpowers/specs/2026-11-27-architect-v2.md §3.3), on the REAL pinned OpenCode
// V2 binary, no API spend.
//
//   node scripts/opencode-v2/agent-trial-containment.e2e.mjs
//
// A trial's session is created with the REAL `buildTrialRuleset` through the production client, under a temporary agent block that
// is `mode: "primary"` with `permission: { "*": "deny" }` (what agentTrials.mjs writes). A scripted stand-in for the model issues one
// tool call per request; the REAL tools run in a sandbox with a fake home.
//
// Asserts: the session ruleset still grants what the block denies (the block's catch-all deny does not win over it); no shell (any
// command, even `ls`); reads and edits inside the case's folder work for the right isolation; a read of a secret by absolute path,
// by `..`, and of the sibling state folder is refused; the draft's own folder is readable and never writable; `.git/config` is never
// written; and a primary-mode block does not appear in the `task` tool's list of agents (the subagent list).
//
// SAFETY: sandbox only (sandbox.mjs: own port, random password, own HOME/XDG). The live opencode (:4096) and manta-server (:8787) are
// never contacted.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";
import { DENIAL_TEXT_RE } from "../../src/server/autonomy.mjs";
import { buildTrialRuleset, TRIAL_BLOCK_DESCRIPTION } from "../../src/server/agentTrials.mjs";
import { mintSessionId } from "../../src/server/delegate.mjs";
import { MODES } from "../../src/shared/autonomyShared.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 700)}` : ""}`);
};

let SCRIPT = [];
let bodies = [];
const decideFn = (body) => {
  bodies.push(body);
  let step = 0;
  for (const m of body.messages ?? []) if (Array.isArray(m.content)) step += m.content.filter((c) => c.type === "tool_result").length;
  const call = SCRIPT[step];
  if (!call) return { kind: "text", text: "done" };
  const name = (body.tools ?? []).map((t) => t.name).find((n) => call.re.test(n));
  if (!name) return { kind: "text", text: `no tool ${call.re}` };
  return { kind: "tool", name, input: call.input };
};

const mock = await startMockAnthropic({ decideFn });
const oc = await import("../../src/server/opencode.mjs");
let sb;
const files = [];
try {
  const sbConfig = { provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } }, agent: {} };
  sb = await startSandbox({
    binary: await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) }),
    config: sbConfig,
    onRoot: () => {
      sbConfig.agent["agent-trial-tr_aa"] = { mode: "primary", description: TRIAL_BLOCK_DESCRIPTION, prompt: "You are a trial probe.", permission: { "*": "deny" } };
      // a control: a block in subagent mode must show up in that list, or the check below would prove nothing
      sbConfig.agent["agent-control-sub"] = { mode: "subagent", description: "Control probe agent", prompt: "x", permission: { "*": "deny" } };
      sbConfig.agent["agent-trial-tr_bb"] = { mode: "primary", description: TRIAL_BLOCK_DESCRIPTION, prompt: "You are a trial probe.", permission: { "*": "deny" } };
      files.push({ path: "home/.manta/agents/.trials/tr_aa/agent/skills/x/SKILL.md", content: "DRAFT-FOLDER-OK\n" });
      files.push({ path: "home/.manta/agents/.trials/tr_aa/state.json", content: '{"state":"STATE-SECRET"}\n' });
      files.push({ path: "home/.ssh/id_rsa", content: "SSH-SECRET\n" });
      files.push({ path: "other/.env", content: "OTHER-SECRET\n" });
    },
    env: { ANTHROPIC_API_KEY: "mock" },
    files, // (onRoot adds to this same array before anything is written)
  });
  process.env.MANTA_OPENCODE_PASSWORD = sb.password;
  oc._setApiBase(sb.url);
  const home = join(sb.root, "home");
  const cwd = sb.projectDir;
  await mkdir(join(cwd, ".git"), { recursive: true });
  await writeFile(join(cwd, "app.js"), "console.log('APP-OK')\n");
  await writeFile(join(cwd, ".git/config"), "[core]\n");

  const api = async (method, path, body) => {
    const res = await fetch(sb.url + path, { method, headers: { authorization: sb.auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const draftDir = join(home, ".manta/agents/.trials/tr_aa/agent");
  async function run(script, isolation, agent = "agent-trial-tr_aa") {
    SCRIPT = script;
    bodies = [];
    const id = mintSessionId();
    const rules = buildTrialRuleset({ isolation, dir: draftDir, home, policy: { ...MODES.balanced }, sessionID: id });
    const sess = await oc.createSession({ id, directory: cwd, agent, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, permission: rules, title: "probe" });
    await api("POST", `/api/session/${sess.id}/prompt`, { text: "go", agent });
    await Promise.race([api("POST", `/api/experimental/session/${sess.id}/wait`), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 90_000))]);
    const msgs = await oc.listMessages(sess.id, { limit: 200 });
    return msgs.flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
  }
  const call = (re, input) => ({ re, input });
  const outcome = (p) => (p?.state?.status === "error" ? `error: ${p.state.error ?? ""}` : `${p?.state?.status}: ${String(p?.state?.output ?? "").slice(0, 120)}`);
  const refused = (p) => p?.state?.status === "error" && DENIAL_TEXT_RE.test(String(p.state.error ?? ""));
  const ok = (p, text) => p?.state?.status === "completed" && String(p.state.output ?? "").includes(text);

  // one call per session: a tool the rules deny is not even offered to the model, which is as good as refused
  const offered = [];
  const one = async (c, isolation = "worktree", agent) => {
    const p = await run([c], isolation, agent);
    offered.push((bodies[0]?.tools ?? []).map((t) => t.name));
    return p[0];
  };
  const parts = [
    await one(call(/^read$/i, { path: join(cwd, "app.js") })), //                       0 inside: works
    await one(call(/^read$/i, { path: join(home, ".ssh/id_rsa") })), //                 1 absolute outside: refused
    await one(call(/^read$/i, { path: "../other/.env" })), //                           2 `..`: refused
    await one(call(/^read$/i, { path: join(draftDir, "skills/x/SKILL.md") })), //       3 the draft's own folder: works
    await one(call(/^read$/i, { path: join(draftDir, "../state.json") })), //           4 its sibling state file: refused
    await one(call(/^(bash|shell)$/i, { command: "ls", description: "probe" })), //     5 no shell, not even ls
    await one(call(/^(bash|shell)$/i, { command: "cat app.js", description: "probe" })), // 6
    await one(call(/^write$/i, { path: join(draftDir, "agent.md"), content: "X" })), // 7 the draft is never written
    await one(call(/^write$/i, { path: join(cwd, ".git/config"), content: "[core]\n\thooksPath=/x\n" })), // 8 never .git
    await one(call(/^write$/i, { path: join(cwd, "new.txt"), content: "NEW" })), //    9 inside: works for a code-editing agent
  ];
  parts.forEach((p, i) => console.log(`  [info] #${i} ${p?.tool} → ${outcome(p)}; shell offered: ${offered[i].some((n) => /^(bash|shell)$/i.test(n))}`));
  const stopped = (p) => !p || p.state?.status === "error";
  check("the session ruleset grants what the block's catch-all deny withholds: a read inside the case's folder works", ok(parts[0], "APP-OK"), outcome(parts[0]));
  check("a read of ~/.ssh/id_rsa by absolute path is refused", !String(parts[1]?.state?.output ?? "").includes("SSH-SECRET") && stopped(parts[1]), outcome(parts[1]));
  check("a read of ../other/.env is refused", !String(parts[2]?.state?.output ?? "").includes("OTHER-SECRET") && stopped(parts[2]), outcome(parts[2]));
  check("the draft's own folder is readable", ok(parts[3], "DRAFT-FOLDER-OK"), outcome(parts[3]));
  check("the trial's state file beside it is refused", !String(parts[4]?.state?.output ?? "").includes("STATE-SECRET") && stopped(parts[4]), outcome(parts[4]));
  check("no shell: the shell tool is not offered at all, so `ls` and `cat app.js` can't run", !offered[5].some((n) => /^(bash|shell)$/i.test(n)) && stopped(parts[5]) && stopped(parts[6]), `${outcome(parts[5])} ${outcome(parts[6])}`);
  check("the draft's own folder is never written", stopped(parts[7]), outcome(parts[7]));
  check(".git/config is never written", stopped(parts[8]), outcome(parts[8]));
  check("a code-editing agent can write a new file inside the copy", parts[9]?.state?.status === "completed", outcome(parts[9]));

  const ro = await run([call(/^write$/i, { path: join(cwd, "ro.txt"), content: "NO" })], "none", "agent-trial-tr_bb");
  check("a read-only agent can't write inside the copy", ro[0]?.state?.status === "error" || !ro[0], outcome(ro[0]));

  // the subagent list: a primary-mode block is not offered to the `task` tool
  SCRIPT = [];
  bodies = [];
  const id = mintSessionId();
  const sess = await oc.createSession({ id, directory: cwd, agent: "build", model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, title: "list" });
  await api("POST", `/api/session/${sess.id}/prompt`, { text: "go", agent: "build" });
  await Promise.race([api("POST", `/api/experimental/session/${sess.id}/wait`), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 90_000))]);
  const names = (bodies[0]?.tools ?? []).map((t) => t.name);
  console.log(`  [info] tools offered to a plain session: ${names.join(", ")}`);
  const taskTool = (bodies[0]?.tools ?? []).find((t) => /^(task|subagent)$/i.test(t.name));
  console.log(`  [info] subagent tool description: ${String(taskTool?.description ?? "").slice(0, 300).replace(/\n/g, " ")}`);
  const listed = String(taskTool?.description ?? "");
  check("the subagent tool lists a subagent-mode control block (so the next check means something)", listed.includes("agent-control-sub"), listed.slice(0, 400));
  check("…and does not name a trial block (primary mode is hidden from the subagent list)", !!taskTool && !listed.includes("agent-trial-tr_"), listed.slice(0, 400));
} catch (e) {
  check("probe ran to completion", false, e?.stack ?? String(e));
} finally {
  await sb?.stop();
  await mock.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// Probe for Agents Phase 3 §4 ("jobRules"), on the REAL pinned OpenCode V2 binary, no API spend.
//
//   node scripts/opencode-v2/autonomy-rules.e2e.mjs
//
// A specialist job's ruleset is [base…, ...jobRules(policy)] created through the production client
// (src/server/opencode.mjs createSession). A scripted stand-in for the model issues one tool call per request; the
// REAL tools run in the sandbox. Shell side effects are observable: `gh`, `fly` and `sendmail` on PATH are harmless
// fakes that append their command line to a marker file, so "blocked with no side effect" is a fact, not a guess.
//
// Asserts (spec §4 Probe): a deny pattern blocks the plain command AND the same command as a subcommand
// (`cd x && gh pr merge 3`), with no side effect; a neighbouring allowed command runs; protected fixture files (a
// sandboxed fake home) are denied for a direct read, a search (grep, glob) and a write, and `cat` of one through the
// shell; the specialist's own agent folder stays readable. Also records the exact error text the model receives
// (the string src/server/autonomy.mjs matches to call a tool failure "blocked").
//
// SAFETY: sandbox only (sandbox.mjs: own port, random password, own HOME/XDG). The live opencode (:4096) and
// manta-server (:8787) are never contacted.

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";
import { jobRules, DENIAL_TEXT_RE } from "../../src/server/autonomy.mjs";
import { buildReadOnlyAgentRuleset, buildWorktreeAgentRuleset, normalizeJobRuleset, mintSessionId } from "../../src/server/delegate.mjs";
import { MODES } from "../../src/shared/autonomyShared.mjs";
import { projectPatterns, validateEntry } from "../../src/server/projectActions.mjs";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "opencode-plugins-v2", "manta");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 700)}` : ""}`);
};
const j = (v) => JSON.stringify(v);

// ---- the scripted "model": step N = the N-th tool call of SCRIPT ----
let SCRIPT = [];
const stepOf = (body) => {
  let n = 0;
  for (const m of body.messages ?? []) if (Array.isArray(m.content)) n += m.content.filter((c) => c.type === "tool_result").length;
  return n;
};
const toolName = (body, re) => (body.tools ?? []).map((t) => t.name).find((n) => re.test(n));
let offered = [];
const decideFn = (body) => {
  offered = (body.tools ?? []).map((t) => t.name);
  const step = stepOf(body);
  const call = SCRIPT[step];
  if (!call) return { kind: "text", text: "done" };
  const name = toolName(body, call.re);
  if (!name) return { kind: "text", text: `no tool ${call.re}` };
  return { kind: "tool", name, input: call.input };
};

// the secrets fixture (a task may USE a shared secret and its OWN session's folder, nothing else under ~/.manta-secrets)
const OWN_ID = mintSessionId();
const OTHER_ID = mintSessionId();

const mock = await startMockAnthropic({ decideFn });
const oc = await import("../../src/server/opencode.mjs");
let sb;

const base = await mkdirTemp();
async function mkdirTemp() {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return mkdtemp(join(tmpdir(), "manta-autonomy-probe-"));
}

try {
  // harmless fakes for gh / fly / sendmail: they only record that they ran
  const bin = join(base, "bin");
  const marker = join(base, "marker.log");
  await mkdir(bin, { recursive: true });
  await writeFile(marker, "");
  for (const name of ["gh", "fly", "sendmail", "make"]) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${marker}\n`);
    await chmod(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;

  sb = await startSandbox({
    binary: await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) }),
    config: { provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } } },
    plugins: [PLUGIN_DIR],
    env: { ANTHROPIC_API_KEY: "mock", MANTA_SERVER_URL: "http://127.0.0.1:9", MANTA_BOX_TOKEN: "ef12".repeat(8) },
    files: [
      { path: "home/.manta/auth.json", content: '{"token":"FIXTURE-SECRET"}\n' },
      { path: "home/.manta/config.json", content: '{"fixture":"FIXTURE-SECRET"}\n' },
      { path: "home/.manta/agents/dev/skills/x/SKILL.md", content: "AGENT-FOLDER-OK\n" },
      { path: "home/.manta/notes.txt", content: "OTHER-MANTA-FILE\n" },
      { path: "home/.config/opencode/probe.jsonc", content: '{"fixture":"FIXTURE-SECRET"}\n' },
      { path: "home/.manta-secrets/SHARED_KEY", content: "SHARED-SECRET-VALUE\n" },
      { path: `home/.manta-secrets/sessions/${OWN_ID}/OWN_KEY`, content: "OWN-SECRET-VALUE\n" },
      { path: `home/.manta-secrets/sessions/${OTHER_ID}/OTHER_KEY`, content: "OTHER-SECRET-VALUE\n" },
    ],
  });
  process.env.MANTA_OPENCODE_PASSWORD = sb.password;
  oc._setApiBase(sb.url);
  const home = join(sb.root, "home");
  const cwd = sb.projectDir;
  await mkdir(join(cwd, "x"), { recursive: true });
  await writeFile(join(cwd, "deploy.sh"), "#!/bin/sh\necho deploy\n");

  const api = async (method, path, body) => {
    const res = await fetch(sb.url + path, { method, headers: { authorization: sb.auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };

  const agentDir = join(home, ".manta/agents/dev");
  /** Run SCRIPT in a fresh job-like session; returns the finished tool parts in call order. `ro`: the read-only agent base. */
  async function run(script, policy, { ro = false, grant = [], projectPatterns: pp = [], sessionId = mintSessionId() } = {}) {
    SCRIPT = script;
    const baseRules = [...(ro ? buildReadOnlyAgentRuleset({ agentDir, home }) : buildWorktreeAgentRuleset({ home })), ...grant.map((permission) => ({ permission, pattern: "*", action: "allow" }))];
    // the child's id is minted up front (as the delegate engine does) so its rules can name its own secrets folder
    const rules = normalizeJobRuleset([...baseRules, ...jobRules(policy, { home, agentDir, projectPatterns: pp, sessionID: sessionId })]);
    const sess = await oc.createSession({ id: sessionId, directory: cwd, agent: "build", model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, permission: rules, title: "probe" });
    await api("POST", `/api/session/${sess.id}/prompt`, { text: "go" });
    await Promise.race([api("POST", `/api/experimental/session/${sess.id}/wait`), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), 90_000))]);
    const msgs = await oc.listMessages(sess.id, { limit: 200 });
    return msgs.flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
  }
  const bash = (command) => ({ re: /^(bash|shell)$/i, input: { command, description: "probe" } });
  const file = (re, input) => ({ re, input });
  const ran = async () => (await readFile(marker, "utf8")).split("\n").filter(Boolean);
  const outcome = (p) => (p?.state?.status === "error" ? `error: ${p.state.error ?? ""}` : `${p?.state?.status}: ${String(p?.state?.output ?? "").slice(0, 160)}`);
  const denied = (p) => p?.state?.status === "error" && DENIAL_TEXT_RE.test(String(p.state.error ?? ""));

  const balanced = { ...MODES.balanced };

  // ===== (a)(b)(c) bash deny patterns =====
  const parts = await run(
    [
      bash("gh pr merge 3"), //                          0 plain: blocked
      bash("cd x && gh pr merge 4"), //                  1 subcommand: ?
      bash("gh pr list"), //                             2 neighbour: runs
      bash("fly deploy"), //                             3 deploy (ask): blocked
      bash("echo hi; fly deploy --app z"), //            4 after ';'
      bash("fly status"), //                             5 neighbour: runs
      bash("git tag -l"), //                             6 allowed
      bash("git push origin feat/x"), //                 7 allowed (fails: no remote — not a denial)
      bash("cat deploy.sh"), //                          8 allowed
      bash('sh -c "fly deploy --app viash"'), //         9 honest limit: records what happens
      bash(`cat ${home}/.manta/auth.json`), //          10 protected via bash: blocked
      bash(`cat ${home}/.manta/notes.txt`), //          11 elsewhere under ~/.manta: allowed
      bash("echo hello | sendmail bob"), //             12 send_external (ask): blocked
    ],
    balanced,
  );
  const log = await ran();
  parts.forEach((p, i) => console.log(`  [info] bash #${i} ${p.state?.input?.command} → ${outcome(p)}`));
  check("plain `gh pr merge 3` is blocked", denied(parts[0]), outcome(parts[0]));
  check("…with no side effect", !log.some((l) => l === "gh pr merge 3"), j(log));
  const compound = denied(parts[1]);
  check("`cd x && gh pr merge 4` (a subcommand) is blocked", compound, outcome(parts[1]));
  check("…with no side effect", !log.some((l) => l === "gh pr merge 4"), j(log));
  check("a neighbouring allowed command runs (`gh pr list`)", parts[2]?.state?.status === "completed" && log.includes("gh pr list"), `${outcome(parts[2])} ${j(log)}`);
  check("`fly deploy` is blocked at Ask, with no side effect", denied(parts[3]) && !log.some((l) => l === "fly deploy"), `${outcome(parts[3])} ${j(log)}`);
  check("`echo hi; fly deploy …` is blocked, with no side effect", denied(parts[4]) && !log.some((l) => l.startsWith("fly deploy --app z")), `${outcome(parts[4])} ${j(log)}`);
  check("`fly status` runs", log.includes("fly status"), j(log));
  check("`git tag -l`, `git push origin feat/x`, `cat deploy.sh` are not blocked", [6, 7, 8].every((i) => !denied(parts[i])), [6, 7, 8].map((i) => outcome(parts[i])).join(" | "));
  console.log(`  [info] honest limit — \`sh -c "fly deploy"\`: ${denied(parts[9]) ? "blocked" : "NOT blocked"}; side effect: ${log.some((l) => l.startsWith("fly deploy --app viash"))}`);
  check("`cat <home>/.manta/auth.json` through bash is blocked", denied(parts[10]) && !String(parts[10]?.state?.output ?? "").includes("FIXTURE-SECRET"), outcome(parts[10]));
  check("another file under ~/.manta can still be read through bash", parts[11]?.state?.status === "completed" && String(parts[11].state.output).includes("OTHER-MANTA-FILE"), outcome(parts[11]));
  check("`sendmail` is blocked at Ask", denied(parts[12]) && !log.some((l) => l.startsWith("sendmail")), `${outcome(parts[12])} ${j(log)}`);
  const sample = parts.find((p) => denied(p));
  console.log(`  [info] EXACT denial text the model receives: ${j(sample?.state?.error)}`);

  // the same commands with the level "tell"/"auto" are not blocked (only ask / never are)
  const open = await run([bash("fly deploy --app tell")], { ...MODES.autonomous });
  const log2 = await ran();
  check("at Tell, `fly deploy` is not blocked (it runs)", !denied(open[0]) && log2.includes("fly deploy --app tell"), `${outcome(open[0])} ${j(log2)}`);
  const merge2 = await run([bash("gh pr merge 9")], { ...MODES.autonomous });
  check("a specialist never merges, even when the merge row is Auto", denied(merge2[0]) && !(await ran()).includes("gh pr merge 9"), outcome(merge2[0]));

  // ===== protected paths: read / grep / glob / write =====
  const prot = await run(
    [
      file(/^read$/i, { path: join(home, ".manta/auth.json") }), //                    0
      file(/^grep$/i, { pattern: "FIXTURE", path: join(home, ".manta/auth.json") }), // 1
      file(/^grep$/i, { pattern: "FIXTURE", path: join(home, ".manta") }), //           2 (directory)
      file(/^glob$/i, { pattern: "*", path: join(home, ".config/opencode") }), //       3
      file(/^write$/i, { path: join(home, ".manta/auth.json"), content: "OVERWRITTEN" }), // 4
      file(/^read$/i, { path: join(home, ".manta/agents/dev/skills/x/SKILL.md") }), //  5 own agent folder: allowed
      file(/^write$/i, { path: join(home, ".manta/new.txt"), content: "x" }), //        6 write under ~/.manta: denied
      file(/^read$/i, { path: join(home, ".config/opencode/probe.jsonc") }), //         7
      file(/^list$/i, { path: join(home, ".manta") }), //                               8 (listing the folder)
    ],
    balanced,
  );
  prot.forEach((p, i) => console.log(`  [info] file #${i} ${p.tool} ${j(p.state?.input)} → ${outcome(p)}`));
  const leaked = (p) => String(p?.state?.output ?? "").includes("FIXTURE-SECRET");
  check("a direct read of a protected file is denied", denied(prot[0]) && !leaked(prot[0]), outcome(prot[0]));
  check("a grep of a protected FILE is denied", denied(prot[1]) && !leaked(prot[1]), outcome(prot[1]));
  check("a recursive grep of the ~/.manta folder does not reveal a protected file", !leaked(prot[2]), outcome(prot[2]));
  check("a glob of ~/.config/opencode is denied", denied(prot[3]), outcome(prot[3]));
  check("a write to a protected file is denied and the file is unchanged", denied(prot[4]) && (await readFile(join(home, ".manta/auth.json"), "utf8")).includes("FIXTURE-SECRET"), outcome(prot[4]));
  check("the specialist's own agent folder stays readable", prot[5]?.state?.status === "completed" && String(prot[5].state.output).includes("AGENT-FOLDER-OK"), outcome(prot[5]));
  check("a write under ~/.manta is denied", denied(prot[6]), outcome(prot[6]));
  check("a read under ~/.config/opencode is denied", denied(prot[7]) && !leaked(prot[7]), outcome(prot[7]));
  console.log(`  [info] listing ~/.manta: ${outcome(prot[8])}`);

  // the same through the read-only agent base (what an `isolation: none` specialist gets)
  const ro = await run(
    [
      file(/^read$/i, { path: join(home, ".manta/auth.json") }),
      file(/^grep$/i, { pattern: "FIXTURE", path: join(home, ".manta") }),
      file(/^read$/i, { path: join(home, ".manta/agents/dev/skills/x/SKILL.md") }),
      file(/^grep$/i, { pattern: "AGENT", path: join(home, ".manta/agents/dev") }),
    ],
    balanced,
    { ro: true },
  );
  ro.forEach((p, i) => console.log(`  [info] read-only base #${i} ${p.tool} → ${outcome(p)}`));
  check("read-only base: protected file denied, ~/.manta search does not leak", denied(ro[0]) && !leaked(ro[1]), `${outcome(ro[0])} | ${outcome(ro[1])}`);
  check("read-only base: the agent's own folder stays readable and searchable", ro[2]?.state?.status === "completed" && ro[3]?.state?.status === "completed", `${outcome(ro[2])} | ${outcome(ro[3])}`);

  // ===== tools by name =====
  // the base ruleset does not grant serve_page at all, so the probe grants it first: the rule under test is what stops it
  const serve = (policy) => run([file(/serve_page$/, { subdomain: "probe", filePath: join(cwd, "deploy.sh") })], policy, { grant: ["serve_page"] });
  const askParts = await serve(balanced);
  const askOffered = offered.filter((n) => /serve_page$/.test(n));
  console.log(`  [info] serve_page at Ask → offered to the model: ${j(askOffered)}; call: ${outcome(askParts[0])}`);
  check("a tool named in the kind table (`serve_page`, publish=Ask) is withheld from the model or its call is denied", askOffered.length === 0 || denied(askParts[0]), outcome(askParts[0]));
  const tellParts = await serve({ ...MODES.autonomous });
  const tellOffered = offered.filter((n) => /serve_page$/.test(n));
  console.log(`  [info] serve_page at Tell → offered: ${j(tellOffered)}; call: ${outcome(tellParts[0])}`);
  check("…and at Tell it is offered and runs (the dead fake server answers, no denial)", tellOffered.length === 1 && tellParts.length === 1 && !denied(tellParts[0]), outcome(tellParts[0]));

  // ===== the project's own commands (Phase 3c) =====
  await mkdir(join(cwd, "scripts"), { recursive: true });
  await writeFile(join(cwd, "scripts/deploy-web.sh"), `#!/bin/sh\necho "deploy-web.sh $*" >> ${marker}\n`);
  await chmod(join(cwd, "scripts/deploy-web.sh"), 0o755);
  const page = [
    validateEntry({ kind: "deploy", command: "scripts/deploy-web.sh", what: "uploads the site", file: "scripts/deploy-web.sh" }),
    validateEntry({ kind: "deploy", command: "make ship", what: "ships", file: "Makefile" }),
  ];
  const pp = projectPatterns(page);
  const pparts = await run(
    [
      bash("./scripts/deploy-web.sh"), //                0 the page's script: blocked
      bash("bash scripts/deploy-web.sh --prod"), //      1 another spelling: blocked
      bash("cd x && ./scripts/deploy-web.sh"), //        2 as a subcommand: blocked
      bash("cat scripts/deploy-web.sh"), //              3 reading it: runs
      bash("make ship"), //                              4 the page's make target: blocked
      bash("make shipping-report"), //                   5 a neighbouring target: runs
      bash("echo ok; make ship ENV=prod"), //            6 after ';': blocked
    ],
    balanced,
    { projectPatterns: pp },
  );
  const plog = await ran();
  pparts.forEach((p, i) => console.log(`  [info] page #${i} ${p.state?.input?.command} → ${outcome(p)}`));
  check("`./scripts/deploy-web.sh` (a command on the project's page, deploy=Ask) is blocked with no side effect", denied(pparts[0]) && !plog.some((l) => l.startsWith("deploy-web.sh")), `${outcome(pparts[0])} ${j(plog)}`);
  check("`bash scripts/deploy-web.sh --prod` is blocked too", denied(pparts[1]) && !plog.some((l) => l.includes("--prod")), `${outcome(pparts[1])} ${j(plog)}`);
  check("`cd x && ./scripts/deploy-web.sh` (a subcommand) is blocked", denied(pparts[2]), outcome(pparts[2]));
  check("`cat scripts/deploy-web.sh` still runs (reading is not the action)", pparts[3]?.state?.status === "completed" && String(pparts[3].state.output).includes("deploy-web.sh"), outcome(pparts[3]));
  check("`make ship` (an entry) is blocked with no side effect", denied(pparts[4]) && !plog.includes("make ship"), `${outcome(pparts[4])} ${j(plog)}`);
  check("`make shipping-report` runs (an entry never matches a longer word)", pparts[5]?.state?.status === "completed" && !denied(pparts[5]), outcome(pparts[5]));
  check("`echo ok; make ship ENV=prod` is blocked", denied(pparts[6]) && !plog.some((l) => l.startsWith("make ship ENV")), `${outcome(pparts[6])} ${j(plog)}`);
  // the same page at Tell blocks nothing (only ask / never), and nothing on a page can allow anything
  const tellPage = await run([bash("./scripts/deploy-web.sh --tell"), bash("make ship")], { ...MODES.autonomous }, { projectPatterns: pp });
  const tlog = await ran();
  check("at Tell the page's commands run (only Ask / Never block)", !denied(tellPage[0]) && tlog.includes("deploy-web.sh --tell") && tlog.includes("make ship"), `${outcome(tellPage[0])} ${j(tlog)}`);

  // ===== secrets a task was handed (secret_provide): use them by reference; never the rest of the store =====
  const S = `${home}/.manta-secrets`;
  const sec = await run(
    [
      bash(`cat ${S}/SHARED_KEY`), //                                          0 a shared secret: used
      bash(`echo "used:$(cat ${S}/SHARED_KEY)" | wc -c`), //                   1 by reference, inside a substitution + a pipeline
      bash(`cat ${S}/sessions/${OWN_ID}/OWN_KEY`), //                          2 this task's own session folder
      bash(`cat ${S}/sessions/${OTHER_ID}/OTHER_KEY`), //                      3 another session's: denied
      bash(`cd x && cat ${S}/sessions/${OTHER_ID}/OTHER_KEY`), //              4 …as a subcommand
      bash(`ls ${S}/sessions`), //                                             5 listing the sessions: denied
      bash(`echo overwritten > ${S}/SHARED_KEY`), //                           6 a write: denied
      bash(`rm ${S}/SHARED_KEY`), //                                           7 a delete: denied
      bash(`cd x && rm ${S}/sessions/${OWN_ID}/OWN_KEY`), //                   8 …as a subcommand, in its own folder
      file(/^write$/i, { path: `${S}/SHARED_KEY`, content: "OVERWRITTEN" }), // 9 the write tool: denied
      file(/^read$/i, { path: `${S}/SHARED_KEY` }), //                         10 the read tool: denied (the value would land in the transcript)
      bash(`cat ${S}/SHARED_KEY ${home}/.manta/auth.json`), //                 11 next to a protected file: denied
      bash(`cat ${S}/sessions/${OWN_ID}/../${OTHER_ID}/OTHER_KEY`), //         12 climbing out of its own folder: denied
      bash(`ls ${S}`), //                                                      13 the bare store folder: denied
      bash(`cat ${home}/.manta/auth.json`), //                                 14 the protected files are still denied
    ],
    balanced,
    { sessionId: OWN_ID },
  );
  sec.forEach((p, i) => console.log(`  [info] secrets #${i} ${p.tool} ${String(p.state?.input?.command ?? p.state?.input?.path).replace(home, "~")} → ${outcome(p)}`));
  const out = (p) => String(p?.state?.output ?? "");
  const leakedOther = (p) => out(p).includes("OTHER-SECRET-VALUE") || out(p).includes("FIXTURE-SECRET");
  check("a task can `cat` a shared secret file it was handed", sec[0]?.state?.status === "completed" && out(sec[0]).includes("SHARED-SECRET-VALUE"), outcome(sec[0]));
  check("…and use it by reference (`$(cat …)` inside a command and a pipeline)", sec[1]?.state?.status === "completed" && /\d/.test(out(sec[1])), outcome(sec[1]));
  check("a task can read the secrets in its OWN session's folder", sec[2]?.state?.status === "completed" && out(sec[2]).includes("OWN-SECRET-VALUE"), outcome(sec[2]));
  check("another session's secret file is denied and not read", denied(sec[3]) && !leakedOther(sec[3]), outcome(sec[3]));
  check("…also as a subcommand", denied(sec[4]) && !leakedOther(sec[4]), outcome(sec[4]));
  check("listing the sessions folder is denied", denied(sec[5]), outcome(sec[5]));
  check("a shell write to a secret file is denied and the file is unchanged", denied(sec[6]) && (await readFile(`${S}/SHARED_KEY`, "utf8")).includes("SHARED-SECRET-VALUE"), outcome(sec[6]));
  check("a shell delete of a secret file is denied and the file is still there", denied(sec[7]) && (await readFile(`${S}/SHARED_KEY`, "utf8")).includes("SHARED-SECRET-VALUE"), outcome(sec[7]));
  check("…also as a subcommand in its own folder", denied(sec[8]) && (await readFile(`${S}/sessions/${OWN_ID}/OWN_KEY`, "utf8")).includes("OWN-SECRET-VALUE"), outcome(sec[8]));
  check("the write tool on a secret file is denied", denied(sec[9]) && (await readFile(`${S}/SHARED_KEY`, "utf8")).includes("SHARED-SECRET-VALUE"), outcome(sec[9]));
  check("the read tool on a secret file is denied (use `$(cat …)`; the value must not land in the transcript)", denied(sec[10]) && !out(sec[10]).includes("SHARED-SECRET-VALUE"), outcome(sec[10]));
  check("a secret next to a protected Manta file is still denied", denied(sec[11]) && !leakedOther(sec[11]), outcome(sec[11]));
  check("climbing out of its own folder with `..` is denied", denied(sec[12]) && !leakedOther(sec[12]), outcome(sec[12]));
  check("the bare ~/.manta-secrets folder is denied", denied(sec[13]), outcome(sec[13]));
  check("Manta's protected files are still denied", denied(sec[14]) && !leakedOther(sec[14]), outcome(sec[14]));
} catch (e) {
  check("probe ran to completion", false, e?.stack ?? String(e));
} finally {
  await sb?.stop();
  await mock.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

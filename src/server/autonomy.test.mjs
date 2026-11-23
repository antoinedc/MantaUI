import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_KINDS,
  LEVELS,
  MODES,
  MODE_NAMES,
  DEFAULT_POLICY,
  KIND_PATTERNS,
  DENIAL_TEXT_RE,
  decide,
  effectivePolicy,
  policyKey,
  normalizePolicy,
  renderPolicy,
  jobRules,
  matchKinds,
  extractActions,
  actionLines,
  settingsOf,
  validateAutonomyInput,
  taskPromptSection,
  isInsideMantaFolders,
  AutonomyError,
  SETTINGS_RULE,
} from "./autonomy.mjs";

const HOME = "/home/dev";
const bashPart = (command, status = "completed", error) => ({ type: "tool", tool: "bash", state: { status, input: { command }, ...(error ? { error } : {}) } });

test("the modes: every mode answers every kind with a known level; Balanced is the default and today's fixed policy", () => {
  assert.deepEqual([...MODE_NAMES], ["cautious", "balanced", "autonomous"]);
  for (const mode of MODE_NAMES) {
    assert.deepEqual(Object.keys(MODES[mode]).sort(), [...ACTION_KINDS].sort(), mode);
    for (const kind of ACTION_KINDS) assert.ok(LEVELS.includes(MODES[mode][kind]), `${mode}/${kind}`);
  }
  assert.equal(DEFAULT_POLICY, MODES.balanced);
  // the Phase 2 answers for the old kinds: handoff and edit_code automatic, the rest ask
  for (const k of ["handoff", "edit_code"]) assert.equal(decide(k), "auto");
  for (const k of ["merge", "deploy", "publish", "spend", "send_external", "delete_data"]) assert.equal(decide(k), "ask", k);
});

test("effectivePolicy: nothing / invalid → Balanced; a mode row; valid overrides win; invalid ones are ignored; edit_code is auto | never", () => {
  assert.deepEqual(effectivePolicy(undefined), MODES.balanced);
  assert.deepEqual(effectivePolicy(null), MODES.balanced);
  assert.deepEqual(effectivePolicy({ mode: "wild" }), MODES.balanced);
  assert.deepEqual(effectivePolicy("autonomous"), MODES.balanced);
  assert.deepEqual(effectivePolicy({ mode: "autonomous" }), MODES.autonomous);
  assert.deepEqual(effectivePolicy({ mode: "autonomous", overrides: { deploy: "ask" } }), { ...MODES.autonomous, deploy: "ask" });
  assert.deepEqual(effectivePolicy({ mode: "cautious", overrides: { deploy: "maybe", nonsense: "auto", merge: "never" } }), { ...MODES.cautious, merge: "never" });
  assert.deepEqual(effectivePolicy({ overrides: { merge: "auto" } }), { ...MODES.balanced, merge: "auto" }, "no mode → Balanced, overrides still apply");
  assert.equal(effectivePolicy({ mode: "balanced", overrides: { edit_code: "tell" } }).edit_code, "auto");
  assert.equal(effectivePolicy({ mode: "balanced", overrides: { edit_code: "ask" } }).edit_code, "never");
  assert.equal(effectivePolicy({ mode: "balanced", overrides: { edit_code: "never" } }).edit_code, "never");
  assert.equal(effectivePolicy({ mode: "balanced", overrides: [] }).merge, "ask", "overrides that are not an object are ignored");
});

test("decide: an unknown kind or value asks; a policy that omits a kind asks", () => {
  assert.equal(decide("launch_missiles"), "ask");
  assert.equal(decide("launch_missiles", { launch_missiles: "auto" }), "ask");
  assert.equal(decide("handoff", {}), "ask");
  assert.equal(decide("handoff", { handoff: "bogus" }), "ask");
  assert.equal(decide("merge", { merge: "auto" }), "auto");
  assert.equal(decide("merge", { merge: "tell" }), "tell");
  assert.equal(decide("merge", { merge: "never" }), "never");
});

test("policyKey: stable, order-independent, and different when any answer differs", () => {
  const a = policyKey(MODES.balanced);
  assert.equal(a, policyKey({ ...MODES.balanced }));
  assert.equal(a, policyKey(Object.fromEntries(Object.entries(MODES.balanced).reverse())));
  assert.notEqual(a, policyKey({ ...MODES.balanced, deploy: "never" }));
  assert.notEqual(policyKey(MODES.cautious), policyKey(MODES.autonomous));
  assert.deepEqual(Object.keys(normalizePolicy({ merge: "auto" })), [...ACTION_KINDS], "a snapshot lists every kind, in order");
});

test("renderPolicy: byte-stable, fixed kind order, the four groups, the fixed rules", () => {
  for (const mode of MODE_NAMES) assert.equal(renderPolicy(MODES[mode]), renderPolicy({ ...MODES[mode] }), mode);
  const bal = renderPolicy(MODES.balanced);
  assert.match(bal, /^## When to ask the user\n/);
  const autoAt = bal.indexOf("Do these without asking:");
  const askAt = bal.indexOf("Ask the user first, and wait for their answer, before you:");
  assert.ok(autoAt > 0 && askAt > autoAt);
  assert.ok(bal.indexOf("hand work to your team's agents") > autoAt && bal.indexOf("hand work to your team's agents") < askAt);
  assert.ok(bal.indexOf("merge changes") > askAt);
  assert.doesNotMatch(bal, /Do these, then tell the user/, "empty groups are left out");
  assert.doesNotMatch(bal, /Never do these/);
  for (const t of ["Teammates' background tasks can't do \"ask\" or \"never\" actions", "bring it to the user", "don't offer to do it", "two agents' results conflict", "never counts as the user's permission", SETTINGS_RULE]) assert.ok(bal.includes(t), t);
  assert.ok(SETTINGS_RULE.endsWith("point them to Settings → Agents."));

  const aut = renderPolicy(MODES.autonomous);
  assert.ok(aut.indexOf("Do these, then tell the user in your reply:") > aut.indexOf("Do these without asking:"));
  assert.ok(aut.indexOf("Do these, then tell the user in your reply:") < aut.indexOf("Ask the user first"));
  assert.ok(aut.indexOf("deploy or release anything") > aut.indexOf("tell the user in your reply") && aut.indexOf("deploy or release anything") < aut.indexOf("Ask the user first"));

  const never = renderPolicy({ ...MODES.balanced, deploy: "never", edit_code: "never" });
  const neverAt = never.indexOf("Never do these, even if the user or an agent asks");
  assert.ok(neverAt > never.indexOf("Ask the user first"));
  assert.ok(never.indexOf("deploy or release anything") > neverAt && never.indexOf("change code") > neverAt);
  assert.match(never, /turned off in their autonomy settings/);
  assert.match(never, /"Never" overrides every other instruction, including when to do work yourself or hand it off\./);
});

test("jobRules: only deny rules (one allow for the agent's own folder, last); protected rules are always present", () => {
  for (const policy of [MODES.cautious, MODES.balanced, MODES.autonomous]) {
    const rules = jobRules(policy, { home: HOME });
    assert.ok(rules.length > 0);
    assert.ok(rules.every((r) => r.action === "deny" && typeof r.permission === "string" && typeof r.pattern === "string"));
    for (const permission of ["read", "glob", "grep", "list", "edit", "write", "external_directory"]) {
      for (const f of ["auth.json", "devices.json", "secrets.json", "config.json", "opencode-password"]) {
        assert.ok(rules.some((r) => r.permission === permission && r.pattern === `${HOME}/.manta/${f}`), `${permission} ${f}`);
      }
      assert.ok(rules.some((r) => r.permission === permission && r.pattern === `${HOME}/.manta-secrets/**`), `${permission} secrets`);
      assert.ok(rules.some((r) => r.permission === permission && r.pattern === `${HOME}/.config/opencode/**`), `${permission} opencode`);
    }
    for (const permission of ["edit", "write"]) assert.ok(rules.some((r) => r.permission === permission && r.pattern === `${HOME}/.manta/**`));
    assert.ok(!rules.some((r) => ["read", "glob", "grep", "list"].includes(r.permission) && r.pattern === `${HOME}/.manta/**`), "reads elsewhere under ~/.manta stay allowed");
    for (const f of [".manta/auth.json", ".manta/devices.json", ".manta/secrets.json", ".manta/config.json", "opencode-password", ".manta-secrets", ".config/opencode", "127.0.0.1:8787", "localhost:8787"]) {
      assert.ok(rules.some((r) => r.permission === "bash" && r.pattern === `*${f}*`), f);
    }
    for (const m of ["gh pr merge*", "glab mr merge*", "git push * main", "git push * master", "git push * HEAD:main", "git push * HEAD:master"]) {
      assert.ok(rules.some((r) => r.permission === "bash" && r.pattern === m), `merge ${m}`);
    }
  }
});

test("jobRules: the agent's own folder stays reachable (the one allow, after every deny); nothing else is granted", () => {
  const dir = `${HOME}/.manta/agents/dev`;
  const rules = jobRules(MODES.balanced, { home: HOME, agentDir: dir });
  assert.deepEqual(rules.at(-1), { permission: "external_directory", pattern: `${dir}/**`, action: "allow" });
  assert.equal(rules.filter((r) => r.action === "allow").length, 1);
  assert.ok(rules.some((r) => r.permission === "external_directory" && r.pattern === `${HOME}/.manta/*` && r.action === "deny"));
  assert.ok(rules.findIndex((r) => r.permission === "external_directory" && r.pattern === `${HOME}/.manta/*`) < rules.length - 1);
  assert.equal(jobRules(MODES.balanced, { home: HOME, agentDir: "/elsewhere/agent" }).filter((r) => r.action === "allow").length, 0, "a folder outside ~/.manta needs no allow");
});

test("jobRules: kind patterns only for ask / never, in kind order; Tell and Auto add none", () => {
  const patterns = (policy) => jobRules(policy, { home: HOME }).filter((r) => r.permission === "bash").map((r) => r.pattern);
  const bal = patterns(MODES.balanced);
  for (const [pattern] of KIND_PATTERNS.deploy.bash) assert.ok(bal.includes(pattern), pattern);
  for (const [pattern] of KIND_PATTERNS.publish.bash) assert.ok(bal.includes(pattern), pattern);
  assert.ok(jobRules(MODES.balanced, { home: HOME }).some((r) => r.permission === "serve_page" && r.pattern === "*"));
  assert.ok(jobRules(MODES.balanced, { home: HOME }).some((r) => r.permission === "webhook_create" && r.pattern === "*"));
  const aut = jobRules(MODES.autonomous, { home: HOME });
  assert.ok(!aut.some((r) => r.permission === "bash" && r.pattern === "fly deploy*"), "deploy is Tell in Autonomous: not blocked");
  assert.ok(!aut.some((r) => r.permission === "serve_page"));
  assert.ok(aut.some((r) => r.permission === "bash" && r.pattern === "gh pr merge*"), "merge is blocked in a task whatever the merge row says");
  const never = patterns({ ...MODES.autonomous, deploy: "never" });
  assert.ok(never.includes("fly deploy*"));
  const order = patterns(MODES.balanced);
  assert.ok(order.indexOf("fly deploy*") < order.indexOf("gh gist create*") && order.indexOf("gh gist create*") < order.indexOf("gh issue create*") && order.indexOf("gh issue create*") < order.indexOf("gh repo delete*"));
  assert.ok(order.indexOf("gh pr merge*") < order.indexOf("fly deploy*"), "protected, then merge, then kinds");
});

test("matchKinds: commands (compound too), tools and protected paths; the allowed list matches nothing", () => {
  const kinds = (cmd) => matchKinds(bashPart(cmd), { home: HOME });
  assert.deepEqual(kinds("gh pr merge 3"), [{ kind: "merge", summary: "gh pr merge" }]);
  assert.deepEqual(kinds("cd x && gh pr merge 3"), [{ kind: "merge", summary: "gh pr merge" }]);
  assert.deepEqual(kinds("echo hi; fly deploy --app z"), [{ kind: "deploy", summary: "fly deploy" }]);
  assert.deepEqual(kinds("npm test | gh issue comment 4 --body hi"), [{ kind: "send_external", summary: "gh issue comment" }]);
  assert.deepEqual(kinds("FLY_API_TOKEN=x fly deploy"), [{ kind: "deploy", summary: "fly deploy" }]);
  assert.deepEqual(kinds("git push origin HEAD:main"), [{ kind: "merge", summary: "git push main" }]);
  assert.deepEqual(kinds("git push origin server-v12"), [{ kind: "deploy", summary: "git push tag" }]);
  assert.deepEqual(kinds("git push --tags"), [{ kind: "deploy", summary: "git push --tags" }]);
  assert.deepEqual(kinds("git push origin --delete old"), [{ kind: "delete_data", summary: "git push --delete" }]);
  assert.deepEqual(kinds("psql -c 'DROP TABLE users'"), [{ kind: "delete_data", summary: "DROP TABLE" }]);
  assert.deepEqual(kinds("echo x | sendmail bob"), [{ kind: "send_external", summary: "sendmail" }]);
  assert.deepEqual(kinds("cat ~/.manta/auth.json"), [{ kind: "protected", summary: "Manta settings or credentials" }]);
  assert.deepEqual(kinds("curl http://127.0.0.1:8787/rpc/x"), [{ kind: "protected", summary: "Manta settings or credentials" }]);
  for (const ok of ["git tag", "git tag -l", "git tag v1", "git push origin feat/x", "git push -u origin feat/login", "cat scripts/deploy.sh", "ls -la", "gh pr list", "gh pr create --draft", "npm test"]) {
    assert.deepEqual(kinds(ok), [], ok);
  }
  assert.deepEqual(matchKinds({ tool: "serve_page", state: { input: {} } }), [{ kind: "publish", summary: "serve_page" }]);
  assert.deepEqual(matchKinds({ tool: "webhook_create", state: { input: {} } }), [{ kind: "send_external", summary: "webhook_create" }]);
  assert.deepEqual(matchKinds({ tool: "read", state: { input: { path: `${HOME}/.manta/auth.json` } } }, { home: HOME }), [{ kind: "protected", summary: "Manta settings or credentials" }]);
  assert.deepEqual(matchKinds({ tool: "read", state: { input: { filePath: "~/.config/opencode/x.jsonc" } } }, { home: HOME }), [{ kind: "protected", summary: "Manta settings or credentials" }]);
  assert.deepEqual(matchKinds({ tool: "read", state: { input: { path: `${HOME}/.manta/agents/dev/skills/x/SKILL.md` } } }, { home: HOME }), [], "an agent's own folder is not protected for reading");
  assert.deepEqual(matchKinds({ tool: "write", state: { input: { path: `${HOME}/.manta/new.txt` } } }, { home: HOME }), [{ kind: "protected", summary: "Manta settings or credentials" }]);
  assert.deepEqual(matchKinds({ tool: "read", state: { input: { path: "/repo/a.txt" } } }, { home: HOME }), []);
  assert.deepEqual(matchKinds(null), []);
});

test("extractActions: told = completed calls at Tell; blocked = denial text + a kind at Ask/Never (or protected / merge); ordinary failures are neither", () => {
  const policy = { ...MODES.autonomous, publish: "ask", send_external: "never" };
  const denied = "Permission denied: shell";
  const messages = [
    { info: { id: "msg_launch", role: "user" }, parts: [] },
    {
      info: { id: "msg_a", role: "assistant" },
      parts: [
        bashPart("fly deploy --app secret-app"), //                          deploy @ tell, ran → told
        bashPart("gh gist create secret.txt", "error", denied), //            publish @ ask, denied → blocked (ask)
        bashPart("gh issue create -t hi", "error", denied), //                send_external @ never, denied → blocked (never)
        bashPart("gh pr merge 5", "error", denied), //                        merge → blocked (never)
        bashPart("cat ~/.manta/auth.json", "error", denied), //               protected → blocked (never)
        bashPart("fly deploy --bogus", "error", "exit status 1: unknown flag"), // an ordinary failure
        bashPart("gh gist create ok.txt"), //                                 publish @ ask but it RAN (not enforced): neither
        bashPart("npm test"),
        { type: "text", text: "done" },
      ],
    },
  ];
  const r = extractActions({ messages, afterMessageId: "msg_launch", policy, home: HOME });
  assert.deepEqual(r.toldActions, [{ kind: "deploy", summary: "fly deploy" }]);
  assert.deepEqual(r.blockedActions, [
    { kind: "publish", level: "ask", summary: "gh gist create" },
    { kind: "send_external", level: "never", summary: "gh issue create" },
    { kind: "merge", level: "never", summary: "gh pr merge" },
    { kind: "protected", level: "never", summary: "Manta settings or credentials" },
  ]);
  assert.ok(!JSON.stringify(r).includes("secret"), "fixed labels only — never the user's arguments");
});

test("extractActions: scoped to the attempt; at most 10 each, de-duplicated; empty input is empty", () => {
  const policy = MODES.autonomous;
  const round = (id, cmd) => [{ info: { id, role: "user" }, parts: [] }, { info: { id: `a_${id}`, role: "assistant" }, parts: [bashPart(cmd)] }];
  const messages = [...round("m1", "fly deploy"), ...round("m2", "npm publish")];
  assert.deepEqual(extractActions({ messages, afterMessageId: "m2", continuation: true, policy }).toldActions, [{ kind: "deploy", summary: "npm publish" }]);
  assert.deepEqual(extractActions({ messages, afterMessageId: "m1", policy }).toldActions.map((a) => a.summary), ["fly deploy", "npm publish"]);
  assert.deepEqual(extractActions({ messages, afterMessageId: "gone", continuation: true, policy }), { toldActions: [], blockedActions: [] }, "a continuation whose launch message can't be found reads nothing");
  assert.equal(extractActions({ messages, afterMessageId: "gone", continuation: false, policy }).toldActions.length, 2, "a first attempt reads everything");
  const many = [{ info: { id: "m", role: "user" }, parts: [] }, { info: { id: "a", role: "assistant" }, parts: Array.from({ length: 30 }, (_, i) => bashPart(i % 2 ? "fly deploy" : `vercel x${i} --prod`)) }];
  const r = extractActions({ messages: many, afterMessageId: "m", policy });
  assert.ok(r.toldActions.length <= 10);
  assert.equal(new Set(r.toldActions.map((a) => `${a.kind}|${a.summary}`)).size, r.toldActions.length);
  assert.deepEqual(extractActions({ messages: undefined, policy }), { toldActions: [], blockedActions: [] });
});

test("the denial text is OpenCode's own `Permission denied: <permission>` (probed on the pinned binary)", () => {
  for (const t of ["Permission denied: shell", "Permission denied: read", "Permission denied: external_directory", "Permission denied: edit"]) assert.match(t, DENIAL_TEXT_RE);
  for (const t of ["", "exit status 1", "No such file", "permission denied (publickey)"]) assert.doesNotMatch(t, DENIAL_TEXT_RE);
});

test("actionLines: the two completion-text lines, only when non-empty", () => {
  assert.deepEqual(actionLines({}), []);
  assert.deepEqual(actionLines({ toldActions: [], blockedActions: [] }), []);
  const lines = actionLines({
    toldActions: [{ kind: "send_external", summary: "gh issue comment" }],
    blockedActions: [{ kind: "deploy", level: "ask", summary: "fly deploy" }, { kind: "protected", level: "never", summary: "Manta settings or credentials" }],
  });
  assert.equal(lines[0], "Done without asking (the user asked to be told): send external — gh issue comment");
  assert.equal(
    lines[1],
    "Blocked by the user's autonomy settings: deploy — fly deploy (ask); protected — Manta settings or credentials (never) (ask = needs the user's go-ahead, never = not allowed)",
  );
});

test("taskPromptSection: lists the ask / never labels, always the merging note, no kinds a task can't meet", () => {
  const bal = taskPromptSection(MODES.balanced);
  assert.match(bal, /^Some actions need the user's go-ahead: deploy or release anything; publish anything others can see;/);
  assert.match(bal, /call progress_report with state "blocked"/);
  assert.match(bal, /Needs the user's go-ahead: <exactly what and why>/);
  assert.doesNotMatch(bal, /Some actions are not allowed at all/);
  assert.doesNotMatch(bal, /merge changes|hand work to/);
  assert.match(bal, /\(Merging is never part of a task — that is the lead's job — and says nothing about what Manta may do\.\)$/);
  const never = taskPromptSection({ ...MODES.autonomous, deploy: "never" });
  assert.match(never, /Some actions are not allowed at all: deploy or release anything\. If you hit one, say so in your result; don't try another way\./);
  assert.doesNotMatch(never, /Some actions need the user's go-ahead: deploy/);
  assert.equal(taskPromptSection(MODES.balanced), taskPromptSection({ ...MODES.balanced }), "byte-stable");
});

test("settingsOf / validateAutonomyInput: the wire shapes", () => {
  assert.deepEqual(settingsOf(undefined), { mode: "balanced", overrides: {}, effective: MODES.balanced });
  const s = settingsOf({ mode: "autonomous", overrides: { deploy: "ask", bogus: "auto", merge: "wild" } });
  assert.deepEqual(s.overrides, { deploy: "ask" });
  assert.equal(s.effective.deploy, "ask");
  assert.equal(s.mode, "autonomous");
  assert.deepEqual(validateAutonomyInput({ mode: "cautious", overrides: { merge: "never", edit_code: "ask" } }), { mode: "cautious", overrides: { merge: "never", edit_code: "never" } });
  assert.deepEqual(validateAutonomyInput({ mode: "balanced" }), { mode: "balanced", overrides: {} });
  for (const bad of [null, "x", { mode: "wild" }, { mode: "balanced", overrides: { nope: "auto" } }, { mode: "balanced", overrides: { merge: "maybe" } }, { mode: "balanced", overrides: [] }]) {
    assert.throws(() => validateAutonomyInput(bad), (e) => e instanceof AutonomyError && e.rpcStatus === 400 && typeof e.message === "string" && e.message.length > 0, JSON.stringify(bad));
  }
});

test("isInsideMantaFolders", () => {
  for (const p of [`${HOME}/.manta`, `${HOME}/.manta/agents/manta/home`, `${HOME}/.manta-secrets/x`, `${HOME}/.config/opencode`, `${HOME}/.config/opencode/skills`]) assert.equal(isInsideMantaFolders(p, HOME), true, p);
  for (const p of [`${HOME}/projects/x`, `${HOME}/.mantaui`, `${HOME}/.config/other`, "/tmp/x", ""]) assert.equal(isInsideMantaFolders(p, HOME), false, p);
});

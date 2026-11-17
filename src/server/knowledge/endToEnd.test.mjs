// End-to-end: the REAL knowledge modules (engine, store, curator layer, capture, corrections, repo writer, skills,
// trial, blackboard import, weekly notice, routes + RPC channels) wired exactly as manta-server wires them
// (`createKnowledgeParts`), over a real git store in a temp dir and a temp MANTA_STATE_HOME. Only the edges are
// fake: opencode (transcripts, sessions), the model runner, the forge's pull-request API and the db worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKnowledgeEngine } from "./engine.mjs";
import { createKnowledgeParts } from "./wiring.mjs";
import { handleKnowledgeRoute, buildKnowledgeChannels, toSettingsWire } from "./routes.mjs";
import { createIsUserAuthored, createIsUserAuthoredRef } from "./integration.mjs";
import { createMessageReader } from "./search.mjs";
import { createShellCommandReader } from "./readers.mjs";
import { execGitRunner, makeRepo, tmpDir } from "./testHelpers.mjs";

const fakeLint = async () => ({ preset: { meta: { id: "p" } }, lintSource: async () => ({ messages: [] }) });
const exists = (p) => access(p).then(() => true, () => false);
const changesOf = async (engine) => (await engine.changes({ limit: 200 })).items;
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** A V1-shaped opencode message. */
const msg = (id, role, text, at, tools = []) => ({
  info: { id, role, time: { created: at } },
  parts: [{ type: "text", id: `prt_${id}`, text }, ...tools.map((command, i) => ({ type: "tool", id: `prt_${id}_t${i}`, tool: "bash", state: { status: "completed", input: { command }, output: "ok" } }))],
});

const UEV = {
  ses_one: [msg("msg_1", "user", "no, use pnpm not npm", 1), msg("msg_2", "user", "I told you before: use pnpm", 2)],
  ses_two: [msg("msg_3", "user", "pnpm please, never npm", 1)],
};
const USER_MESSAGES = new Set(["msg_1", "msg_2", "msg_3"]);
const threeQuotes = [["msg:ses_one/msg_1", "use pnpm not npm"], ["msg:ses_one/msg_2", "use pnpm"], ["msg:ses_two/msg_3", "pnpm please"]];
const ruleDecision = (content = "Use pnpm, never npm") => ({ type: "rule.add", target: { area: "project" }, content, reason: "The same correction three times", evidence: threeQuotes.map(([ref, quote]) => ({ ref, quote })) });
const refs3 = ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_3"];
const decide = (decisions) => ({ text: JSON.stringify({ decisions }) });

/** A bare "remote" with a README on main, for the repository writer. */
async function bareRemote() {
  const root = await tmpDir("knowledge-e2e-remote-");
  const remote = join(root, "remote.git");
  const g = execGitRunner(root);
  await g.run(["init", "--bare", "-q", "-b", "main", remote]);
  const seed = join(root, "seed");
  await mkdir(seed);
  const sg = execGitRunner(seed);
  await sg.run(["init", "-q", "-b", "main"]);
  await writeFile(join(seed, "README.md"), "# Widget\n");
  await sg.run(["add", "-A"]);
  await sg.run([...ID, "commit", "-q", "-m", "init"]);
  await sg.run(["remote", "add", "origin", `file://${remote}`]);
  await sg.run(["push", "-q", "origin", "main"]);
  return { remote, g, show: (ref, path = "AGENTS.md") => g.run(["--git-dir", remote, "show", `${ref}:${path}`]).catch(() => null) };
}

async function e2eRig({ stored, transcripts = {}, runner, sessions = { ses_one: "widget", ses_two: "widget" }, projects = { widget: "https://github.com/acme/widget.git" }, userMessages = USER_MESSAGES, remote = null, facts = null, over = {}, partsOver = {} } = {}) {
  const dir = await tmpDir("knowledge-e2e-");
  const home = await tmpDir("knowledge-e2e-home-");
  const repos = {};
  for (const [name, url] of Object.entries(projects)) repos[name] = await makeRepo({ remote: url });
  const clock = { t: Date.parse("2026-11-17T10:00:00") };
  let cfg = { knowledge: stored };
  if (facts) {
    // the engine's first maintenance pass runs at start: the blackboard has to be there already
    await mkdir(join(home, "facts"), { recursive: true });
    for (const [name, doc] of Object.entries(facts)) await writeFile(join(home, "facts", `${name}.json`), JSON.stringify(doc));
  }
  const notes = [];
  const calls = [];
  const forge = { created: [], updated: [], prs: [] };
  const oc = {
    sessionsCreated: [],
    listMessages: async (sid) => transcripts[sid] ?? [],
    createSession: async (a) => (oc.sessionsCreated.push(a), { id: a.id }),
    sendPrompt: async ({ sessionId }) => void setImmediate(() => oc.onPrompt?.(sessionId)),
    abortSession: async () => {},
    deleteSessionRaw: async () => {},
  };
  const sessionOf = (mid) => Object.keys(transcripts).find((s) => (transcripts[s] ?? []).some((m) => (m.info?.id ?? m.id) === mid)) ?? null;
  const roleOf = async (sid, mid) => (transcripts[sid] ?? []).find((m) => (m.info?.id ?? m.id) === mid)?.info?.role ?? null;
  const promptOrigins = { getRecord: (mid) => (userMessages.has(mid) ? { origin: "user", sessionID: sessionOf(mid) } : null) };
  const listMessages = (sid) => oc.listMessages(sid);
  const modelRunner = async (args) => {
    calls.push({ taskClass: args.taskClass, operation: args.operation, text: args.context.map((b) => b.text).join("\n\n") });
    const out = (await runner?.(args, calls)) ?? decide([]);
    if (out?.ok !== false) await args.deps?.reportCost?.({ taskClass: args.taskClass, tier: "mid", model: { providerID: "p", modelID: "m" }, tokens: 4000 });
    return out;
  };
  const skillsDir = join(home, "skills");
  const globalAgentsPath = join(home, "AGENTS.md");
  const worktrees = [];
  let engine;
  engine = createKnowledgeEngine({
    dir,
    git: execGitRunner(dir),
    config: { get: async () => cfg, update: async (p) => (cfg = { ...cfg, ...p }) },
    getSession: async (id) => ({ directory: repos[sessions[id]] ?? repos[Object.keys(repos)[0]] }),
    isCtoSession: async () => false,
    loadLint: fakeLint,
    secretValues: () => [],
    fireNotify: async (n) => notes.push(n),
    maintenanceMs: 3_600_000,
    curatorMs: 3_600_000,
    log: () => {},
    listSessionsPage: async () => [],
    now: () => clock.t,
    getRepoAccess: async () => ({ canPush: true, isFork: false, defaultBranch: "main" }),
    hasForgeLogin: async () => true,
    isUserAuthoredRef: createIsUserAuthoredRef(promptOrigins, { readRole: roleOf }),
    readMessages: createMessageReader({ listMessages }),
    readShellCommands: createShellCommandReader({ listMessages }),
    runEphemeral: modelRunner,
    resolveModelForClass: async () => ({ providerID: "p", modelID: "m" }),
    globalAgentsPath,
    createParts: (foundation) =>
      createKnowledgeParts(foundation, {
        runEphemeral: modelRunner,
        resolveModelForClass: async () => ({ providerID: "p", modelID: "m" }),
        configGet: async () => cfg,
        oc,
        local: {
          gitAddWorktree: async ({ name }) => {
            const path = await tmpDir(`wt-${name}-`);
            worktrees.push(path);
            return { path };
          },
          gitRemoveWorktree: async () => {},
        },
        runDbTask: async (task) => (task === "sessionsInRange" ? [] : { rows: [], complete: true }),
        listTmuxProjects: async () => [{ tmuxSession: "widget-session", windows: [{ paneCurrentPath: repos.widget }] }],
        isUserAuthored: createIsUserAuthored(promptOrigins),
        getSession: async (id) => ({ directory: repos[sessions[id]] ?? repos[Object.keys(repos)[0]] }),
        isCtoSession: async () => false,
        forge: {
          repoAccess: async () => ({ ok: true, canPush: true, isFork: false, defaultBranch: "main" }),
          findOpenPullRequest: async (_t, head) => ({ ok: true, pr: forge.prs.find((p) => p.headRef === head && p.state === "open") ?? null }),
          createPullRequest: async (_t, input) => {
            forge.created.push(input);
            const pr = { number: forge.prs.length + 1, url: `https://github.com/acme/widget/pull/${forge.prs.length + 1}`, headRef: input.head, state: "open", body: input.body };
            forge.prs.push(pr);
            return { ok: true, pr };
          },
          updatePullRequest: async (_t, input) => {
            forge.updated.push(input);
            const pr = forge.prs.find((p) => p.number === input.number);
            pr.body = input.body ?? pr.body;
            return { ok: true, pr };
          },
        },
        resolveToken: async () => null,
        fireNotify: async (n) => notes.push(n),
        skillsDir,
        factsDir: join(home, "facts"),
        remoteUrlFor: remote ? () => `file://${remote.remote}` : undefined,
        ...partsOver,
      }),
    ...over,
  });
  await engine.start();
  const started = (id) => ({ type: "session.execution.started", data: { sessionID: id } });
  const slugOf = async (sid) => {
    await engine.observeRaw(started(sid));
    return engine.sessionMap.get(sid)?.slug;
  };
  const post = async (path, body) => {
    let out;
    await handleKnowledgeRoute({ engine, req: { method: "POST" }, res: {}, path, url: new URL(`http://box${path}`), readJsonBody: async () => body, respondJson: (_r, status, b) => (out = { status, body: b }) });
    return out;
  };
  return { engine, dir, home, repos, clock, calls, notes, forge, oc, worktrees, skillsDir, globalAgentsPath, slugOf, post, channels: buildKnowledgeChannels(engine), setTranscripts: (t) => Object.assign(transcripts, t) };
}

test("every part reports on with the production wiring", async () => {
  const r = await e2eRig({});
  const { parts } = await r.engine.status();
  for (const k of ["curator", "userAuthorship", "commandCheck", "corrections", "repoWriter", "skills", "globalBlock", "capture", "trial", "blackboardImport", "ctoMirror", "weeklyNotice"]) {
    assert.equal(parts[k], "on", `${k}: ${parts[k]}`);
  }
  await r.engine.stop();
});

test("a rule travels notes → curator → store commit → briefing → undo (RPC) → tombstone → the same proposal is dropped", async () => {
  const r = await e2eRig({
    transcripts: UEV,
    runner: (a) => {
      if (a.taskClass === "curator-notes") return decide([{ type: "page.edit", target: { area: "project", path: `projects/${r.slug}/gotchas.md` }, content: "- The cache needs a warm-up.\n", reason: "Seen in the notes", evidence: [{ ref: "msg:ses_one/msg_1" }] }]);
      if (a.taskClass === "curator-rules") return decide([ruleDecision()]);
      return decide([]);
    },
  });
  r.slug = await r.slugOf("ses_one");
  await r.slugOf("ses_two");
  assert.ok(r.slug);

  // notes arrive through the AI-facing POST route
  assert.deepEqual((await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "gotcha", text: "The cache needs a warm-up", refs: ["msg:ses_one/msg_1"] })).body.accepted, true);
  const pref = await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "preference", text: "Use pnpm instead of npm", refs: refs3 });
  assert.equal(pref.status, 200);
  assert.equal(pref.body.accepted, true);

  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.applied, 2, JSON.stringify(out));
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8"), /warm-up/);
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/rules.md`), "utf8"), /- Use pnpm, never npm/);
  const trailers = (await r.engine.store.log({ limit: 10 })).filter((c) => c.trailers["Manta-Decision"]);
  assert.equal(trailers.length, 2);

  // the briefing a new session reads carries the rule
  await r.engine.refreshDerived();
  const b = await r.engine.briefing({ sessionID: "ses_one", assistantMessages: 0 });
  assert.match(b.text, /Standing rules from the user for this project:\n- Use pnpm, never npm/);

  // undo over the desktop RPC channel reverts the commit and writes a tombstone
  const ruleChange = (await changesOf(r.engine)).find((c) => c.kind === "applied" && /pnpm/.test(c.summary));
  assert.ok(ruleChange?.undoable);
  assert.deepEqual(await r.channels["knowledge:undo"]({ id: ruleChange.id }), { ok: true });
  assert.doesNotMatch((await readFile(join(r.dir, `projects/${r.slug}/rules.md`), "utf8").catch(() => "")) || "", /Use pnpm, never npm/);
  const tomb = JSON.parse(await r.engine.store.read("tombstones.json"));
  assert.equal(tomb.tombstones.filter((t) => t.kind === "rule").length, 1);
  assert.ok((await changesOf(r.engine)).find((c) => c.id === ruleChange.id).undoneAt);
  await r.engine.refreshDerived();
  assert.doesNotMatch((await r.engine.briefing({ sessionID: "ses_one", assistantMessages: 0 })).text, /Use pnpm, never npm/);

  // the same proposal later is dropped, with its reason on record
  await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "preference", text: "Please keep using pnpm only", refs: refs3 });
  const again = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(again.applied, 0, JSON.stringify(again));
  assert.doesNotMatch(await readFile(join(r.dir, `projects/${r.slug}/rules.md`), "utf8").catch(() => ""), /Use pnpm, never npm/);
  const refused = (await changesOf(r.engine)).filter((c) => (c.kind === "dropped" || c.kind === "skipped") && /undid|undone|before/i.test(c.reason));
  assert.ok(refused.length >= 1, JSON.stringify((await changesOf(r.engine)).map((c) => [c.kind, c.reason])));
  await r.engine.stop();
});

test("pull-request mode: the rule goes to the repository through the repo writer; one first-write notice; update, then undo", async () => {
  const remote = await bareRemote();
  const r = await e2eRig({
    stored: { repoRules: "pull-request" },
    transcripts: UEV,
    remote,
    runner: (a) => (a.taskClass === "curator-rules" ? decide([ruleDecision(r.next ?? "Use pnpm, never npm")]) : decide([])),
  });
  r.slug = await r.slugOf("ses_one");
  await r.slugOf("ses_two");
  await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "preference", text: "Use pnpm instead of npm", refs: refs3 });
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.applied, 1, JSON.stringify(out));

  assert.equal(r.forge.created.length, 1);
  assert.equal(r.forge.created[0].head, "manta/knowledge");
  assert.match((await remote.show("manta/knowledge")) ?? "", /Use pnpm, never npm/);
  assert.equal(await remote.show("main"), null, "main is untouched in pull-request mode");
  const outward = (await changesOf(r.engine)).find((c) => c.kind === "outward");
  assert.ok(outward?.undoable);
  const full = r.engine.changesLog.get(outward.id);
  assert.equal(full.data.outward.slug, r.slug);
  assert.equal(full.data.outward.mode, "pull-request");
  assert.ok(full.data.outward.sha);
  assert.equal(r.notes.filter((n) => n.tag === `knowledge-outward-${r.slug}`).length, 1, "exactly one first-write notice, from the repo writer");

  // a second rule refreshes the same pull request and adds no second notice
  r.next = "Run the tests before committing";
  await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "preference", text: "Always run tests before you commit", refs: refs3 });
  assert.equal((await r.engine.runCurator(r.slug, { force: true })).applied, 1);
  assert.equal(r.forge.created.length, 1);
  assert.ok(r.forge.updated.length >= 1);
  assert.equal(r.notes.filter((n) => n.tag === `knowledge-outward-${r.slug}`).length, 1);

  // undoing the (latest) repository change takes the rule off the branch again
  const outwards = (await changesOf(r.engine)).filter((c) => c.kind === "outward" && c.undoable);
  const latest = outwards[0];
  const res = await r.channels["knowledge:undo"]({ id: latest.id });
  assert.deepEqual(res, { ok: true }, JSON.stringify(res));
  assert.doesNotMatch((await remote.show("manta/knowledge")) ?? "", /Run the tests before committing/);
  await r.engine.stop();
});

test("the weekly summary is sent once, by the weekly notice — not by the tidy-up, not by the curator", async () => {
  const r = await e2eRig({
    transcripts: UEV,
    runner: (a) => (a.taskClass === "curator-rules" ? decide([ruleDecision()]) : decide([])),
  });
  r.slug = await r.slugOf("ses_one");
  await r.slugOf("ses_two");
  await r.engine.maintenance(); // starts the weekly clock
  await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "preference", text: "Use pnpm instead of npm", refs: refs3 });
  await r.engine.runCurator(r.slug, { force: true });
  r.clock.t += 8 * 24 * 3600 * 1000;
  await r.engine.runTidy({ force: true });
  await r.engine.maintenance();
  const weekly = r.notes.filter((n) => n.tag === "knowledge-weekly");
  assert.equal(weekly.length, 1, JSON.stringify(r.notes.map((n) => n.tag)));
  assert.match(weekly[0].message, /This week/);
  await r.engine.maintenance();
  assert.equal(r.notes.filter((n) => n.tag === "knowledge-weekly").length, 1, "not again until next week");
  await r.engine.stop();
});

test("capture runs from the maintenance tick, the blackboard import and the cto_fact mirror enqueue notes", async () => {
  const idle = [msg("msg_a", "user", "how do I run the e2e suite?", 1), msg("msg_b", "assistant", "npm run e2e", 2, ["npm run e2e"]), msg("msg_c", "user", "ok thanks, always use the e2e suite", 3), msg("msg_d", "user", "and build first", 4)];
  const r = await e2eRig({
    transcripts: { ses_cap: idle },
    sessions: { ses_cap: "widget" },
    facts: { "widget-session": { v: 1, facts: [{ kind: "decision", statement: "Releases are cut from main", refs: [], sender: {} }] } },
    runner: (a) => (a.taskClass === "knowledge-capture" ? { text: JSON.stringify({ notes: [{ kind: "howto", text: "Run the e2e suite with npm run e2e", refs: ["m1"] }] }) } : decide([])),
  });

  const slug = await r.slugOf("ses_cap");
  await r.engine.maintenance(); // the blackboard import resumes until done
  assert.ok((await r.engine.queue.list(slug)).some((n) => n.origin === "import" && /Releases are cut from main/.test(n.text)), "blackboard import");
  assert.equal((await r.engine.queue.list(slug)).filter((n) => n.origin === "capture").length, 0, "not idle yet");

  r.clock.t += 11 * 60_000;
  await r.engine.maintenance();
  const captured = (await r.engine.queue.list(slug)).filter((n) => n.origin === "capture");
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].refs, ["msg:ses_cap/msg_a"]);
  assert.equal(r.calls.filter((c) => c.taskClass === "knowledge-capture").length, 1);
  assert.ok(r.engine.budget.spentToday() > 0, "capture's model spend is on the budget");

  const m = await r.engine.mirrorCtoFact({ project: "widget-session", kind: "decision", statement: "Deploys happen on tags", refs: [] });
  assert.equal(m.enqueued, true, JSON.stringify(m));
  assert.ok((await r.engine.queue.list(slug)).some((n) => n.origin === "cto" && /Deploys happen on tags/.test(n.text)));
  const none = await r.engine.mirrorCtoFact({ project: "no-such-session", kind: "decision", statement: "x", refs: [] });
  assert.equal(none.enqueued, false);
  await r.engine.stop();
});

test("a learned skill: capture notes + runbooks → detect → evidence bar → trial (completion via observeRaw) → grade → daily flush → undo → tombstone", async () => {
  const widgetRepo = "https://github.com/acme/widget.git";
  const gadgetRepo = "https://github.com/acme/gadget.git";
  const work = (sid, base) => [
    msg(`${sid}_u1`, "user", `please run the e2e suite for ${sid}`, base),
    msg(`${sid}_a1`, "assistant", "building", base + 1, ["npm run build", "npm run e2e"]),
    msg(`${sid}_u2`, "user", "thanks, that is how I like it", base + 2),
    msg(`${sid}_u3`, "user", "also run it again later", base + 3),
  ];
  const transcripts = { ses_w1: work("ses_w1", 1_000), ses_w2: work("ses_w2", 2_000), ses_g1: work("ses_g1", 3_000) };
  const userMessages = new Set(Object.keys(transcripts).flatMap((s) => [`${s}_u1`, `${s}_u2`, `${s}_u3`]));
  const candidate = {
    name: "Run the e2e suite",
    title: "Run e2e",
    description: "Run the e2e suite locally",
    steps: [{ command: "npm run build", purpose: "Build" }, { command: "npm run e2e", purpose: "Run it" }],
    sessions: ["ses_w1", "ses_g1"],
    requests: [
      { sessionID: "ses_w1", messageID: "ses_w1_u1", quote: "please run the e2e suite" },
      { sessionID: "ses_g1", messageID: "ses_g1_u1", quote: "please run the e2e suite" },
    ],
  };
  const r = await e2eRig({
    transcripts,
    userMessages,
    projects: { widget: widgetRepo, gadget: gadgetRepo },
    sessions: { ses_w1: "widget", ses_w2: "widget", ses_g1: "gadget" },
    runner: (a) => {
      if (a.taskClass === "knowledge-capture") {
        const sid = /ses_[a-z0-9]+/.exec(a.context[0].text.split("TRANSCRIPT")[1])?.[0] ?? "";
        return { text: JSON.stringify({ notes: [{ kind: "howto", text: `Run the e2e suite: npm run build then npm run e2e (${sid})`, refs: ["m1"] }] }) };
      }
      if (a.operation === "detect-skills") return { text: JSON.stringify({ skills: [candidate] }) };
      if (a.operation === "trial-grade") return { text: JSON.stringify({ verdict: "pass", reason: "every step checks out" }) };
      return decide([]);
    },
  });
  // the trial session ends as soon as it is prompted: the completion arrives as a raw opencode event
  r.oc.onPrompt = (sessionId) => {
    transcripts[sessionId] = [msg("msg_t1", "assistant", "STEP 1: VALID - ok\nSTEP 2: VALID - ok\nVERDICT: PASS", 1)];
    void r.engine.observeRaw({ type: "session.execution.succeeded", data: { sessionID: sessionId } });
  };

  for (const sid of ["ses_w1", "ses_w2", "ses_g1"]) await r.slugOf(sid);
  await r.engine.maintenance();
  r.clock.t += 11 * 60_000;
  await r.engine.maintenance(); // capture: one note per session, kept as skill evidence
  assert.ok(r.calls.filter((c) => c.taskClass === "knowledge-capture").length >= 3);

  const tidy = await r.engine.runTidy({ force: true });
  assert.equal(tidy.status, "ran");
  assert.equal(tidy.skillsDetected, 1, JSON.stringify(tidy));
  assert.equal(r.oc.sessionsCreated.length, 1, "one trial session");
  const trialSession = r.oc.sessionsCreated[0];
  assert.equal(trialSession.metadata.manta.knowledgeTrial, trialSession.id);
  assert.equal(trialSession.permission[0].action, "deny", "deny-first ruleset");
  const skills = r.engine.parts.handles.skills;
  assert.deepEqual(skills.pendingWrites().map((w) => [w.op, w.name]), [["install", "learned-run-the-e2e-suite"]]);
  assert.equal(await exists(join(r.skillsDir, "learned-run-the-e2e-suite")), false, "nothing is written before the daily batch");

  // the curator's daily batch (after 04:00) applies the queued install
  await r.engine.layer.curator.tick();
  assert.equal(await exists(join(r.skillsDir, "learned-run-the-e2e-suite", "SKILL.md")), true);
  const installed = (await changesOf(r.engine)).find((c) => c.kind === "applied" && /skill/i.test(c.summary));
  assert.ok(installed?.undoable);
  const data = r.engine.changesLog.get(installed.id).data;
  assert.equal(data.skillSlug, "learned-run-the-e2e-suite");
  assert.deepEqual(data.sessions.sort(), ["ses_g1", "ses_w1"]);
  assert.equal(skills.list().find((s) => s.slug === "learned-run-the-e2e-suite").status, "installed");

  // undo removes it, writes a skill tombstone, and the pipeline refuses the same procedure afterwards
  assert.deepEqual(await r.channels["knowledge:undo"]({ id: installed.id }), { ok: true });
  assert.equal(await exists(join(r.skillsDir, "learned-run-the-e2e-suite")), false);
  const tomb = JSON.parse(await r.engine.store.read("tombstones.json"));
  assert.equal(tomb.tombstones.filter((t) => t.kind === "skill").length, 1);
  const same = await skills.propose(candidate);
  assert.equal(same.repeated, true, "the identical draft is remembered, never re-proposed");
  const reworded = await skills.propose({ ...candidate, name: "Run the whole e2e suite", title: "Run the whole e2e suite" });
  assert.equal(reworded.status, "tombstoned", JSON.stringify(reworded));
  assert.deepEqual(skills.pendingWrites(), []);
  await r.engine.stop();
});

test("a trial with no source clone is skipped before any session exists", async () => {
  const r = await e2eRig({});
  const trial = r.engine.parts.handles.trial;
  assert.ok(trial);
  const res = await trial.run({ skillName: "learned-x", skillMd: "x", slugs: [] });
  assert.deepEqual([res.status, res.reason], ["skipped", "no-clone"]);
  assert.equal(r.oc.sessionsCreated.length, 0);
  await r.engine.stop();
});

test("status reflects reality: spend, and 'waiting for a capable model' once the curator has waited 24 hours", async () => {
  const r = await e2eRig({
    transcripts: UEV,
    runner: (a) => (a.taskClass === "curator-notes" ? { ok: false, code: "no-qualifying-model" } : decide([])),
  });
  r.slug = await r.slugOf("ses_one");
  await r.post("/api/knowledge/notes", { sessionID: "ses_one", kind: "gotcha", text: "The cache needs a warm-up", refs: ["msg:ses_one/msg_1"] });
  assert.equal((await r.engine.runCurator(r.slug, { force: true })).status, "waiting");
  assert.equal(toSettingsWire(await r.engine.settingsGet(), r.engine, r.clock.t).waitingForCapableModel, undefined, "not yet 24 hours");
  r.clock.t += 25 * 3600 * 1000;
  await r.engine.runCurator(r.slug, { force: true });
  const s = toSettingsWire(await r.engine.settingsGet(), r.engine, r.clock.t);
  assert.equal(s.waitingForCapableModel, true);
  assert.equal(typeof s.spentTodayUsd, "number");
  assert.equal(s.enabled, true);
  await r.engine.stop();
});

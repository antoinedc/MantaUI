// Architect v2, Stage 1 (docs/superpowers/specs/2026-11-27-architect-v2.md §3.3): trial runs of a drafted agent.
//
// The Architect drafts an agent and runs it on 1–3 sample tasks in a throwaway copy of a project before proposing it. The
// server runs the cases (headless internal sessions, never a sidebar row), records what happened, and later checks, as FACTS,
// that the trial ran on exactly the draft that is proposed and that the Architect's verdicts quote the transcripts
// (`agent_propose`, src/server/agents.mjs). Whether a case passed is the Architect's judgement; nothing here knows what a good
// agent is.
//
// Tools (Architect only, each bound to the live Architect job by the agents engine, like `agent_propose`):
//   agent_trial       { action, agent?, baseHash?, draft, cases[1..3] } → { trialId, draftHash } at once; the cases run in the background
//   agent_trial_wait  { trialId } → { state, cases } when every case ended, or after at most WAIT_MS
//   agent_trial_read  { trialId, case, offset? } → { text, nextOffset } — 20 000 characters of the redacted transcript
//
// Containment (spec §7): a throwaway git worktree of the project (or an empty scratch repo OUTSIDE ~/.manta — the rulesets protect
// ~/.manta by absolute path, which only works for a session that doesn't live in it), a symlink scan, no secrets, the kinds
// deploy / publish / send / delete / spend at "never", publishing and network-write commands and Manta's own side-effect tools
// denied, no user questions (answered by the server), a 15-minute ceiling, and cleanup — also when the Architect's round ends.
// Bash pattern denies are best effort, like every task's.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHITECT_TRIAL_TOOLS } from "../shared/agentsShared.mjs";
import { questionFromForm } from "../shared/opencodeV2.mjs";
import { withInternalMarker } from "./internalSessionMarker.mjs";
import { jobRules, DENIAL_TEXT_RE, isInsideMantaFolders } from "./autonomy.mjs";
import { buildReadOnlyAgentRuleset, buildWorktreeAgentRuleset, normalizeJobRuleset, withResearchToolAllows } from "./delegate.mjs";
import { withResearchGuidance } from "./researchLibrary.mjs";

/**
 * The hash of a draft's complete resulting file set: `{ "agent.md": <text>, "skills/<name>/<path>": <text>, … }`. ONE function,
 * used by the trial tools and by `agent_propose`, so "the trial ran on this exact draft" is a byte comparison.
 */
export const draftHash = (bundle) =>
  createHash("sha256")
    .update(JSON.stringify(Object.keys(bundle).sort().map((k) => [k, bundle[k]])))
    .digest("hex");

/** The files of `a` and `b` (two `{ path: value }` maps) that differ, sorted. */
export function differingFiles(a, b) {
  const paths = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...paths].filter((p) => a?.[p] !== b?.[p]).sort();
}

export const TRIALS_DIR = ".trials";
export const CASE_TIMEOUT_MS = 15 * 60_000;
export const WAIT_MS = 4 * 60_000;
export const MAX_CASES = 3;
export const MAX_RUNNING_CASES = 2; // box-wide, in the trials module's own queue (not the delegate cap)
export const MAX_TRIALS_PER_AGENT = 3; // per task
export const MAX_TRIALS_PER_TASK = 6;
export const READ_WINDOW = 20_000;
export const KEEP_MS = 30 * 24 * 3600 * 1000;
export const TRANSCRIPT_MAX = 200_000;
export const WORK_TYPE = "agent-trial";
export const TRIAL_AUTO_ANSWER = "This is a test run with no user: continue on your best assumption and say what you assumed";

const RESULT_FILE = "result.json";
const STATE_FILE = "state.json";
const PROJECT_RE = /^[a-z0-9-]+$/;
const ENDED = new Set(["done", "failed", "timed-out", "aborted"]);

// Manta's own side-effect tools and the ways to publish, send or write to the network. Appended LAST to the ruleset (last match wins).
const DENIED_TOOLS = [
  ...ARCHITECT_TRIAL_TOOLS,
  "agent_trial*",
  "agent_propose",
  "agent_change",
  "research_library_save",
  "delegate",
  "delegate_list",
  "delegate_send",
  "delegate_stop",
  "delegate_extend",
  "delegate*",
  "agent_handoff",
  "routine_create",
  "routine_update",
  "routine_run",
  "routine_delete",
  "routine_report",
  "routine_*",
  "schedule_create",
  "schedule_cancel",
  "schedule_*",
  "notify",
  "send_file",
  "serve_page",
];
const DENIED_COMMANDS = [
  "git push*",
  "gh pr *",
  "gh release *",
  "gh issue *",
  "gh api *",
  "curl *-X*",
  "curl *--request*",
  "curl *-d*",
  "curl *--data*",
  "curl *-F*",
  "curl *--form*",
  "curl *-T*",
  "wget *--post*",
  "ssh *",
  "scp *",
  "rsync *",
  "nc *",
];
// the kinds a trial may never reach, whatever the user's settings say
const NEVER_KINDS = ["deploy", "publish", "send_external", "delete_data", "spend"];

/** The trial's permission ruleset (Manta's spelling): the agent's own task rules for its isolation, no secrets, then the denies. Pure. */
export function buildTrialRuleset({ isolation, dir, home, policy, sessionID }) {
  const base = isolation === "worktree" ? buildWorktreeAgentRuleset({ home }) : buildReadOnlyAgentRuleset({ agentDir: dir, home });
  const never = { ...policy, ...Object.fromEntries(NEVER_KINDS.map((k) => [k, "never"])) };
  const denies = [
    ...DENIED_COMMANDS.map((pattern) => ({ permission: "bash", pattern, action: "deny" })),
    ...DENIED_TOOLS.map((permission) => ({ permission, pattern: "*", action: "deny" })),
  ];
  return normalizeJobRuleset([...withResearchToolAllows(base), ...jobRules(never, { home, agentDir: dir, projectPatterns: [], sessionID, noSecrets: true }), ...denies], { allowQuestion: true });
}

const text = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;
const safelyAsync = async (fn) => {
  try {
    await fn();
  } catch {
    /* best effort */
  }
};
const oneLine = (v) => !/[\r\n\u2028\u2029]/.test(v);
const parseModel = (m) => {
  const i = typeof m === "string" ? m.indexOf("/") : -1;
  return i > 0 && i < m.length - 1 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : undefined;
};

const clip = (v, n) => {
  const s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** What a finished session shows, from its messages: final answer, tools, denials, questions, usage and the transcript text. Pure. */
export function readCase(messages) {
  const tools = new Set();
  const refused = [];
  const wouldAsk = [];
  const lines = [];
  let finalAnswer = null;
  let usd = 0;
  let model;
  let sawUsage = false;
  const tokens = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const assistant = role === "assistant";
    const info = m.info ?? {};
    if (assistant) {
      if (typeof info.cost === "number") {
        usd += info.cost;
        sawUsage = true;
      }
      if (info.tokens && typeof info.tokens === "object") {
        tokens.input += Number(info.tokens.input) || 0;
        tokens.output += Number(info.tokens.output) || 0;
        tokens.cache.read += Number(info.tokens.cache?.read) || 0;
        tokens.cache.write += Number(info.tokens.cache?.write) || 0;
        sawUsage = true;
      }
      if (info.providerID && info.modelID) model = { providerID: info.providerID, modelID: info.modelID };
    }
    for (const p of Array.isArray(m.parts) ? m.parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && !p.synthetic && p.text.trim()) {
        lines.push(`${assistant ? "Assistant" : "User"}: ${p.text.trim()}`);
        if (assistant) finalAnswer = p.text.trim();
      } else if (assistant && p?.type === "tool") {
        const name = String(p.tool ?? "");
        tools.add(name);
        const st = p.state ?? {};
        const failed = st.status === "error";
        lines.push(`Tool ${name} ${clip(st.input, 300)} → ${failed ? `ERROR ${clip(st.error, 500)}` : clip(st.output, 800)}`);
        if (failed && typeof st.error === "string" && DENIAL_TEXT_RE.test(st.error)) refused.push(st.error.split("\n")[0].trim());
        if (name === "question") for (const q of Array.isArray(st.input?.questions) ? st.input.questions : []) if (typeof q?.question === "string" && q.question.trim()) wouldAsk.push(q.question.trim());
      }
    }
  }
  return {
    finalAnswer,
    tools: [...tools].sort(),
    refused: [...new Set(refused)],
    wouldAsk: [...new Set(wouldAsk)],
    transcript: lines.join("\n\n"),
    usage: sawUsage ? { tokens, ...(usd > 0 ? { usd } : {}), ...(model ? { model } : {}) } : null,
  };
}

/**
 * deps:
 *   root            ~/.manta/agents (trials live in `<root>/.trials/<id>/`)
 *   home            the box user's home (for the rulesets)
 *   scratchRoot     where an empty scratch repo is made (default: the OS temp folder)
 *   agents()        the agents engine, read at call time: { bindArchitect(b, tool), trialPlan(input, {dir}) }
 *   oc              { createSession, sendPrompt, abortSession, deleteSessionRaw, listMessages, replyQuestion }
 *   local           { gitAddWorktree({cwd, name}), gitRemoveWorktree({path, force}) }
 *   gitRun(args)    git through the box's own runner → { stdout }
 *   editConfig      the opencode config writer (an agent block per trial)
 *   budget          { canSpend({workType, model?}) → {ok, reason?}, book({workType, model, usage, usd, inLedger}) }
 *   policy()        the user's autonomy policy (read strictly; a throw fails the case)
 *   projectDirectory(slug) → a checkout of that project on this box, or null
 *   scanSymlinks(path) → {ok, outside?, reason?}, redact(text) → {text, unavailable}
 */
export function createAgentTrials({
  root,
  home,
  scratchRoot = join(tmpdir(), "manta-agent-trials"),
  agents,
  oc,
  local,
  gitRun,
  editConfig,
  budget,
  policy,
  projectDirectory = async () => null,
  scanSymlinks = () => ({ ok: true }),
  redact = async (t) => ({ text: t, unavailable: false }),
  fs = fsPromises,
  mint = () => `tr_${randomBytes(6).toString("hex")}`,
  mintSession = () => `ses_${randomUUID().replaceAll("-", "")}`,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  caseTimeoutMs = CASE_TIMEOUT_MS,
  waitMs = WAIT_MS,
  log = console,
} = {}) {
  const trialsRoot = join(root, TRIALS_DIR);
  const trials = new Map(); // id → trial (see `create`)
  const live = new Set(); // block keys of trials that have not been cleaned up
  const bySession = new Map(); // session id → { trial, idx, resolve }
  const queue = []; // { trial, idx }
  let running = 0;

  const keyOf = (id) => `agent-trial-${id}`;
  const dirOf = (id) => join(trialsRoot, id);

  // ---- views ----

  const caseView = (c) => ({
    name: c.name,
    expect: c.expect,
    state: c.state,
    finalAnswer: c.finalAnswer ?? null,
    tools: c.tools ?? [],
    filesChanged: c.filesChanged ?? 0,
    refused: c.refused ?? [],
    wouldAsk: c.wouldAsk ?? [],
    durationMs: c.durationMs ?? null,
    error: c.error ?? null,
  });
  const view = (id) => {
    const t = trials.get(id);
    return t ? { id: t.id, rootJobId: t.rootJobId, agentSlug: t.agentSlug ?? null, draftHash: t.draftHash, createdAt: t.createdAt, cases: t.cases.map(caseView) } : null;
  };
  const allEnded = (t) => t.cases.every((c) => ENDED.has(c.state));

  // ---- the case runner ----

  async function writeState(t) {
    await safelyAsync(() => fs.writeFile(join(dirOf(t.id), STATE_FILE), JSON.stringify({ cases: t.cases.map((c) => ({ sessionId: c.sessionId ?? null, worktree: c.worktree ?? null, scratch: c.scratch ?? null })) })));
  }

  async function cleanupCase(t, c) {
    if (c.sessionId) {
      bySession.delete(c.sessionId);
      await safelyAsync(() => oc.deleteSessionRaw?.(c.sessionId));
    }
    if (c.worktree) {
      try {
        await local.gitRemoveWorktree({ path: c.worktree, force: true });
      } catch (e) {
        log.warn?.(`[agent-trials] worktree not removed: ${e?.message ?? e}`);
      }
    }
    if (c.scratch && c.scratch.startsWith(scratchRoot)) await safelyAsync(() => fs.rm(c.scratch, { recursive: true, force: true }));
    c.sessionId = null;
    c.worktree = null;
    c.scratch = null;
    await writeState(t);
  }

  /** The folder a case works in: a worktree of its project's checkout, or an empty scratch repo. `{ dir }` or `{ error }`. */
  async function workspaceFor(t, c, idx) {
    const slug = c.project ?? t.seat ?? null;
    const checkout = slug ? await projectDirectory(slug) : null;
    if (checkout) {
      let wt;
      try {
        wt = await local.gitAddWorktree({ cwd: checkout, name: `agent-trial-${t.id}-${idx}` });
      } catch (e) {
        return { error: `The project's copy couldn't be made: ${String(e?.message ?? e).slice(0, 160)}` };
      }
      c.worktree = wt.path;
      await writeState(t);
      const links = scanSymlinks(wt.path);
      if (!links.ok) return { error: links.outside ? `The project holds a link that leaves it (${links.outside}); it can't be copied safely` : `The project's copy couldn't be checked for links (${links.reason ?? "unknown"})` };
      return { dir: wt.path };
    }
    const scratch = join(scratchRoot, `${t.id}-${idx}`);
    if (isInsideMantaFolders(scratch, home)) return { error: "The scratch folder can't be inside Manta's own folders" };
    try {
      await fs.mkdir(scratch, { recursive: true });
      c.scratch = scratch;
      await writeState(t);
      await gitRun(["-C", scratch, "init", "-q"]);
      await gitRun(["-C", scratch, "-c", "user.name=Manta trial", "-c", "user.email=trial@manta.invalid", "commit", "--allow-empty", "-q", "-m", "start"]);
    } catch (e) {
      return { error: `The scratch repo couldn't be made: ${String(e?.message ?? e).slice(0, 160)}` };
    }
    return { dir: scratch };
  }

  async function runCase(t, idx) {
    const c = t.cases[idx];
    const started = now();
    const finish = async (state, extra = {}) => {
      Object.assign(c, { state, durationMs: now() - started }, extra);
      await cleanupCase(t, c);
    };
    try {
      if (t.aborted) return await finish("aborted", { durationMs: null });
      const model = parseModel(t.plan.meta?.model);
      const gate = await budget.canSpend({ workType: WORK_TYPE, ...(model ? { model } : {}) });
      if (!gate?.ok) return await finish("failed", { error: `Not run: the background budget doesn't allow it right now (${gate?.reason ?? "unavailable"})` });
      let policyNow;
      try {
        policyNow = await policy();
      } catch {
        return await finish("failed", { error: "Not run: the autonomy settings couldn't be read" });
      }
      const ws = await workspaceFor(t, c, idx);
      if (ws.error) return await finish("failed", { error: ws.error });
      if (t.aborted) return await finish("aborted", { durationMs: null });
      const sessionId = mintSession();
      c.sessionId = sessionId;
      const outcome = new Promise((resolve) => bySession.set(sessionId, { trial: t, idx, resolve }));
      c.state = "running";
      await writeState(t);
      try {
        await oc.createSession({
          id: sessionId,
          directory: ws.dir,
          title: `agent:trial · ${t.agentSlug ?? "agent"} · ${c.name}`,
          agent: keyOf(t.id),
          ...(model ? { model } : {}),
          permission: buildTrialRuleset({ isolation: t.plan.meta?.isolation === "worktree" ? "worktree" : "none", dir: dirOf(t.id), home, policy: policyNow, sessionID: sessionId }),
          metadata: withInternalMarker({ manta: { agentTrial: t.id, agentTrialCase: c.name } }),
        });
        await oc.sendPrompt({ sessionId, text: withResearchGuidance(c.task), agent: keyOf(t.id), ...(model ? { model } : {}) });
      } catch (e) {
        return await finish("failed", { error: `The test run couldn't start: ${String(e?.message ?? e).slice(0, 160)}` });
      }
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeoutFn(() => resolve({ outcome: "timeout" }), caseTimeoutMs);
        timer?.unref?.();
      });
      const end = await Promise.race([outcome, timeout]);
      if (timer) clearTimeoutFn(timer);
      if (end.outcome === "timeout" || end.outcome === "abort") await safelyAsync(() => oc.abortSession(sessionId));
      // what happened: read before the session is deleted
      let read = readCase([]);
      try {
        read = readCase(await oc.listMessages(sessionId));
      } catch (e) {
        log.warn?.(`[agent-trials] couldn't read a test run: ${e?.message ?? e}`);
      }
      let filesChanged = 0;
      try {
        filesChanged = String((await gitRun(["-C", ws.dir, "status", "--porcelain"]))?.stdout ?? "").split("\n").filter((l) => l.trim()).length;
      } catch {
        filesChanged = 0;
      }
      const redacted = await redact(read.transcript);
      let transcript = redacted.unavailable ? "[the transcript is not kept: the secret scanner couldn't run]" : String(redacted.text ?? "");
      if (transcript.length > TRANSCRIPT_MAX) transcript = `${transcript.slice(0, TRANSCRIPT_MAX)}\n[… truncated]`;
      const answer = read.finalAnswer === null ? null : (await redact(read.finalAnswer)).text;
      if (read.usage) {
        await safelyAsync(() => budget.book?.({ workType: WORK_TYPE, model: read.usage.model ?? model, usage: read.usage.tokens, ...(typeof read.usage.usd === "number" ? { usd: read.usage.usd } : {}), inLedger: false }));
      }
      const state = t.aborted || end.outcome === "abort" ? "aborted" : end.outcome === "timeout" ? "timed-out" : end.outcome === "succeeded" ? "done" : "failed";
      await finish(state, { finalAnswer: answer, tools: read.tools, filesChanged, refused: read.refused, wouldAsk: [...new Set([...(c.wouldAsk ?? []), ...read.wouldAsk])], transcript });
    } catch (e) {
      log.warn?.(`[agent-trials] a test run failed: ${e?.message ?? e}`);
      await finish("failed", { error: "The test run failed unexpectedly" }).catch(() => {});
    }
  }

  function pump() {
    while (running < MAX_RUNNING_CASES && queue.length > 0) {
      const { trial, idx } = queue.shift();
      if (ENDED.has(trial.cases[idx].state)) continue;
      trial.cases[idx].picked = true; // from here its own runner ends it (an abort of the round only flags it)
      running += 1;
      runCase(trial, idx)
        .catch((e) => log.warn?.(`[agent-trials] ${e?.message ?? e}`))
        .then(() => settleTrial(trial))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  /** When every case ended: write `result.json`, drop the block and the drafted files, wake the waiters. */
  async function settleTrial(t) {
    if (t.settled || !allEnded(t)) return;
    t.settled = true;
    try {
      const doc = { id: t.id, rootJobId: t.rootJobId, jobId: t.jobId, agentSlug: t.agentSlug, kind: t.kind, draftHash: t.draftHash, files: t.files, createdAt: t.createdAt, finishedAt: now(), cases: t.cases.map((c) => ({ ...caseView(c), task: c.task, checks: c.checks, project: c.project ?? null, transcript: c.transcript ?? "" })) };
      await fs.writeFile(join(dirOf(t.id), RESULT_FILE), `${JSON.stringify(doc)}\n`);
    } catch (e) {
      log.warn?.(`[agent-trials] couldn't write the result of ${t.id}: ${e?.message ?? e}`);
    }
    for (const c of t.cases) delete c.transcript; // read back from result.json from here on
    await dropBlock(t);
    await safelyAsync(async () => {
      for (const n of await fs.readdir(dirOf(t.id))) if (n !== RESULT_FILE) await fs.rm(join(dirOf(t.id), n), { recursive: true, force: true });
    });
    t.finish();
  }

  async function dropBlock(t) {
    const key = keyOf(t.id);
    live.delete(key);
    try {
      await editConfig((cfg) => (cfg?.agent?.[key] === undefined ? [] : [{ path: ["agent", key], value: undefined }]));
    } catch (e) {
      log.warn?.(`[agent-trials] couldn't drop ${key}: ${e?.message ?? e}`);
    }
  }

  // ---- raw events: how a case ends, and the question that is answered for it ----

  function observeRaw(ev) {
    const type = ev?.type;
    if (typeof type !== "string" || !type.startsWith("session.execution.")) return;
    const sid = ev?.data?.sessionID ?? ev?.properties?.sessionID;
    const hit = typeof sid === "string" ? bySession.get(sid) : null;
    if (hit) hit.resolve({ outcome: type.slice("session.execution.".length), error: ev?.data?.error?.message });
  }

  const ownsSession = (sid) => typeof sid === "string" && bySession.has(sid);

  /** A question form raised in a trial session: recorded as "would ask" and answered at once. `true` when it was ours. */
  async function handleQuestion(form) {
    const hit = bySession.get(form?.sessionID);
    if (!hit) return false;
    const q = questionFromForm(form);
    const c = hit.trial.cases[hit.idx];
    c.wouldAsk = [...new Set([...(c.wouldAsk ?? []), ...(q.questions ?? []).map((x) => x.question).filter(Boolean)])];
    try {
      await oc.replyQuestion({ requestId: form.id, answers: (q.questions ?? []).map(() => [TRIAL_AUTO_ANSWER]), sessionId: form.sessionID });
    } catch (e) {
      log.warn?.(`[agent-trials] couldn't answer a test run's question: ${e?.message ?? e}`);
    }
    return true;
  }

  // ---- the tools ----

  const refuse = (error) => ({ ok: false, error });
  const keyedInput = (input, keys) => ({
    sessionID: typeof input?.sessionID === "string" ? input.sessionID : "",
    messageID: typeof input?.messageID === "string" ? input.messageID : "",
    callID: typeof input?.callID === "string" ? input.callID : "",
    raw: Object.fromEntries(keys.filter((k) => input && typeof input === "object" && Object.hasOwn(input, k)).map((k) => [k, input[k]])),
  });

  function checkCases(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CASES) return { error: `Give 1 to ${MAX_CASES} cases` };
    const out = [];
    for (const c of raw) {
      if (!c || typeof c !== "object" || Array.isArray(c)) return { error: "Every case is an object {name, task, expect, checks}" };
      if (!text(c.name, 1, 60) || !oneLine(c.name)) return { error: "Every case needs a name of 1 to 60 characters on one line" };
      if (!text(c.task, 1, 2000)) return { error: `Case ${c.name}: the task must be 1 to 2000 characters` };
      if (c.expect !== "does" && c.expect !== "declines") return { error: `Case ${c.name}: expect must be "does" or "declines"` };
      const checks = (Array.isArray(c.checks) ? c.checks : [c.checks]).filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      if (checks.length < 1 || checks.length > 5 || checks.some((x) => x.length > 300)) return { error: `Case ${c.name}: checks is 1 to 5 lines (up to 300 characters each) saying what to look for` };
      if (c.project !== undefined && c.project !== null && (typeof c.project !== "string" || !PROJECT_RE.test(c.project))) return { error: `Case ${c.name}: project must be a project's id` };
      if (out.some((x) => x.name === c.name.trim())) return { error: `Two cases are called "${c.name.trim()}"; the names must be unique` };
      out.push({ name: c.name.trim(), task: c.task.trim(), expect: c.expect, checks, project: c.project ?? null });
    }
    return { cases: out };
  }

  async function create(input) {
    const b = keyedInput(input, ["action", "agent", "baseHash", "draft", "cases"]);
    const bound = await agents().bindArchitect(b, "agent_trial");
    if (bound.refused) return refuse(bound.refused);
    const checked = checkCases(input?.cases);
    if (checked.error) return refuse(checked.error);
    for (const c of checked.cases) {
      if (c.project && !(await projectDirectory(c.project))) return refuse(`Case ${c.name}: I can't find a checkout of the project "${c.project}" on this box`);
    }
    const rootJobId = bound.stamp.rootJobId;
    const id = mint();
    const plan = await agents().trialPlan({ action: input?.action, agent: input?.agent, baseHash: input?.baseHash, draft: input?.draft }, { dir: dirOf(id) });
    if (plan.error) return refuse(plan.error);
    const mine = [...trials.values()].filter((t) => t.rootJobId === rootJobId);
    if (mine.length >= MAX_TRIALS_PER_TASK) return refuse(`You've already run ${MAX_TRIALS_PER_TASK} trials in this task; that's the limit. Propose from what you have, or say what you couldn't establish`);
    if (mine.filter((t) => t.agentSlug === plan.slug).length >= MAX_TRIALS_PER_AGENT) return refuse(`You've already run ${MAX_TRIALS_PER_AGENT} trials of @${plan.slug} in this task; that's the limit`);

    const dir = dirOf(id);
    const key = keyOf(id);
    live.add(key); // before the block exists: a sync that runs in between must keep it
    try {
      for (const [rel, content] of Object.entries(plan.bundle)) {
        await fs.mkdir(join(dir, rel, ".."), { recursive: true });
        await fs.writeFile(join(dir, rel), content, "utf-8");
      }
      await fs.writeFile(join(dir, ".compiled.md"), plan.compiled, "utf-8");
      const r = await editConfig((cfg) => (JSON.stringify(cfg?.agent?.[key]) === JSON.stringify(plan.block) ? [] : [{ path: ["agent", key], value: plan.block }]));
      if (!r?.ok) throw new Error(r?.error ?? "the config couldn't be written");
    } catch (e) {
      live.delete(key);
      await safelyAsync(() => fs.rm(dir, { recursive: true, force: true }));
      await safelyAsync(() => editConfig((cfg) => (cfg?.agent?.[key] === undefined ? [] : [{ path: ["agent", key], value: undefined }])));
      log.warn?.(`[agent-trials] couldn't set a trial up: ${e?.message ?? e}`);
      return refuse("The trial couldn't be set up; try again");
    }
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    const trial = {
      id,
      rootJobId,
      jobId: bound.job.id,
      agentSlug: plan.slug,
      kind: plan.kind,
      draftHash: draftHash(plan.bundle),
      files: plan.files,
      createdAt: now(),
      plan: { meta: plan.meta },
      seat: Array.isArray(plan.seats) && plan.seats.length > 0 ? plan.seats[0] : null,
      aborted: false,
      settled: false,
      done,
      finish,
      cases: checked.cases.map((c) => ({ ...c, state: "queued", finalAnswer: null, tools: [], filesChanged: 0, refused: [], wouldAsk: [], durationMs: null, error: null })),
    };
    trials.set(id, trial);
    await writeState(trial);
    trial.cases.forEach((_, idx) => queue.push({ trial, idx }));
    pump();
    return { ok: true, trialId: id, draftHash: trial.draftHash, cases: trial.cases.map((c) => c.name) };
  }

  async function bindTrial(input, tool, keys) {
    const bound = await agents().bindArchitect(keyedInput(input, keys), tool);
    if (bound.refused) return { error: bound.refused };
    const id = typeof input?.trialId === "string" ? input.trialId : "";
    const t = await loadTrial(id);
    if (!t) return { error: `The trial ${id || "(none)"} doesn't exist (or is too old); run a trial again` };
    if (t.rootJobId !== bound.stamp.rootJobId) return { error: `The trial ${id} belongs to another task` };
    return { trial: t };
  }

  async function wait(input) {
    const got = await bindTrial(input, "agent_trial_wait", ["trialId"]);
    if (got.error) return refuse(got.error);
    const t = got.trial;
    if (!t.settled && t.done) {
      let timer;
      await Promise.race([
        t.done,
        new Promise((resolve) => (timer = setTimeoutFn(resolve, waitMs))), // (a pending request keeps the loop alive anyway)
      ]);
      clearTimeoutFn(timer);
    }
    return { ok: true, state: allEnded(t) ? "done" : "running", cases: t.cases.map(caseView) };
  }

  async function read(input) {
    const got = await bindTrial(input, "agent_trial_read", ["trialId", "case", "offset"]);
    if (got.error) return refuse(got.error);
    const name = typeof input?.case === "string" ? input.case : "";
    if (!got.trial.cases.some((c) => c.name === name)) return refuse(`There is no case "${name}" in this trial; the cases are: ${got.trial.cases.map((c) => c.name).join(", ")}`);
    const offset = input?.offset === undefined ? 0 : input.offset;
    if (!Number.isInteger(offset) || offset < 0) return refuse("offset must be a whole number from 0");
    const full = await transcript(got.trial.id, name);
    if (full === null) return refuse("That case's transcript isn't available yet; wait for the trial with agent_trial_wait");
    const slice = full.slice(offset, offset + READ_WINDOW);
    return { ok: true, text: slice, nextOffset: offset + READ_WINDOW < full.length ? offset + READ_WINDOW : null };
  }

  // ---- reads for the engine and the UI ----

  /** The result of a finished trial from disk (null when there is none). */
  async function readResult(id) {
    try {
      return JSON.parse(await fs.readFile(join(dirOf(id), RESULT_FILE), "utf-8"));
    } catch {
      return null;
    }
  }

  async function loadTrial(id) {
    if (typeof id !== "string" || !/^tr_[0-9a-f]+$/.test(id)) return null;
    return trials.get(id) ?? null;
  }

  /** The full redacted transcript of one case, or null (unknown case, not ended yet). */
  async function transcript(id, name) {
    const t = trials.get(id);
    const c = t?.cases.find((x) => x.name === name);
    if (!c) return null;
    if (typeof c.transcript === "string") return c.transcript;
    if (!ENDED.has(c.state)) return null;
    const doc = await readResult(id);
    const stored = doc?.cases?.find((x) => x.name === name)?.transcript;
    return typeof stored === "string" ? stored : null;
  }

  const list = (slug) =>
    [...trials.values()]
      .filter((t) => t.agentSlug === slug)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((t) => view(t.id));

  // ---- the end of a round, boot and age ----

  /** The Architect's round `jobId` ended (finished, failed or stopped): its queued and running cases are aborted and cleaned up. */
  async function abortForJob(jobId) {
    for (const t of trials.values()) {
      if (t.jobId !== jobId || t.settled) continue;
      t.aborted = true;
      // a case nobody picked up yet never starts; one that runs is interrupted and ends through its own runner
      for (const c of t.cases) if (c.state === "queued" && !c.picked) c.state = "aborted";
      for (const c of t.cases) {
        const hit = c.sessionId ? bySession.get(c.sessionId) : null;
        if (hit && c.state === "running") hit.resolve({ outcome: "abort" });
      }
      if (t.cases.every((c) => !c.picked)) {
        // nothing ran at all: settle it here
        for (const c of t.cases) await cleanupCase(t, c);
        await settleTrial(t);
      } else {
        let timer;
        await Promise.race([
          t.done,
          new Promise((resolve) => (timer = setTimeoutFn(resolve, 10_000))),
        ]);
        clearTimeoutFn(timer);
      }
    }
  }

  /** Boot: finished trials are read back; anything that never finished is cleaned up (session, workspace, drafted files). */
  async function recover() {
    let names = [];
    try {
      names = await fs.readdir(trialsRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^tr_[0-9a-f]+$/.test(name)) continue;
      const doc = await readResult(name);
      if (doc && Array.isArray(doc.cases)) {
        trials.set(name, {
          id: doc.id,
          rootJobId: doc.rootJobId,
          jobId: doc.jobId ?? null,
          agentSlug: doc.agentSlug ?? null,
          kind: doc.kind,
          draftHash: doc.draftHash,
          files: doc.files ?? {},
          createdAt: doc.createdAt,
          finishedAt: doc.finishedAt,
          settled: true,
          aborted: false,
          cases: doc.cases.map((c) => ({ ...caseView(c), task: c.task, checks: c.checks, project: c.project ?? null })),
        });
        continue;
      }
      let state = null;
      try {
        state = JSON.parse(await fs.readFile(join(trialsRoot, name, STATE_FILE), "utf-8"));
      } catch {
        state = null;
      }
      for (const c of Array.isArray(state?.cases) ? state.cases : []) {
        if (typeof c?.sessionId === "string" && c.sessionId) {
          await safelyAsync(() => oc.abortSession(c.sessionId));
          await safelyAsync(() => oc.deleteSessionRaw?.(c.sessionId));
        }
        if (typeof c?.worktree === "string" && c.worktree) await safelyAsync(() => local.gitRemoveWorktree({ path: c.worktree, force: true }));
        if (typeof c?.scratch === "string" && c.scratch.startsWith(scratchRoot)) await safelyAsync(() => fs.rm(c.scratch, { recursive: true, force: true }));
      }
      await safelyAsync(() => fs.rm(join(trialsRoot, name), { recursive: true, force: true }));
    }
  }

  /** Results older than 30 days are deleted. */
  async function sweep() {
    for (const [id, t] of [...trials]) {
      if (!t.settled || now() - (t.finishedAt ?? t.createdAt) < KEEP_MS) continue;
      trials.delete(id);
      await safelyAsync(() => fs.rm(dirOf(id), { recursive: true, force: true }));
    }
  }

  return {
    create,
    wait,
    read,
    get: (id) => trials.get(id) ?? null,
    view,
    list,
    transcript,
    activeTrialKeys: () => new Set(live),
    ownsSession,
    handleQuestion,
    observeRaw,
    abortForJob,
    recover,
    sweep,
  };
}

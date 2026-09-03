// src/server/ctoAct.mjs
// BET-1519 — the ONE generic §9.4 plan executor + the executor driver.
//
// D22 (spec v3): one generic executor runs every plan — no per-use-case
// handler anywhere. The per-class bound executors of BET-1424 (record-decision
// / queue-tonight / start-job branches + their payload normalizers) are
// retired; every plan runs the same way:
//
//   - an `act` plan (or an `ask` plan the user accepted, trigger "accepted")
//     runs in a CTO-owned session with plan.steps as its brief and
//     plan.access as its permission ruleset;
//   - the session kind comes from the plan: a delegate job (own worktree,
//     branch, sidebar row — through the shared startJobWithApproval path so
//     the ruleset always applies) when access includes `write`/`edit`, an
//     ephemeral session otherwise;
//   - after the turn goes idle the plan's verify check runs (§9.2): a
//     predicate statement against the §6.7 surfaces, a consented probe read,
//     the session's own CHECK marker, or the originating blocker's condition
//     being gone;
//   - fail → exactly one retry: the SAME session gets one more turn with the
//     failed check attached (fresh 30-minute budget); fail again → the
//     finding escalates to a human blocker card carrying the attempt log;
//   - every execution writes ONE `cto.resolve` ledger row (§9.4-9.5) and one
//     outcome into the resolve store; two executions per plan id, ever — a
//     cap-hit refusal degrades to ask, never acts;
//   - outcomes feed child #3's calibration (notePlanOutcome): `resolved` with
//     no correct/dismiss/veto verdict within 7 days → success (deferred); a
//     negative verdict in the window, or `escalated`, → failure.
//
// The driver (queue ≤ 10 FIFO with blocker-before-finding, ≤ 2 in flight,
// attempt cap, outcome bookkeeping, 7-day resolution scan) lives here as
// createCtoExecutorDriver; ctoEngine.mjs constructs it over the engine's
// stores/ledger/cards/calibration and drives it from cardTick.
//
// Pure over injected I/O — testable without a live opencode/tmux/delegate.

import { buildPermissionRuleset } from "./delegate.mjs";
import { appendLedgerBestEffort, patchStore } from "./ctoStores.mjs";

// §9.4 budgets. A turn runs until done (idle) with a hard 30-minute budget;
// a retry turn gets a fresh one. Poll cadence mirrors runSynchronousSession.
export const TURN_BUDGET_MS = 30 * 60_000;
export const TURN_POLL_MS = 1_000;
export const RESOLUTION_WINDOW_MS = 7 * 24 * 3_600_000; // §9.5 7-day success window
export const EXECUTIONS_PER_PLAN = 2; // two executions per plan id, ever
export const QUEUE_MAX = 10;
export const MAX_IN_FLIGHT = 2; // §3.3 concurrent-delegate sub-cap, §9.4

// The exact end-marker the brief asks the session to leave. session-ok
// verification reads it from the last assistant turn; predicate/probe/
// condition-gone verification ignores it (the §6.7 surface decides).
export const CHECK_MARKER = "CHECK:";

// ---------------------------------------------------------------------------
// Plan validation (§9.4 runtime shape — §9.2 schema, stricter)
// ---------------------------------------------------------------------------

/**
 * Validate a plan the way the executor will run it: an id, a non-empty steps
 * list, a normalized access list, and a verify check of a known kind with a
 * value. Returns {ok:true, plan} with whitespace-trimmed steps/access, or
 * {ok:false, reason:"invalid-plan:<what>"}.
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== "object") return { ok: false, reason: "invalid-plan:missing" };
  const id = typeof plan.id === "string" ? plan.id.trim() : "";
  if (!id) return { ok: false, reason: "invalid-plan:id" };
  const steps = Array.isArray(plan.steps)
    ? plan.steps.map((s) => String(s ?? "").trim()).filter(Boolean)
    : [];
  if (steps.length === 0) return { ok: false, reason: "invalid-plan:steps" };
  const access = Array.isArray(plan.access)
    ? plan.access
        .map((a) => {
          if (!a || typeof a !== "object") return null;
          const permission = typeof a.permission === "string" ? a.permission.trim() : "";
          const pattern = typeof a.pattern === "string" && a.pattern.trim() ? a.pattern : "*";
          if (!permission) return null;
          return { permission, pattern, action: a.action === "deny" ? "deny" : "allow" };
        })
        .filter(Boolean)
    : [];
  const verify = plan.verify && typeof plan.verify === "object" ? plan.verify : null;
  const kind = typeof verify?.kind === "string" ? verify.kind : "";
  if (!["predicate", "probe", "session-ok", "condition-gone"].includes(kind)) {
    return { ok: false, reason: `invalid-plan:verify:${kind || "missing"}` };
  }
  if (kind === "predicate" && typeof verify.condition !== "string") {
    return { ok: false, reason: "invalid-plan:verify:condition" };
  }
  if (kind === "probe" && typeof verify.probe !== "string") {
    return { ok: false, reason: "invalid-plan:verify:probe" };
  }
  if (kind === "condition-gone" && typeof verify.condition !== "string") {
    return { ok: false, reason: "invalid-plan:verify:condition" };
  }
  return {
    ok: true,
    plan: {
      ...plan,
      id,
      class: typeof plan.class === "string" ? plan.class : "other",
      steps,
      access,
      verify,
    },
  };
}

// §9.4: "the executor picks a delegate job (worktree, branch, sidebar row)
// when access includes write or edit, an ephemeral session otherwise."
export function wantsDelegateSession(access) {
  return (Array.isArray(access) ? access : []).some((a) => a?.permission === "write" || a?.permission === "edit");
}

// The permission ruleset for the session: the plan's access grants with the
// catch-all deny first (last-match-wins; opencode prepends its own allow-all
// default, so without the deny every ungranted tool resolves to allow).
export function permissionRulesetFor(access) {
  return buildPermissionRuleset(Array.isArray(access) ? access : []);
}

// ---------------------------------------------------------------------------
// The brief (§9.4 — plan.steps as the session's brief)
// ---------------------------------------------------------------------------

/**
 * The session prompt: identity, the finding, the diagnosis, the steps, the
 * do/do-not contract, the undo note, and the exact end-marker line. Pure.
 */
export function buildExecutionBrief(plan, { finding = null, project = null } = {}) {
  const lines = [];
  lines.push(
    "You are the CTO's execution session. Complete the steps below in this environment. Do not start unrelated work.",
  );
  lines.push("");
  lines.push("## Finding");
  lines.push(String(finding?.text ?? finding?.message ?? plan.finding?.text ?? "(no finding text)"));
  if (plan.diagnosis) {
    lines.push("");
    lines.push("## Diagnosis");
    lines.push(String(plan.diagnosis));
  }
  lines.push("");
  lines.push("## Steps");
  plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");
  lines.push("## Access");
  const access = wantsDelegateSession(plan.access)
    ? "You run in an isolated git worktree with the granted permissions only."
    : "You run in a read-only ephemeral session; work within the granted permissions only.";
  lines.push(access);
  if (plan.undo) {
    lines.push("");
    lines.push(`## Undo (if the check fails or the user asks)`);
    lines.push(String(plan.undo));
  }
  if (project) {
    lines.push("");
    lines.push(`Project: ${project}`);
  }
  lines.push("");
  lines.push(
    `## Done contract\nWhen the steps are complete, end your final message with a line that is exactly \`${CHECK_MARKER} pass\`. If you could not complete the steps, end with \`${CHECK_MARKER} fail: <one-line reason>\`.`,
  );
  return lines.join("\n");
}

/** The retry turn's prompt: the failed check result, one more try. */
export function buildRetryBrief(plan, check) {
  return [
    "Your previous attempt did not satisfy the verification check.",
    `Check that failed: ${check?.reason ?? "unspecified"}${check?.detail ? ` — ${check.detail}` : ""}.`,
    "Try the steps once more, fixing whatever the check exposed. Nothing else.",
    `End your final message with \`${CHECK_MARKER} pass\` on success or \`${CHECK_MARKER} fail: <reason>\` on failure.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Transcript helpers (pure — the session-ok check and cost accounting)
// ---------------------------------------------------------------------------

/** Role of a message row; tolerant of the opencode message shape. */
function roleOf(m) {
  const r = m?.role ?? m?.info?.role;
  return typeof r === "string" ? r.toLowerCase() : "";
}

/** Concatenated text of a message row. */
export function messageText(m) {
  const parts = [];
  const collect = (p) => {
    if (!p) return;
    if (typeof p === "string") {
      parts.push(p);
      return;
    }
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    if (Array.isArray(p)) p.forEach(collect);
    if (typeof p === "object") {
      if (Array.isArray(p.content)) p.content.forEach(collect);
      else if (typeof p.content === "string") parts.push(p.content);
    }
  };
  const c = m?.parts ?? m?.content ?? m?.text;
  if (Array.isArray(c)) c.forEach(collect);
  else if (typeof c === "string") parts.push(c);
  else if (c && typeof c === "object") collect(c);
  return parts.join("");
}

export function countAssistants(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => roleOf(m) === "assistant").length;
}

export function lastAssistantText(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (roleOf(rows[i]) === "assistant") return messageText(rows[i]);
  }
  return "";
}

/** The session's own completion marker (session-ok verification). */
export function checkMarkerResult(lastText) {
  const text = String(lastText ?? "");
  const lines = text.split("\n").filter((l) => l.includes(CHECK_MARKER));
  const last = lines[lines.length - 1] ?? "";
  const idx = last.indexOf(CHECK_MARKER);
  const rest = idx >= 0 ? last.slice(idx + CHECK_MARKER.length).trim() : "";
  if (/^pass\b/i.test(rest)) return { ok: true };
  if (/^fail\b/i.test(rest)) {
    const detail = rest.replace(/^fail:?\s*/i, "").trim();
    return { ok: false, reason: "session-reported-fail", detail };
  }
  return { ok: false, reason: "no-check-marker" };
}

/** Rough token estimate for the resolve row's cost field (ctoSessions' 4-chars/token). */
export function estimateCostTokens(chunks) {
  return (Array.isArray(chunks) ? chunks : []).reduce((sum, c) => sum + Math.ceil(String(c ?? "").length / 4), 0);
}

// ---------------------------------------------------------------------------
// Verify dispatch (§9.2 kinds)
// ---------------------------------------------------------------------------

/**
 * Run the plan's verify check. Returns {ok:boolean, reason?, detail?}.
 * kind → seam:
 *   predicate      → verifyFact(condition) — the §6.7 surface verifier
 *   probe          → probeRead(probe) — a consented §7.5 probe read
 *   session-ok     → the session's own CHECK marker in the last turn
 *   condition-gone → conditionGone(condition) — the originating blocker's
 *                    liveness predicate (§10.3) is now false
 * A seam returning a no-opinion (null/undefined) is a FAIL (unverified),
 * never a pass — verification is mandatory and never silently skipped.
 */
export async function runVerifyCheck(plan, ctx) {
  const verify = plan?.verify ?? {};
  const kind = verify.kind;
  if (kind === "session-ok") {
    const res = checkMarkerResult(ctx.lastText);
    return { ...res, kind };
  }
  if (kind === "predicate") {
    if (typeof ctx.verifyFact !== "function") return { ok: false, reason: "verify-unavailable", kind };
    try {
      const r = await ctx.verifyFact({ condition: verify.condition });
      if (r?.ok === true) return { ok: true, kind, detail: r.detail };
      return { ok: false, reason: r?.reason ?? "predicate-false", detail: r?.detail, kind };
    } catch (e) {
      return { ok: false, reason: "verify-error", detail: e?.message, kind };
    }
  }
  if (kind === "probe") {
    if (typeof ctx.probeRead !== "function") return { ok: false, reason: "verify-unavailable", kind };
    try {
      const r = await ctx.probeRead(verify.probe);
      if (r?.ok === true) return { ok: true, kind, detail: r.detail };
      return { ok: false, reason: r?.reason ?? "probe-false", detail: r?.detail, kind };
    } catch (e) {
      return { ok: false, reason: "verify-error", detail: e?.message, kind };
    }
  }
  // condition-gone
  if (typeof ctx.conditionGone !== "function") return { ok: false, reason: "verify-unavailable", kind: "condition-gone" };
  try {
    const gone = await ctx.conditionGone(verify.condition);
    if (gone === true) return { ok: true, kind: "condition-gone" };
    if (gone === false) return { ok: false, reason: "condition-still-present", kind: "condition-gone" };
    return { ok: false, reason: "condition-unverified", kind: "condition-gone" };
  } catch (e) {
    return { ok: false, reason: "verify-error", detail: e?.message, kind: "condition-gone" };
  }
}

// ---------------------------------------------------------------------------
// The single-plan runner (the §9.4 run → verify → retry loop)
// ---------------------------------------------------------------------------

/**
 * Execute ONE plan to an outcome. Seams (all injected):
 *   createSession({directory, title, permission}) → {ok, id?}
 *   sendPrompt({sessionId, text}) → {ok}
 *   listMessages(sessionId) → rows
 *   abortSession(sessionId) / deleteSession(sessionId)
 *   startJob({prompt, parentSessionID, parentDirectory, tools, trustMode})
 *     → {ok, job?}  (the shared approval path; ruleset always applied)
 *   jobRow(jobId) → {running, sessionId, status} | null (job poll seam)
 *   resolveParent({finding}) → {parentSessionID, parentDirectory} | null
 *   verifyFact / probeRead / conditionGone — the §9.2 check seams
 *   sleep(ms), now(), pollMs, turnBudgetMs
 */
export function createCtoPlanRunner(deps = {}) {
  const {
    createSession = null,
    sendPrompt = null,
    listMessages = null,
    abortSession = null,
    deleteSession = null,
    startJob = null,
    jobRow = null,
    resolveParent = null,
    verifyFact = null,
    probeRead = null,
    conditionGone = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    pollMs = TURN_POLL_MS,
    turnBudgetMs = TURN_BUDGET_MS,
  } = deps;

  // One await-turn: send the prompt, poll the transcript until a NEW
  // assistant message with text appears or the budget runs out. Mirrors
  // runSynchronousSession's established idle detection (text present = done).
  async function awaitTurn(sessionId, baseline, deadline, { prompt = null } = {}) {
    if (prompt !== null) {
      const sent = await sendPrompt({ sessionId, text: prompt });
      if (sent?.ok !== true) return { ok: false, reason: "send-failed", lastText: "", assistants: baseline };
    }
    let text = "";
    while (now() < deadline) {
      await sleep(pollMs);
      try {
        const msgs = await listMessages(sessionId);
        text = lastAssistantText(msgs);
        if (countAssistants(msgs) > baseline && text.trim()) {
          return { ok: true, lastText: text, assistants: countAssistants(msgs) };
        }
      } catch {
        /* transient transcript read failure — keep polling to the budget */
      }
    }
    return { ok: false, reason: "turn-budget", lastText: text, assistants: baseline };
  }

  /**
   * Run the plan. Returns
   *   {ok:true, outcome:"resolved", attempts, cost, result}
   *   {ok:true, outcome:"escalated", attempts, cost, reason, result}
   *   {ok:false, reason}          — refused, no execution happened
   */
  return async function execute({ plan: rawPlan, finding = null, project = null } = {}) {
    const v = validatePlan(rawPlan);
    if (!v.ok) return { ok: false, reason: v.reason };
    const plan = v.plan;
    const delegate = wantsDelegateSession(plan.access);
    const ruleset = permissionRulesetFor(plan.access);
    const brief = buildExecutionBrief(plan, { finding, project });
    const costChunks = [brief];

    // ---- session start -------------------------------------------------
    let sessionId = null;
    let kind = "ephemeral";
    // The session host: a delegate job needs a tracked project session to
    // parent it (the finding's sender session first, else the most active
    // project); an ephemeral session just borrows its directory (opencode's
    // default when none resolves).
    let parent = null;
    if (typeof resolveParent === "function") {
      try {
        parent = await resolveParent({ finding });
      } catch {
        parent = null;
      }
    }
    try {
      if (delegate) {
        kind = "delegate";
        if (typeof startJob !== "function") return { ok: false, reason: "no-start-job" };
        if (!parent?.parentSessionID) return { ok: false, reason: "no-project-session" };
        const res = await startJob({
          prompt: brief,
          parentSessionID: parent.parentSessionID,
          parentDirectory: parent.parentDirectory ?? undefined,
          // The plan's access rules ARE the declared tools; trustMode false —
          // the card is the human's veto over machine-originated work.
          tools: plan.access,
          trustMode: false,
        });
        if (res?.ok !== true) return { ok: false, reason: res?.error ?? "start-refused" };
        // The delegate JOB id (poll key); its opencode session id lives on the
        // row (childSessionID) and is resolved per transcript read.
        sessionId = res?.job?.id ?? null;
      } else {
        if (typeof createSession !== "function") return { ok: false, reason: "no-create-session" };
        const res = await createSession({
          title: plan.id,
          permission: ruleset,
          directory: parent?.parentDirectory ?? undefined,
        });
        if (res?.ok !== true || !res.id) return { ok: false, reason: res?.reason ?? "session-create-failed" };
        sessionId = res.id;
      }
    } catch (e) {
      return { ok: false, reason: "start-error", detail: e?.message };
    }

    const isDelegate = kind === "delegate";

    // Poll the delegate job until it finishes (own await loop over the job
    // rows), then read its transcript. Ephemeral sessions use the turn poll.
    // A null row is tolerated briefly (visibility lag between the start
    // returning and the persisted row being readable); sustained absence is
    // the job-gone escalation.
    async function readTranscript(sid, { baseline, deadline } = {}) {
      if (isDelegate) {
        let nulls = 0;
        while (now() < deadline) {
          await sleep(pollMs);
          let row = null;
          try {
            row = await jobRow(sid);
          } catch {
            row = null;
          }
          if (!row) {
            nulls += 1;
            if (nulls >= 10) return { ok: false, reason: "job-gone", lastText: "", assistants: baseline ?? 0 };
            continue;
          }
          if (row.running === false) {
            const msgs = row.sessionId ? await listMessages(row.sessionId) : [];
            return { ok: true, lastText: lastAssistantText(msgs), assistants: countAssistants(msgs) };
          }
        }
        return { ok: false, reason: "turn-budget", lastText: "", assistants: baseline ?? 0 };
      }
      return awaitTurn(sid, baseline ?? 0, deadline, { prompt: null });
    }

    // ---- turn 1: the brief ----------------------------------------------
    const t1Deadline = now() + turnBudgetMs;
    let turn = { ok: false, reason: "no-send", lastText: "", assistants: 0 };
    try {
      if (isDelegate) {
        turn = await readTranscript(sessionId, { baseline: 0, deadline: t1Deadline });
      } else {
        const sent = await sendPrompt({ sessionId, text: brief });
        if (sent?.ok !== true) {
          turn = { ok: false, reason: "send-failed", lastText: "", assistants: 0 };
        } else {
          turn = await awaitTurn(sessionId, 0, t1Deadline);
        }
      }
    } catch (e) {
      turn = { ok: false, reason: "turn-error", detail: e?.message, lastText: "", assistants: 0 };
    }
    costChunks.push(turn.lastText ?? "");
    let attempts = 1;

    const finish = async (outcome, reason) => {
      if (!isDelegate && sessionId) {
        try {
          await abortSession?.(sessionId);
          await deleteSession?.(sessionId);
        } catch {
          /* cleanup is best-effort */
        }
      }
      const result = {
        kind,
        sessionId,
        lastText: String(turn.lastText ?? "").slice(0, 2000),
      };
      return { ok: true, outcome, attempts, cost: estimateCostTokens(costChunks), reason, result };
    };

    // ---- verify + one retry ----------------------------------------------
    const check1 = await runVerifyCheck(plan, {
      lastText: turn.lastText,
      verifyFact,
      probeRead,
      conditionGone,
    });
    if (check1.ok === true) return finish("resolved", null);

    // Retry: the SAME session gets one more turn with the failed check
    // attached and a fresh budget. For a delegate job that means delivering
    // the retry brief into the job's child session (the job itself has
    // finished; the session still holds the worktree context). A session
    // that died entirely — job-gone — cannot take another turn; that is the
    // escalation.
    if (turn.ok === false && turn.reason === "job-gone") {
      return finish("escalated", `attempt1:${check1.reason ?? "verify-failed"}; job-gone`);
    }
    const retryDeadline = now() + turnBudgetMs;
    let turn2 = { ok: false, reason: "no-send", lastText: "", assistants: 0 };
    try {
      if (isDelegate) {
        // If turn 1 ended on budget but the job is still executing, delivering
        // the retry brief into the child session now would interleave with the
        // in-flight turn. Wait for the job to finish first (bounded by the
        // retry deadline; still running at it → that IS the failed check).
        if (turn.reason === "turn-budget") {
          const stillRunning = await readTranscript(sessionId, { baseline: 0, deadline: retryDeadline });
          if (stillRunning.ok === false && stillRunning.reason === "turn-budget") {
            return finish("escalated", `attempt1:${check1.reason ?? "verify-failed"}; job-still-running-at-budget`);
          }
        }
        const row = await jobRow(sessionId);
        const childId = row?.sessionId;
        if (!childId) {
          turn2 = { ok: false, reason: "job-gone", lastText: "", assistants: 0 };
        } else {
          const msgs = await listMessages(childId);
          const baseline = countAssistants(msgs);
          const sent = await sendPrompt({ sessionId: childId, text: buildRetryBrief(plan, check1) });
          if (sent?.ok !== true) {
            turn2 = { ok: false, reason: "send-failed", lastText: "", assistants: 0 };
          } else {
            turn2 = await awaitTurn(childId, baseline, retryDeadline);
          }
        }
      } else {
        const sent = await sendPrompt({ sessionId, text: buildRetryBrief(plan, check1) });
        if (sent?.ok !== true) {
          turn2 = { ok: false, reason: "send-failed", lastText: "", assistants: 0 };
        } else {
          turn2 = await awaitTurn(sessionId, turn.assistants ?? 0, retryDeadline);
        }
      }
    } catch (e) {
      turn2 = { ok: false, reason: "turn-error", detail: e?.message, lastText: "", assistants: 0 };
    }
    costChunks.push(buildRetryBrief(plan, check1), turn2.lastText ?? "");
    attempts = 2;
    turn = turn2;

    const check2 = await runVerifyCheck(plan, {
      lastText: turn2.lastText,
      verifyFact,
      probeRead,
      conditionGone,
    });
    if (check2.ok === true) return finish("resolved", null);
    const log = `attempt1:${check1.reason ?? "verify-failed"}; attempt2:${check2.reason ?? "verify-failed"}`;
    return finish("escalated", log);
  };
}

// ---------------------------------------------------------------------------
// The driver — queue, concurrency, attempt cap, outcomes, escalation
// ---------------------------------------------------------------------------

/**
 * The executor driver. One per engine. Owns:
 *   - the FIFO queue (≤ QUEUE_MAX entries, blocker-before-finding),
 *   - ≤ MAX_IN_FLIGHT executions,
 *   - the per-plan attempt cap (two executions per plan id, ever) over the
 *     durable resolve store (survives re-triage — the cap never re-arms),
 *   - the §9.5 outcome bookkeeping (notePlanOutcome) + the `cto.resolve`
 *     ledger row,
 *   - the 7-day success resolution (resolved + no negative verdict in the
 *     window → success; a negative verdict → failure),
 *   - the escalation to a human blocker card carrying the attempt log.
 */
export function createCtoExecutorDriver(deps = {}) {
  const {
    runner = null, // createCtoPlanRunner(...).execute
    store = null, // resolveStore { load, save } / patch
    ledger = null,
    escalate = null, // (text) => void — the human blocker card
    calibration = null, // notePlanOutcome({planId, class, ok})
    recordAct = null, // ({cls, text, refs, action, score}) — digest announcement
    verdictsList = async () => [], // () => verdict entries
    knowsPlan = async () => false, // (planId) => plans.json hit
    presence = null, // async () => "present"|"away"|"gone" (§9.4 rule; engine wires getPresence().state)
    now = () => Date.now(),
    execute = null, // when runner is not provided directly
    queueMax = QUEUE_MAX,
    maxInFlight = MAX_IN_FLIGHT,
  } = deps;

  const runOne = runner ?? execute;
  const queue = []; // {planId, plan, finding, findingId, project, trigger, gateCtx, isBlocker, queuedAt}
  let inFlight = 0;
  let draining = false;

  const ledgerLog = async (entry) => {
    if (!ledger) return;
    try {
      await appendLedgerBestEffort(ledger, now(), entry);
    } catch {
      /* best-effort */
    }
  };

  // resolve.json is an append-per-execution entries array (verdicts-mirrored):
  // one row per plan execution {planId, class, findingId, confidence,
  // calibration, effective, tau, trigger, outcome: resolved|escalated,
  // attempts, cost, reason, undo, refs, ts} + resolution fold bookkeeping on
  // the resolved row (successFoldedAt / failureFoldedAt + foldReason) so the
  // §9.5 7-day window survives restarts. Per-plan STATE (the attempt cap, the
  // pending window) is derived by scanning rows — the cap therefore never
  // re-arms on a re-triage.
  const SOFT_ROW_CAP = 500;
  const loadRows = async () => {
    if (!store) return [];
    try {
      const payload = await store.load();
      return Array.isArray(payload?.entries) ? payload.entries : [];
    } catch {
      return [];
    }
  };
  const patchRows = async (fn) => {
    if (!store) return;
    try {
      await patchStore(store, (fresh) => {
        const rows = Array.isArray(fresh?.entries) ? fresh.entries : [];
        return { entries: fn(rows.slice()) ?? rows };
      });
    } catch {
      /* best-effort */
    }
  };
  const executionsOf = (rows, planId) => rows.filter((r) => r?.planId === planId).length;

  // The negative-verdict scan for a pending resolution: any correct/dismiss/
  // veto verdict on the plan subject AFTER resolution time.
  const NEGATIVE = new Set(["correct", "dismiss", "veto"]);
  async function hasNegativeVerdict(planId, sinceMs) {
    try {
      const rows = await verdictsList();
      return (Array.isArray(rows) ? rows : []).some(
        (r) =>
          r?.subject?.id === planId &&
          NEGATIVE.has(r?.verdict) &&
          (typeof r?.ts === "number" ? r.ts >= sinceMs : false),
      );
    } catch {
      return false;
    }
  }

  // §9.5 fold: mark the resolved row final + feed calibration. The mutation
  // keeps ONE row per execution; the fold fields are bookkeeping, not a new
  // entry.
  async function foldOutcome(row, ok, reason) {
    const stamp = now();
    await patchRows((rows) => {
      const i = rows.indexOf(row);
      if (i === -1) return rows;
      rows[i] = {
        ...row,
        ...(ok ? { successFoldedAt: stamp } : { failureFoldedAt: stamp }),
        foldReason: reason ?? null,
      };
      return rows;
    });
    try {
      await calibration?.({ planId: row.planId, class: row.class, ok });
    } catch {
      /* calibration is best-effort — the row above is the record */
    }
    await ledgerLog({ kind: "calibrate.outcome", class: row?.class ?? null, planId: row?.planId ?? null, ok: ok === true, reason: reason ?? null });
  }

  // One queued execution, run to completion. Never throws (a throw is an
  // interrupt: escalate with outcome escalated per §9.4 — the run is never
  // silently lost).
  async function runQueued(entry) {
    const { planId, plan, finding, findingId, trigger, gateCtx } = entry;
    let res;
    try {
      res = await runOne({ plan, finding, project: entry.project, trigger, gateCtx });
    } catch (e) {
      res = { ok: true, outcome: "escalated", attempts: 1, cost: 0, reason: `interrupt:${e?.message ?? "unknown"}`, result: null };
    }
    const outcome = res?.outcome ?? "escalated";
    const class_ = typeof plan?.class === "string" ? plan.class : "other";
    const row = {
      planId,
      class: class_,
      findingId: findingId ?? null,
      confidence: typeof plan?.confidence === "number" ? plan.confidence : null,
      calibration: typeof gateCtx?.calibration === "number" ? gateCtx.calibration : null,
      effective: typeof gateCtx?.effective === "number" ? gateCtx.effective : null,
      tau: typeof gateCtx?.tau === "number" ? gateCtx.tau : null,
      trigger: trigger ?? "act",
      outcome,
      attempts: res?.attempts ?? null,
      cost: res?.cost ?? null,
      reason: res?.reason ?? null,
      undo: typeof plan?.undo === "string" ? plan.undo : null,
      refs: Array.isArray(plan?.finding?.refs) ? plan.finding.refs : (Array.isArray(finding?.refs) ? finding.refs : []),
      ts: now(),
      ...(outcome === "resolved" ? { resolvedAt: now() } : {}),
    };
    // §9.4-9.5: every execution writes ONE cto.resolve ledger entry (the
    // store row itself is kind-less; the ledger copy carries the kind).
    await ledgerLog({ kind: "cto.resolve", ...row });
    await patchRows((rows) => {
      // An escalated row closes any still-open pending window (its failure
      // already folded); keep one row per execution, newest-capped.
      const closed = rows.map((r) =>
        r?.planId === planId && r?.outcome === "resolved" && !r?.successFoldedAt && !r?.failureFoldedAt
          ? { ...r, failureFoldedAt: r.ts, foldReason: "superseded-by-escalation" }
          : r,
      );
      closed.push(row);
      return closed.length > SOFT_ROW_CAP ? closed.slice(closed.length - SOFT_ROW_CAP) : closed;
    });
    if (outcome === "resolved") {
      // §9.5: success is DEFERRED — resolved + no negative verdict within the
      // 7-day window (the driver's tick folds it).
    } else {
      // escalated → immediate failure + the human blocker card with the log
      try {
        await calibration?.({ planId, class: class_, ok: false });
      } catch {
        /* best-effort */
      }
      await ledgerLog({ kind: "calibrate.outcome", class: class_, planId, ok: false, reason: res?.reason ?? "escalated" });
      const log = res?.result
        ? `steps: ${JSON.stringify(plan?.steps ?? []).slice(0, 400)}; result: ${String(res.result.lastText ?? "").slice(0, 400)}`
        : "";
      await escalate?.(
        `CTO executor escalated plan ${planId} (${class_}) after ${res?.attempts ?? "?"} attempt(s). Verification failed: ${res?.reason ?? "unknown"}. ${log}`,
      );
    }
  }

  // Drain: take queue entries while slots are free; blockers first.
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && inFlight < maxInFlight) {
        // blocker-before-finding, then FIFO
        let idx = queue.findIndex((e) => e.isBlocker);
        if (idx === -1) idx = 0;
        const entry = queue.splice(idx, 1)[0];
        inFlight += 1;
        runQueued(entry)
          .catch(() => {})
          .finally(() => {
            inFlight -= 1;
            drain().catch(() => {});
          });
      }
    } finally {
      draining = false;
    }
  }

  /**
   * The gate/accepted seam: validate → cap → presence (§9.4) → enqueue →
   * drain.
   *
   * §9.4 presence rule (§3.4 rule 3): blocker-sourced plans run regardless
   * of presence (that is the point of a blocker); finding-sourced machine
   * acts (trigger "act") refuse while the user is `present` — the gate then
   * degrades them to the ask card, which is the right §9.3 surface when the
   * human is right there. Decision (documented in the PR): the check is at
   * ENQUEUE — a refused plan re-runs through the gate's ask path instead of
   * being held in the queue for an indefinite away-window. User-accepted
   * plans (trigger "accepted") are user-initiated and bypass presence.
   */
  async function executePlan(plan, ctx = {}) {
    const { findingId = null, finding = null, project = null, trigger = "act", gateCtx = null } = ctx;
    const v = validatePlan(plan);
    if (!v.ok) return { ok: false, reason: v.reason };
    const planId = v.plan.id;
    const rows = await loadRows();
    if (executionsOf(rows, planId) >= EXECUTIONS_PER_PLAN) {
      // Cap-hit refusal degrades to ask, never acts.
      return { ok: false, reason: "cap-hit" };
    }
    if (queue.length >= queueMax) {
      return { ok: false, reason: "queue-full" };
    }
    const isBlocker =
      finding?.kind === "blocker" || finding?.sourceKind === "blocker" || finding?.noteKind === "blocker";
    if (trigger === "act" && !isBlocker && typeof presence === "function") {
      try {
        if ((await presence()) === "present") {
          return { ok: false, reason: "presence-gated" };
        }
      } catch {
        /* a presence read failure must not block machine work — run */
      }
    }
    queue.push({ planId, plan: v.plan, finding, findingId, project, trigger, gateCtx, isBlocker, queuedAt: now() });
    await drain();
    return { ok: true, queued: true, planId };
  }

  /**
   * The user accepted this plan on a decision card ("Do it") — same executor,
   * trigger "accepted", plus the §9.2 digest announcement.
   */
  async function executeAccepted(plan, ctx = {}) {
    const res = await executePlan(plan, { ...ctx, trigger: "accepted" });
    if (res?.ok) {
      const cls = typeof plan?.class === "string" ? plan.class : "other";
      try {
        await recordAct?.({
          cls,
          text: plan?.finding?.text ?? plan?.diagnosis ?? "",
          refs: Array.isArray(plan?.finding?.refs) ? plan.finding.refs : [],
          action: { type: "plan", payload: { planId: plan?.id } },
          score: typeof ctx?.gateCtx?.effective === "number" ? ctx.gateCtx.effective : null,
        });
      } catch {
        /* best-effort */
      }
    }
    return res;
  }

  /**
   * The engine's tick: fold due pending resolutions (§9.5) + drain. Returns
   * {resolved: N} for tests.
   */
  async function tick() {
    let resolved = 0;
    const rows = await loadRows();
    const t = now();
    for (const row of rows) {
      if (!row?.resolvedAt || row?.successFoldedAt || row?.failureFoldedAt) continue;
      if (t - row.resolvedAt >= RESOLUTION_WINDOW_MS) {
        const negative = await hasNegativeVerdict(row.planId, row.resolvedAt);
        await foldOutcome(row, !negative, negative ? "negative-verdict-in-window" : null);
        resolved += 1;
        continue;
      }
      // A negative verdict inside the window resolves immediately as failure.
      if (await hasNegativeVerdict(row.planId, row.resolvedAt)) {
        await foldOutcome(row, false, "negative-verdict-in-window");
        resolved += 1;
      }
    }
    await drain();
    return { resolved };
  }

  /** Test/introspection: the queue depth and the in-flight count. */
  function state() {
    return { queueDepth: queue.length, inFlight };
  }

  /** Did this plan id ever exist as a plan subject? (verdict-fold deferral) */
  async function planSubjectKnown(planId) {
    if (typeof knowsPlan === "function") {
      try {
        if ((await knowsPlan(planId)) === true) return true;
      } catch {
        /* fall through to the store */
      }
    }
    const rows = await loadRows();
    return rows.some((r) => r?.planId === planId);
  }

  return { executePlan, executeAccepted, tick, state, planSubjectKnown, _queue: queue };
}

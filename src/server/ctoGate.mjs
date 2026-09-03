// §9.3 the gate (BET-1518, spec v3 D22) — the stage that replaced the v2 verb
// ladder. One rule:
//
//   effective = confidence × calibration(class)        (§9.5)
//   effective ≥ τ  → act     (executor; reported, never asked)
//   effective < τ  → ask     (decision card; the plan is the first option
//                             "Do it", effective shown once as a number)
//   no plan        → silent-log row (the §14.3 audit counts it)
//
// τ is the single user setting (`ctoAutonomyThreshold`, default 0.7 — the
// BET-1521 Settings τ control). There is no per-class act-eligibility map and
// no special-casing: `config-change` and `tool-write` are ordinary classes
// here — a plan of any class with effective ≥ τ acts (the executor's own
// refusal is the only thing that can stop it, and a refusal degrades to ask,
// never a silent no-op). Nothing is a "permanently unreachable special case"
// in the gate; refusal lives with the executor (§9.4), not the verb.
//
// The pure half (evaluateGate) is shared by the plans.json pass (the triage
// stage's stored plans) and the suggest flow (a candidate's worthiness p is
// its stated confidence). The engine half (gatePass) consumes plans.json
// records — BET-1517 stores one record per finding with 0–3 plans — and
// either executes (the BET-1519 executor seam; unwired → degraded ask card)
// or emits the ask card, exactly once per record (the record's `gated` stamp
// is the dedupe; a re-triage overwrites it and re-gates).

import { appendLedgerBestEffort, patchStore } from "./ctoStores.mjs";

export const DEFAULT_TAU = 0.7;

export function clampTau(tau) {
  const n = Number(tau);
  if (!Number.isFinite(n)) return DEFAULT_TAU;
  return Math.min(1, Math.max(0, n));
}

// The pure gate over one finding's plans (≤ 3, §9.2). `calibration` maps
// class → calibration (§9.5); a class absent from the map is a fresh class
// (0.5). Highest effective plan wins; the rest ride along as the card's other
// options (the caller decides what to render — never more than one plan
// executes per finding). With no plans: { verb: "none" }.
export function evaluateGate({ plans, tau, calibration = {} } = {}) {
  const list = (Array.isArray(plans) ? plans : []).filter((p) => p && typeof p === "object");
  if (list.length === 0) return { verb: "none" };
  const t = clampTau(tau);
  let best = null;
  let bestEffective = -1;
  for (const plan of list) {
    const cls = typeof plan.class === "string" ? plan.class : "other";
    const cal = Number.isFinite(calibration[cls]) ? calibration[cls] : 0.5;
    const conf = Number.isFinite(plan.confidence) ? Math.min(1, Math.max(0, plan.confidence)) : 0;
    const effective = Math.min(1, conf * cal);
    if (effective > bestEffective) {
      bestEffective = effective;
      best = plan;
    }
  }
  return {
    verb: bestEffective >= t ? "act" : "ask",
    plan: best,
    effective: bestEffective,
    others: list.filter((p) => p !== best),
  };
}

export function createCtoGate(deps = {}) {
  const {
    plans = null, // plans.json store — one record per triaged finding
    ledger = null,
    cards = null, // ctoCards manager (upsertDecision); null → act-only, asks degrade to ledger holds
    now = () => Date.now(),
    // τ source: the engine's configGet reads `ctoAutonomyThreshold`
    // (BET-1521's Settings τ control). Read per pass, never cached.
    tau: tauDep = async () => DEFAULT_TAU,
    // §9.5 calibration source: async (classes: string[]) => {cls → calibration}
    // (a plain number response applies to every class — handy for tests).
    // Injected from the calibration engine's calibrationsFor (or a stub).
    calibrationOf = async () => 0.5,
    // The BET-1519 executor seam. async (plan) => {ok, ...}; null → every
    // act degrades to the ask card with reason "no-executor" — a plan the
    // gate deemed act-worthy must never silently vanish and never act twice.
    executePlan = null,
    // Act-and-report bookkeeping (§9.2 invariant 1 — the act appears in the
    // next digest). Injected from the calibration engine; null → ledger-only.
    recordAct = null,
  } = deps;

  async function ledgerLog(entry) {
    if (!ledger) return;
    await appendLedgerBestEffort(ledger, now(), entry);
  }

  // One record's ask card (§9.3: the plan is the first option "Do it",
  // effective shown once as a number; the OTHER plans ride along as the
  // card's remaining options — never more than one plan executes per
  // finding, and choosing an alternative is a judgment the same accept
  // path records). The card id is the winning plan id — stable, so a
  // re-gate upserts rather than duplicating. The cold-start pin is deleted;
  // the card carries the plain decision variant.
  async function emitAskCard(plan, effective, others = []) {
    if (!cards || typeof cards.upsertDecision !== "function") return null;
    try {
      const title =
        (typeof plan.report?.one_liner === "string" && plan.report.one_liner.trim()) ||
        (typeof plan.finding?.text === "string" && plan.finding.text.trim()) ||
        "CTO resolution plan";
      const altLabel = (p) => {
        const t = typeof p?.report?.one_liner === "string" ? p.report.one_liner.trim() : "";
        return (t.length > 0 && t.slice(0, 60)) || "Alternative plan";
      };
      return await cards.upsertDecision({
        ts: now(),
        id: plan.id,
        variant: "decision",
        title,
        why: typeof plan.diagnosis === "string" && plan.diagnosis ? plan.diagnosis : title,
        sourceKind: "gate",
        cls: typeof plan.class === "string" ? plan.class : "other",
        refs: Array.isArray(plan.finding?.refs) ? plan.finding.refs : [],
        evidence: Array.isArray(plan.finding?.refs) ? plan.finding.refs : [],
        score: effective,
        options: [
          {
            label: "Do it",
            action: { type: "plan", payload: { planId: plan.id } },
          },
          ...(Array.isArray(others) ? others : []).map((p) => ({
            label: altLabel(p),
            action: { type: "plan", payload: { planId: p?.id } },
          })),
        ],
      });
    } catch {
      return null;
    }
  }

  // Gate everything the triage stage has planned but not yet gated. Returns
  // {records, acted, asked, none} for diagnostics/tests. Never throws into
  // the card tick.
  async function gatePass() {
    if (!plans) return { records: 0, acted: 0, asked: 0, none: 0 };
    let payload = {};
    try {
      payload = (await plans.load()) || {};
    } catch {
      return { records: 0, acted: 0, asked: 0, none: 0 };
    }
    const records = payload?.records && typeof payload.records === "object" ? payload.records : {};
    const pending = Object.entries(records).filter(([, rec]) => rec && !rec.gated && Array.isArray(rec.plans));
    if (pending.length === 0) return { records: 0, acted: 0, asked: 0, none: 0 };

    const tau = clampTau(await Promise.resolve(tauDep()));
    let acted = 0;
    let asked = 0;
    let none = 0;

    for (const [findingId, rec] of pending) {
      const classList = [...new Set((rec.plans ?? []).map((p) => (typeof p?.class === "string" ? p.class : "other")))];
      let calibrationMap = {};
      try {
        const raw = await Promise.resolve(calibrationOf(classList));
        if (Number.isFinite(raw)) {
          calibrationMap = Object.fromEntries(classList.map((c) => [c, raw]));
        } else if (raw && typeof raw === "object") {
          calibrationMap = raw;
        }
      } catch {
        calibrationMap = {};
      }
      const decision = evaluateGate({ plans: rec.plans, tau, calibration: calibrationMap });

      if (decision.verb === "none") {
        none += 1;
        // The §14.3 silence-audit row — the gate reuses the suggest flow's
        // `suggest.silent` shape (id, score, reason) so `listHeld`'s single
        // filter counts gate holds too; a new kind would be invisible to
        // the digest's "I held back N — review" aside.
        await ledgerLog({ kind: "suggest.silent", id: findingId, score: null, reason: "no-plan", text: rec.finding?.text ?? "" });
        await markRecord(findingId, { verb: "none", ts: now() });
        continue;
      }

      const plan = decision.plan;
      const cls = typeof plan.class === "string" ? plan.class : "other";
      const score = decision.effective;

      if (decision.verb === "act") {
        let exec = { ok: false, reason: "no-executor" };
        if (typeof executePlan === "function") {
          try {
            exec = (await executePlan(plan, {
              findingId,
              finding: rec.finding ?? null,
              // §9.4-9.5 row context: the gate knows calibration/τ/effective —
              // the executor stamps them on the cto.resolve row.
              gateCtx: {
                effective: score,
                tau,
                calibration: calibrationMap[cls],
              },
            })) ?? { ok: false };
          } catch {
            exec = { ok: false };
          }
        }
        if (exec?.ok === true) {
          acted += 1;
          if (recordAct) {
            try {
              await recordAct({ cls, text: plan.finding?.text ?? "", refs: plan.finding?.refs ?? [], score });
            } catch {
              /* best-effort */
            }
          }
          await ledgerLog({ kind: "gate.acted", findingId, planId: plan.id, class: cls, score, actionType: "plan" });
          await markRecord(findingId, { verb: "act", planId: plan.id, effective: score, ts: now() });
          continue;
        }
        // Executor unwired/refused → the act degrades to the ask card
        // (the human-in-the-loop fallback), never a silent no-op and
        // never a veto-window (the veto-window verb is deleted with the
        // ladder).
      }

      const up = await emitAskCard(plan, score, decision.others);
      const wrote = !!up && up.ok !== false;
      if (wrote) {
        asked += 1;
        if (up.changed !== false) {
          await ledgerLog({ kind: "gate.asked", findingId, planId: plan.id, cardId: plan.id, class: cls, score });
        }
        await markRecord(findingId, { verb: "ask", planId: plan.id, effective: score, ts: now() });
      } else {
        // No card machinery → hold (the §14.3 audit row, the same
        // `suggest.silent` shape as the none-branch so `listHeld` counts
        // it), same contract as the suggest flow's no-card-path.
        await ledgerLog({ kind: "suggest.silent", id: plan.id, class: cls, score, reason: "no-card-path", text: rec.finding?.text ?? "" });
        await markRecord(findingId, { verb: "none", planId: plan.id, reason: "no-card-path", ts: now() });
        none += 1;
      }
    }
    return { records: pending.length, acted, asked, none };
  }

  // Mark the record consumed so the same plans never re-gate on the next
  // tick. Best-effort RMW through patchStore; a re-triage replaces the whole
  // record value (new plans), which drops the stamp — exactly the desired
  // behavior: new plans re-gate, unchanged plans do not.
  async function markRecord(findingId, gated) {
    try {
      await patchStore(plans, (fresh) => {
        const recs = fresh?.records && typeof fresh.records === "object" ? fresh.records : {};
        const rec = recs[findingId];
        if (!rec) return {};
        return { records: { ...recs, [findingId]: { ...rec, gated: { ...gated } } } };
      });
    } catch {
      /* best-effort — worst case the record re-gates next pass */
    }
  }

  return { gatePass, evaluateGate };
}

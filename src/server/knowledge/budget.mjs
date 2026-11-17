// budget.mjs — the knowledge subsystem's spend ledger and its door to the shared background budget (spec
// 2026-11-17-background-work-budget §5, §8, §17).
//
// Whether knowledge work MAY run is decided by `backgroundBudget` (src/server/backgroundBudget.mjs): one budget for
// shared knowledge and the background CTO — a share of the plan's quota windows on a subscription, a dollar cap per
// day on a pay-per-token key. This module only asks it (`canSpend` → `check`, `goodMomentForBatch`, `dueAt`); there is
// no cap logic here any more.
//
// What stays here is the knowledge-only bookkeeping: every model call's dollars per LOCAL day in `state.sqlite`
// (`budget_ledger`, the per-class report), the 24 curator batches per project per day, and pruning. Pricing is the
// shared module's (an unpriced model is charged at the dearest priced model of its band, so the ledger always has a
// number). REAL usage reaches the shared budget through the runner (`createKnowledgeRunner`) and the trial, not from
// here: `record` writes the ledger row only, so a call is never counted twice.
//
// Pricing inputs are injected: `getPrices()` → `{models: {"<p>/<m>": {input, output, cacheWrite?, cacheRead?}}}`
// ($ per million tokens), `bandOf(providerID, modelID)` → "fast"|"balanced"|"deep"|null.

import { WORK_BANDS, normalizeTokens, priceTokens, resolveRates } from "../backgroundBudget.mjs";

export const MAX_BATCHES_PER_PROJECT_PER_DAY = 24;

export function localDay(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const isModel = (m) => m && typeof m === "object" && typeof m.providerID === "string" && m.providerID && typeof m.modelID === "string" && m.modelID;

/**
 * Plain words for a refusal, for the change log (§10, §17.21). `reason` is the shared budget's reason code
 * (`Decision.reason`, or the `reason` of a runner `code:"budget"` result).
 */
export function pauseNotice(reason) {
  switch (reason) {
    case "usd-cap":
      return { summary: "Daily spend cap reached", reason: "Curation resumes tomorrow. Briefings and the search tools keep working." };
    case "level-cap":
      return { summary: "Background limit reached", reason: "Curation resumes when your plan's usage window resets. Briefings and the search tools keep working." };
    case "window-busy":
      return { summary: "Paused while your plan is busy", reason: "Curation resumes when your plan's window eases off or resets. Briefings and the search tools keep working." };
    case "projected-high":
      return { summary: "Paused to leave your plan's quota alone", reason: "This week is on track to use most of your plan, so background curation waits. Briefings and the search tools keep working." };
    case "exhausted":
      return { summary: "Your plan's quota is used up", reason: "Curation resumes when it resets. Briefings and the search tools keep working." };
    case "off":
      return { summary: "Background work is off", reason: "Turn it on in Settings → Background work to resume curation. Briefings and the search tools keep working." };
    default:
      return { summary: "Waiting for the background budget", reason: "The budget couldn't be read just now; curation retries on its own. Briefings and the search tools keep working." };
  }
}

/**
 * deps:
 *   state             openState() handle (`budget_ledger`, `batch_ledger`)
 *   backgroundBudget  the shared module ({check, goodMomentForBatch, dueAt}); absent → every gate refuses `unavailable`
 *   resolveModel      (taskClass) → {providerID, modelID} | null | verdict — the model a class will run on, for the gates
 *   getPrices, bandOf pricing (see the header)
 *   now
 */
export function createBudget({ state, backgroundBudget = null, resolveModel = null, getPrices = async () => ({ models: {} }), bandOf = () => null, now = Date.now } = {}) {
  const db = state.db;

  const spentOn = (day) => db.prepare("SELECT COALESCE(SUM(usd), 0) AS s FROM budget_ledger WHERE day = ?").get(day).s;

  /** The model a work type's gate is asked about: the caller's, else the class's resolved one, else none (the shared module uses the box default). */
  async function modelFor({ model, modelClass }) {
    if (isModel(model)) return model;
    if (!resolveModel || !modelClass) return undefined;
    try {
      const m = await resolveModel(modelClass);
      return isModel(m) ? m : undefined;
    } catch {
      return undefined; // a class with no model: the runner reports its own verdict; the gate falls back to the default
    }
  }

  const unavailable = { ok: false, mode: "payg", fallback: true, reason: "unavailable", resumesAt: null };

  return {
    /** Knowledge's own ledger sum for today (the per-class report; NOT the cap). */
    spentToday: () => spentOn(localDay(now())),
    /**
     * May this work start now? The shared budget's Decision (`{ok, mode, reason, resumesAt, …}`); never throws.
     * `workType` is the shared work type; `modelClass` the task class whose model it will run on (default: the work type).
     */
    async canSpend({ workType, modelClass, model } = {}) {
      if (!backgroundBudget || !workType) return { ...unavailable };
      try {
        return await backgroundBudget.check({ workType, model: await modelFor({ model, modelClass: modelClass ?? workType }) });
      } catch {
        return { ...unavailable };
      }
    },
    /**
     * May a DUE batch job start now (§8, §17.17)? `{ok, rule, reason}`; call it ONCE per start decision (it logs the start).
     * `dueSince` is when the job became due.
     */
    async goodMomentForBatch({ workType, modelClass, model, dueSince } = {}) {
      if (!backgroundBudget || !workType) return { ok: false, rule: null, reason: "unavailable" };
      try {
        return await backgroundBudget.goodMomentForBatch({ workType, model: await modelFor({ model, modelClass: modelClass ?? workType }), dueSince });
      } catch {
        return { ok: false, rule: null, reason: "unavailable" };
      }
    },
    /** When a weekly batch job becomes due (§17.17): its own interval, on a plan moved to 24 h before the weekly reset. */
    async dueAt({ workType, modelClass, model, intervalDueAt } = {}) {
      if (!backgroundBudget?.dueAt) return intervalDueAt;
      try {
        return await backgroundBudget.dueAt({ model: await modelFor({ model, modelClass: modelClass ?? workType }), intervalDueAt });
      } catch {
        return intervalDueAt;
      }
    },
    /**
     * Write one ledger row. `tokens` {input, output, cacheRead, cacheWrite, reasoning} are priced; `usd` (a trial
     * session's recorded cost) is stored as-is. `taskClass` is the shared work type (a tidy-up call is
     * "knowledge-tidy", not the task class it ran as). Returns `{usd, priced}`.
     */
    async record({ taskClass, model, tokens: rawTokens, usd, slug = null, band } = {}) {
      const tokens = normalizeTokens(rawTokens); // real usage {input, output, reasoning, cacheRead, cacheWrite} is priced per component
      const b = band ?? WORK_BANDS[taskClass] ?? null;
      let cost;
      let priced = true;
      if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) cost = usd;
      else {
        const prices = await Promise.resolve(getPrices()).catch(() => ({ models: {} }));
        const r = resolveRates({ providerID: model?.providerID, modelID: model?.modelID, band: b, prices, bandOf });
        cost = priceTokens(tokens, r.rates);
        priced = r.priced;
      }
      const t = now();
      db.prepare("INSERT INTO budget_ledger (day, at, task_class, model, band, tokens, usd, priced, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        localDay(t),
        t,
        taskClass ?? "unknown",
        model ? `${model.providerID}/${model.modelID}` : null,
        b,
        tokens ? JSON.stringify(tokens) : null,
        cost,
        priced ? 1 : 0,
        slug,
      );
      return { usd: cost, priced };
    },
    /**
     * Book REAL usage on the shared budget — for work that runs in its own session instead of through the runner
     * (the skill trial; runner calls are booked by `createKnowledgeRunner`). Never throws.
     */
    async book({ workType, model, usage, usd, inLedger = false } = {}) {
      if (!backgroundBudget?.record) return null;
      try {
        return await backgroundBudget.record({ workType, model, usage, ...(typeof usd === "number" ? { usd } : {}), inLedger });
      } catch {
        return null;
      }
    },
    /** May this project run another curator batch today? */
    canBatch(slug) {
      const r = db.prepare("SELECT n FROM batch_ledger WHERE day = ? AND slug = ?").get(localDay(now()), slug);
      return (r?.n ?? 0) < MAX_BATCHES_PER_PROJECT_PER_DAY;
    },
    recordBatch(slug) {
      db.prepare("INSERT INTO batch_ledger (day, slug, n) VALUES (?, ?, 1) ON CONFLICT(day, slug) DO UPDATE SET n = n + 1").run(localDay(now()), slug);
    },
    /** Per-class spend for a day (the Knowledge card / the weekly report). */
    byClass(day = localDay(now())) {
      return db.prepare("SELECT task_class AS taskClass, COUNT(*) AS calls, SUM(usd) AS usd FROM budget_ledger WHERE day = ? GROUP BY task_class").all(day);
    },
    prune(keepDays = 60) {
      db.prepare("DELETE FROM budget_ledger WHERE at < ?").run(now() - keepDays * 24 * 3600 * 1000);
      db.prepare("DELETE FROM batch_ledger WHERE day < ?").run(localDay(now() - keepDays * 24 * 3600 * 1000));
    },
  };
}

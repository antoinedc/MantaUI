// budget.mjs — the knowledge subsystem's own spend ledger (spec §6.7).
//
// Every knowledge model call reports its tokens (the runner's `reportCost` hook);
// this module prices them with the box's model price table
// (`optimizer/prices.mjs`, `model-prices.json`) and records dollars per LOCAL day
// in `state.sqlite`. An unpriced model is charged at the highest price of any
// priced model in its band, so the cap always applies. Trial sessions are priced
// from their recorded usage (`record({usd})`). It does not touch the CTO's ambient
// budget. When the day's spend reaches `dailyCapUsd`, everything except the
// briefing and the tools waits for the next day. At most 24 curator batches per
// project per day.
//
// Pricing inputs are injected: `getPrices()` → `{models: {"<p>/<m>": {input, output,
// cacheWrite?, cacheRead?}}}` ($ per million tokens; `createOptimizerPrices().get`),
// `bandOf(providerID, modelID)` → "fast"|"balanced"|"deep"|null.

export const MAX_BATCHES_PER_PROJECT_PER_DAY = 24;
// Tier → router band (spec §6.2 table); the band prices an unpriced model.
export const CLASS_BANDS = Object.freeze({
  "knowledge-capture": "fast",
  "knowledge-corrections": "fast",
  "knowledge-trial": "balanced",
  "curator-notes": "balanced",
  "curator-rules": "deep",
  "curator-skills": "deep",
});
// Last resort when the box has no priced model at all ($ per million tokens).
export const FALLBACK_RATES = Object.freeze({ input: 15, output: 75 });
const CACHE_READ_FACTOR = 0.1;

export function localDay(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** PURE. $ for `tokens` at `rates` ($ per million tokens). */
export function priceTokens(tokens, rates) {
  const input = num(rates.input);
  const output = num(rates.output);
  const cacheWrite = rates.cacheWrite !== undefined ? num(rates.cacheWrite) : input;
  const cacheRead = rates.cacheRead !== undefined ? num(rates.cacheRead) : input * CACHE_READ_FACTOR;
  const t = tokens ?? {};
  return (num(t.input) * input + num(t.output) * output + num(t.cacheRead) * cacheRead + num(t.cacheWrite) * cacheWrite + num(t.reasoning) * output) / 1e6;
}

/** PURE. The rates to charge: the model's own, else the dearest priced model of its band, else the dearest overall, else FALLBACK_RATES. */
export function resolveRates({ providerID, modelID, band, prices, bandOf }) {
  const models = prices?.models ?? {};
  const own = models[`${providerID}/${modelID}`];
  if (own && num(own.input) > 0 && num(own.output) > 0) return { rates: own, priced: true };
  const dearest = (keys) => {
    let best = null;
    for (const k of keys) {
      const r = models[k];
      if (!r || !(num(r.input) > 0)) continue;
      if (!best || num(r.input) + num(r.output) > num(best.input) + num(best.output)) best = r;
    }
    return best;
  };
  const keys = Object.keys(models);
  const inBand =
    band && bandOf
      ? keys.filter((k) => {
          const i = k.indexOf("/");
          return bandOf(k.slice(0, i), k.slice(i + 1)) === band;
        })
      : [];
  const r = dearest(inBand) ?? dearest(keys);
  return { rates: r ?? FALLBACK_RATES, priced: false };
}

/**
 * deps: state, settings (get → dailyCapUsd), getPrices, bandOf, now.
 */
export function createBudget({ state, settings, getPrices = async () => ({ models: {} }), bandOf = () => null, now = Date.now } = {}) {
  const db = state.db;

  const spentOn = (day) => db.prepare("SELECT COALESCE(SUM(usd), 0) AS s FROM budget_ledger WHERE day = ?").get(day).s;

  async function capUsd() {
    return (await settings.get()).dailyCapUsd;
  }

  return {
    spentToday: () => spentOn(localDay(now())),
    capUsd,
    /** `{ok, spentUsd, capUsd}` — ok is false once today's spend has reached the cap. */
    async canSpend() {
      const cap = await capUsd();
      const spent = spentOn(localDay(now()));
      return { ok: spent < cap, spentUsd: spent, capUsd: cap };
    },
    /**
     * Record one call. `tokens` {input, output, cacheRead, cacheWrite, reasoning} are priced; `usd` (a
     * trial session's recorded cost) is stored as-is. Returns `{usd, priced}`.
     */
    async record({ taskClass, model, tokens, usd, slug = null, band } = {}) {
      const b = band ?? CLASS_BANDS[taskClass] ?? null;
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

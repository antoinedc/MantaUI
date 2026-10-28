// modelsPricing.mjs — per-model price declaration, computed on the box
// (WS09 SF-M13). `parseCostDraft` / `groupUnpriced` moved verbatim from the
// desktop's ModelPriceForm; clients send the four strings AS TYPED to
// `models:set-price` and render the reply's `message` / `field` / `warning`.

// A non-negative decimal, nothing else ("1e3", "0x10", "-1", "1,5" are refused:
// a price typed in a hurry should be a price, not whatever Number() tolerates).
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

function parseField(raw, label, required) {
  const s = String(raw ?? "").trim();
  if (s === "") return required ? { error: `${label} is required.` } : {};
  if (!DECIMAL.test(s)) return { error: `${label} must be a number of dollars per million tokens (0 or more).` };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a number of dollars per million tokens (0 or more).` };
  return { value: n };
}

/** Validate the draft into the writer's `cost` body. input, output + cache read required. */
export function parseCostDraft(d) {
  const fields = [
    ["input", "Input price", true],
    ["output", "Output price", true],
    ["cacheRead", "Cache read price", true],
    ["cacheWrite", "Cache write price", false],
  ];
  const v = {};
  for (const [field, label, required] of fields) {
    const r = parseField(d?.[field], label, required);
    if (r.error) return { ok: false, field, message: r.error };
    v[field] = r.value;
  }
  const cost = { input: v.input, output: v.output, cache_read: v.cacheRead };
  if (v.cacheWrite !== undefined) cost.cache_write = v.cacheWrite;
  return { ok: true, cost };
}

/**
 * Group "<providerID>/<modelID>" keys by provider. The split is at the FIRST
 * slash (model ids may contain slashes, e.g. openrouter's
 * "deepseek/deepseek-v4-flash"). A key with no provider or no model part is
 * dropped — it can't be addressed by the writer.
 */
export function groupUnpriced(keys) {
  const byProvider = new Map();
  for (const key of keys ?? []) {
    if (typeof key !== "string") continue;
    const i = key.indexOf("/");
    if (i <= 0 || i === key.length - 1) continue;
    const providerID = key.slice(0, i);
    const list = byProvider.get(providerID) ?? [];
    list.push(key.slice(i + 1));
    byProvider.set(providerID, list);
  }
  return [...byProvider.entries()]
    .map(([providerID, models]) => ({ providerID, models: [...models].sort() }))
    .sort((a, b) => a.providerID.localeCompare(b.providerID));
}

/** `optimizer:prices` + `unpricedByProvider` (an older result without `unpriced` is untouched). */
export function withUnpricedGroups(prices) {
  return Array.isArray(prices?.unpriced) ? { ...prices, unpricedByProvider: groupUnpriced(prices.unpriced) } : prices;
}

export const SAVED_MESSAGE = "Saved — the optimizer will use these prices";
export const NOT_RELOADED_WARNING =
  "opencode didn't reload its config, so its own cost display picks the new prices up after it restarts.";

export function createModelsPricing({ setModelCostDetailed, invalidatePrices, getPrices }) {
  async function groupsNow() {
    try {
      const prices = await getPrices();
      return withUnpricedGroups(prices)?.unpricedByProvider ?? [];
    } catch (e) {
      console.warn("[models:set-price] could not re-read prices:", e);
      return [];
    }
  }

  async function setPrice({ providerID, modelID, draft } = {}) {
    const parsed = parseCostDraft(draft);
    if (!parsed.ok) return { ok: false, field: parsed.field, message: parsed.message };
    const r = await setModelCostDetailed({ providerID, modelID, cost: parsed.cost });
    if (r.ok || r.changed === true) {
      // The optimizer reads the config FILE, so a price that reached the disk is in
      // effect even when opencode refused the live reload.
      invalidatePrices?.();
      const unpricedByProvider = await groupsNow();
      return {
        ok: true,
        message: SAVED_MESSAGE,
        ...(r.ok ? {} : { warning: NOT_RELOADED_WARNING }),
        unpricedByProvider,
      };
    }
    return { ok: false, message: `Couldn't save — ${r.error ?? "unknown error"}. Nothing was changed; try again.` };
  }

  return { setPrice };
}

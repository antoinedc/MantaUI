// modelsTable.mjs — the Settings → Models table and the model picker, computed
// on the box (WS09 SF-M1 / SF-M2, master D23). The desktop ModelsCard / ModelPicker
// and the iOS Models screen render these results verbatim; none of them reads
// config and re-derives Main / Sub / Default / deprecated state any more.
//
// Pure functions take injected inputs; `createModelsTable` is the service layer
// (config read-modify-write serialized on ONE promise chain so two devices can
// not lose each other's optInModels / deactivated* / modelOverrides edits).

import { describeModel, isDeprecated } from "../shared/modelGuide.mjs";

export const NOT_APPLIED_SENTENCE =
  "Preference saved, but the subagent list on the box wasn't updated. Try again to apply it.";
export const SAVED_NOT_LIVE_SENTENCE =
  "Preference saved and written, but opencode didn't reload it — it takes effect when opencode restarts (Settings → Box → Restart opencode).";
export const UNKNOWN_MODEL_REPLY = Object.freeze({
  ok: false,
  code: "unknown-model",
  message: "That model is no longer on this box.",
});
const CONTEXT_ERROR = "Context size must be a whole number of tokens above 0.";

const FAST_SUFFIX = "-fast";
const isFastModelId = (id) => id.length > FAST_SUFFIX.length && id.endsWith(FAST_SUFFIX);
const baseModelId = (id) => (isFastModelId(id) ? id.slice(0, -FAST_SUFFIX.length) : id);
const fastModelId = (id) => (isFastModelId(id) ? id : `${id}${FAST_SUFFIX}`);

export function modelKey(providerID, id) {
  return `${providerID}/${id}`;
}

const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

/** "200k" / "1M" / "1.5M"; null when unknown (same math as the old renderer helper). */
export function contextLabel(context) {
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) return null;
  if (context >= 1_000_000) {
    const m = context / 1_000_000;
    return `${(Math.round(m * 10) / 10).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(context / 1000)}k`;
}

function savedDefaultKey(config) {
  const d = config?.defaultModel;
  return d && typeof d.providerID === "string" && typeof d.modelID === "string"
    ? modelKey(d.providerID, d.modelID)
    : null;
}

/**
 * One row per model, fully derived. `models` is the override-applied list
 * (`opencode:models`); `config` supplies deactivatedMainModels /
 * deactivatedSubagents / optInModels / defaultModel.
 */
export function buildTableRows({ models, config, guide = describeModel }) {
  const deactivatedMain = new Set(strList(config?.deactivatedMainModels));
  const deactivatedSub = new Set(strList(config?.deactivatedSubagents));
  const optIn = new Set(strList(config?.optInModels));
  const defaultKey = savedDefaultKey(config);
  return (models ?? []).map((m) => {
    const key = modelKey(m.providerID, m.id);
    const info = guide(m.providerID, m.id);
    const deprecated = isDeprecated(m);
    const deprecatedLocked = deprecated && !optIn.has(key);
    const isMain = deprecatedLocked ? false : !deactivatedMain.has(key);
    const isSub = deprecatedLocked ? false : !deactivatedSub.has(key);
    const description = m.description ?? info?.blurb ?? null;
    const canMakeDefault = isMain && !deprecatedLocked;
    const defaultHint = deprecatedLocked
      ? "Enable this deprecated model first"
      : isMain
        ? null
        : "Enable Main first";
    const searchText = [
      m.name,
      m.providerID,
      m.id,
      m.description,
      info?.blurb,
      ...(info?.goodFor ?? []),
    ]
      .filter((s) => typeof s === "string" && s !== "")
      .join(" ")
      .toLowerCase();
    return {
      key,
      providerID: m.providerID,
      modelID: m.id,
      name: m.name,
      contextLabel: contextLabel(m.limit?.context),
      tier: info?.tier ?? null,
      description,
      searchText,
      deprecated,
      deprecatedLocked,
      isMain,
      isSub,
      isDefault: defaultKey !== null && key === defaultKey,
      canMakeDefault,
      defaultHint,
      editable: {
        name: m.name,
        description: m.description ?? info?.blurb ?? "",
        context: typeof m.limit?.context === "number" ? m.limit.context : null,
      },
    };
  });
}

/** The full `models:table` result. */
export function buildTable({ models, config, guide = describeModel }) {
  const rows = buildTableRows({ models, config, guide });
  const defaultKey = savedDefaultKey(config);
  let defaultLine = null;
  if (defaultKey !== null) {
    const row = rows.find((r) => r.key === defaultKey);
    defaultLine = row
      ? { name: row.name, providerID: row.providerID }
      : { name: config.defaultModel.modelID, providerID: config.defaultModel.providerID };
  }
  return { supported: true, defaultKey, defaultLine, rows };
}

/**
 * Turn the edit form (strings as typed) into the model's override: ONLY fields
 * that differ from the provider's own values are kept; a blank field keeps the
 * provider default. `model` is the UN-overridden provider model. Returns
 * `{ override }` (possibly empty → the caller deletes the key) or
 * `{ error: { field, message } }`.
 */
export function overrideFor({ model, providerDefaults, fields, guide = describeModel }) {
  const info = guide(model?.providerID, model?.id);
  const defaults = providerDefaults ?? {
    name: model?.name ?? "",
    description: model?.description ?? info?.blurb ?? "",
    context: typeof model?.limit?.context === "number" ? model.limit.context : null,
  };
  const override = {};
  const name = String(fields?.name ?? "").trim();
  if (name !== "" && name !== defaults.name) override.name = name;
  const description = String(fields?.description ?? "").trim();
  if (description !== "" && description !== (defaults.description ?? "")) override.description = description;
  const context = String(fields?.context ?? "").trim();
  if (context !== "") {
    const n = /^\d+$/.test(context) ? Number(context) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) return { error: { field: "context", message: CONTEXT_ERROR } };
    if (n !== defaults.context) override.context = n;
  }
  return { override };
}

function groupByProvider(models) {
  const map = new Map();
  for (const m of models) {
    const arr = map.get(m.providerID) ?? [];
    arr.push(m);
    map.set(m.providerID, arr);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// Drop a `-fast` model where its base twin survives in the same group; drop
// emptied groups.
function foldFastSiblings(groups) {
  const out = [];
  for (const [provider, models] of groups) {
    const ids = new Set(models.map((m) => m.id));
    const kept = models.filter((m) => !(isFastModelId(m.id) && ids.has(baseModelId(m.id))));
    if (kept.length > 0) out.push({ provider, keys: kept.map((m) => modelKey(m.providerID, m.id)) });
  }
  return out;
}

/** The full `models:picker` result (box-wide; per-session selection stays in model-prefs). */
export function buildPicker({ models, config, recents }) {
  const deactivatedMain = new Set(strList(config?.deactivatedMainModels));
  const optIn = new Set(strList(config?.optInModels));
  const candidates = (models ?? []).filter(
    (m) => m.enabled !== false && !deactivatedMain.has(modelKey(m.providerID, m.id)),
  );
  const locked = [];
  const selectable = [];
  for (const m of candidates) {
    const key = modelKey(m.providerID, m.id);
    if (isDeprecated(m) && !optIn.has(key)) locked.push(key);
    else selectable.push(key);
  }
  const selectableSet = new Set(selectable);
  const delegate = candidates.filter((m) => !isDeprecated(m));
  const kept = [];
  for (const r of Array.isArray(recents) ? recents : []) {
    if (!r || typeof r.providerID !== "string" || typeof r.modelID !== "string") continue;
    const key = modelKey(r.providerID, r.modelID);
    if (!selectableSet.has(key) && !selectableSet.has(modelKey(r.providerID, fastModelId(r.modelID)))) continue;
    const entry = { providerID: r.providerID, modelID: r.modelID };
    if (typeof r.variant === "string") entry.variant = r.variant;
    if (typeof r.fast === "boolean") entry.fast = r.fast;
    entry.key = key;
    kept.push(entry);
  }
  return {
    supported: true,
    groups: foldFastSiblings(groupByProvider(candidates)),
    locked,
    selectable,
    delegateGroups: foldFastSiblings(groupByProvider(delegate)),
    recents: kept,
  };
}

/** "applied" | "not-applied" | "saved-not-live" from a `syncSubagentsDetailed` result. */
export function subOutcome(detail) {
  if (!detail || detail.read !== "ok") return "not-applied";
  if (detail.write === "ok" && detail.reload === "failed") return "saved-not-live";
  if ((detail.write === "noop" || detail.write === "ok") && (detail.reload === "ok" || detail.reload === "n/a")) {
    return "applied";
  }
  return "not-applied";
}

function outcomeSentence(outcome) {
  return outcome === "not-applied" ? NOT_APPLIED_SENTENCE : outcome === "saved-not-live" ? SAVED_NOT_LIVE_SENTENCE : null;
}

export function createModelsTable({
  listModels,
  configGet,
  configUpdate,
  syncSubagentsDetailed,
  getModelPrefs,
  publish,
}) {
  let chain = Promise.resolve();
  // One writer at a time: each write reads the config INSIDE the chain.
  const serialize = (fn) => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const hint = () => publish?.({ kind: "models.updated", payload: {} });

  const loadModels = async (config) => {
    const list = await listModels(config?.modelOverrides ?? {});
    return Array.isArray(list) ? list : [];
  };
  const tableFor = async (config) => buildTable({ models: await loadModels(config), config });

  async function table() {
    return tableFor(await configGet());
  }

  async function picker() {
    const config = await configGet();
    const models = await loadModels(config);
    let recents = [];
    try {
      recents = (await getModelPrefs())?.recents ?? [];
    } catch {
      recents = [];
    }
    return buildPicker({ models, config, recents });
  }

  async function reconcile(models, config) {
    return syncSubagentsDetailed({
      models,
      deactivated: strList(config?.deactivatedSubagents),
      optIn: strList(config?.optInModels),
    });
  }

  const find = (models, key) => models.find((m) => modelKey(m.providerID, m.id) === key);
  const fail = (code, message, field) => ({ ok: false, ...(field ? { field } : {}), code, message });

  function setDefault({ key } = {}) {
    return serialize(async () => {
      const config = await configGet();
      const models = await loadModels(config);
      if (key === null || key === undefined) {
        const next = await configUpdate({ defaultModel: null });
        hint();
        return { ok: true, table: await tableFor(next), message: "Default cleared." };
      }
      const row = buildTableRows({ models, config }).find((r) => r.key === key);
      if (!row) return { ...UNKNOWN_MODEL_REPLY };
      if (!row.canMakeDefault) {
        return row.deprecatedLocked
          ? fail("deprecated-locked", "Enable this deprecated model first.")
          : fail("not-main", "Turn on Main first.");
      }
      const next = await configUpdate({ defaultModel: { providerID: row.providerID, modelID: row.modelID } });
      hint();
      return { ok: true, table: await tableFor(next), message: `Default set to ${row.name}.` };
    });
  }

  function setMain({ key, on } = {}) {
    return serialize(async () => {
      const config = await configGet();
      const models = await loadModels(config);
      const row = buildTableRows({ models, config }).find((r) => r.key === key);
      if (!row) return { ...UNKNOWN_MODEL_REPLY };
      if (row.deprecatedLocked) return fail("deprecated-locked", "Enable this deprecated model first.");
      const hidden = new Set(strList(config?.deactivatedMainModels));
      if (on) hidden.delete(key);
      else hidden.add(key);
      const patch = { deactivatedMainModels: [...hidden] };
      // A default must be Main-available: hiding the default clears it in the SAME save.
      const clearsDefault = !on && row.isDefault;
      if (clearsDefault) patch.defaultModel = null;
      const next = await configUpdate(patch);
      hint();
      const base = on ? "Shown in the model picker." : "Hidden from the model picker.";
      return {
        ok: true,
        table: await tableFor(next),
        message: clearsDefault ? `${base} The default was cleared.` : base,
      };
    });
  }

  function setSub({ key, on } = {}) {
    return serialize(async () => {
      const config = await configGet();
      const models = await loadModels(config);
      const row = buildTableRows({ models, config }).find((r) => r.key === key);
      if (!row) return { ...UNKNOWN_MODEL_REPLY };
      if (row.deprecatedLocked) return fail("deprecated-locked", "Enable this deprecated model first.");
      const off = new Set(strList(config?.deactivatedSubagents));
      if (on) off.delete(key);
      else off.add(key);
      const next = await configUpdate({ deactivatedSubagents: [...off] });
      hint();
      const outcome = subOutcome(await reconcile(models, next));
      return {
        ok: true,
        table: await tableFor(next),
        outcome,
        retry: outcome === "not-applied",
        message: outcomeSentence(outcome) ?? "Subagent list updated.",
      };
    });
  }

  function retrySubSync() {
    return serialize(async () => {
      const config = await configGet();
      const models = await loadModels(config);
      const outcome = subOutcome(await reconcile(models, config));
      return {
        ok: true,
        table: await tableFor(config),
        outcome,
        retry: outcome === "not-applied",
        message: outcomeSentence(outcome) ?? "Subagent list updated.",
      };
    });
  }

  function optIn({ keys } = {}) {
    return serialize(async () => {
      const wanted = [...new Set(strList(keys))];
      const config = await configGet();
      const models = await loadModels(config);
      const known = wanted.filter((k) => find(models, k));
      const ignored = wanted.filter((k) => !find(models, k));
      if (known.length === 0) return { ...UNKNOWN_MODEL_REPLY };
      // The union is computed from the config read INSIDE the chain (no lost update).
      const union = [...new Set([...strList(config?.optInModels), ...known])];
      let next = config;
      if (union.length !== strList(config?.optInModels).length) next = await configUpdate({ optInModels: union });
      hint();
      const outcome = subOutcome(await reconcile(models, next));
      const names = known.map((k) => find(models, k).name);
      const base = names.length === 1 ? `Enabled ${names[0]}.` : `Enabled ${names.length} models.`;
      const sentence = outcomeSentence(outcome);
      return {
        ok: true,
        table: await tableFor(next),
        outcome,
        retry: outcome === "not-applied",
        ignored,
        message: sentence ? `${base} ${sentence}` : base,
      };
    });
  }

  function setOverride({ key, fields } = {}) {
    return serialize(async () => {
      const config = await configGet();
      const providerModels = await listModels({});
      const model = find(Array.isArray(providerModels) ? providerModels : [], key);
      if (!model) return { ...UNKNOWN_MODEL_REPLY };
      const r = overrideFor({ model, fields });
      if (r.error) return fail("invalid", r.error.message, r.error.field);
      const overrides = { ...(config?.modelOverrides ?? {}) };
      if (Object.keys(r.override).length === 0) delete overrides[key];
      else overrides[key] = r.override;
      const next = await configUpdate({ modelOverrides: overrides });
      hint();
      return { ok: true, table: await tableFor(next), message: "Saved." };
    });
  }

  return { table, picker, setDefault, setMain, setSub, retrySubSync, optIn, setOverride };
}

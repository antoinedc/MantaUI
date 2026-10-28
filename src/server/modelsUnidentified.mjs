// modelsUnidentified.mjs — "Models we couldn't identify" computed on the box
// (WS09 F4 + SF-M9 / SF-M10 / SF-M11). The identity resolver + Auto-eligibility
// gate + catalogue matcher are the SAME shared modules the router uses, so what
// the UI says is missing is exactly what the router is waiting for. Desktop and
// iOS render these rows verbatim (help line, actions, chips); neither runs the
// resolver or builds a declaration any more.

import { describeModel } from "../shared/modelGuide.mjs";
import { resolveIdentity } from "../shared/modelIdentity.mjs";
import { autoEligibility, describeMissing } from "../shared/autoEligibility.mjs";
import { contextLabel, modelKey, UNKNOWN_MODEL_REPLY } from "./modelsTable.mjs";

export const INTRO =
  "Served under a name the catalogue doesn't recognise, so Manta can't tell what they are or what they're good at. They stay usable by hand. Identify one and Auto can start choosing it.";
export const FOOTER =
  "Can't say? Leave it. The model stays available to pick by hand — Auto just won't choose something it can't describe.";
export const UNAVAILABLE_TEXT =
  "Manta couldn't load the model catalogue, so it can't tell what any of these endpoints are. Auto won't choose a model it can't describe. This usually clears on its own — reopen Settings in a minute.";

const CHIP_LIMIT = 4;

/** Rows for every endpoint Auto cannot yet describe (already-eligible endpoints are skipped). */
export function buildUnidentifiedRows({ models, declared, catalog }) {
  const rows = [];
  for (const m of models ?? []) {
    const key = modelKey(m.providerID, m.id);
    const decl = declared?.[key];
    const id = resolveIdentity(m, decl ?? null, catalog);
    // The ONE gate: list an endpoint only when Auto cannot yet describe it.
    const elig = autoEligibility({
      model: id.effective,
      identity: { known: id.state === "resolved" },
      quality: { known: id.state === "resolved" },
      declared: decl,
      providerClass: "supported",
    });
    if (elig.eligible) continue;
    const base = {
      key,
      label: `${m.providerID} / ${m.id}`,
      providerID: m.providerID,
      modelID: m.id,
      missing: elig.missing,
    };
    const missing = describeMissing(elig.missing);
    if (id.state === "resolved") {
      const entry = id.catalogId ? catalog.lookupModel(id.catalogId) : null;
      const tier = id.catalogId ? describeModel(m.providerID, id.catalogId)?.tier : undefined;
      const ctx = entry ? contextLabel(entry.limit?.context) : null;
      const bits = [entry?.name ?? id.catalogId];
      if (tier) bits.push(tier);
      if (ctx) bits.push(ctx);
      const probable = id.confidence === "probable";
      const help =
        (probable
          ? `We think this is ${entry?.name ?? id.catalogId}` + (id.evidence ? ` — ${id.evidence}` : "")
          : `Matched automatically → ${bits.join(" · ")}`) + (missing ? ` — Auto still needs: ${missing}` : "");
      const match = { id: id.catalogId, name: entry?.name ?? id.catalogId };
      if (tier) match.tier = tier;
      if (typeof entry?.limit?.context === "number") match.context = entry.limit.context;
      if (entry?.description) match.description = entry.description;
      rows.push({
        ...base,
        state: "exact",
        confidence: id.confidence,
        ...(id.evidence ? { evidence: id.evidence } : {}),
        catalogId: id.catalogId,
        match,
        candidates: [],
        help,
        actions: probable ? ["confirm", "change"] : ["change"],
      });
    } else if (id.state === "ambiguous") {
      const candidates = (id.candidates ?? [])
        .map((c) => catalog.lookupModel(c))
        .filter(Boolean)
        .map((e) => ({ id: e.id ?? "", name: e.name ?? e.id ?? "" }));
      rows.push({
        ...base,
        state: "ambiguous",
        ...(id.evidence ? { evidence: id.evidence } : {}),
        catalogId: null,
        candidates,
        help: `${candidates.length} models share this name — which one is it?${id.evidence ? ` — ${id.evidence}` : ""}`,
        actions: ["pick"],
        chips: candidates.length <= CHIP_LIMIT,
      });
    } else {
      rows.push({
        ...base,
        state: "none",
        catalogId: null,
        candidates: [],
        help: "No match — tell us which model this is",
        actions: ["identify"],
      });
    }
  }
  return rows;
}

/** The full `models:unidentified` result. */
export function unidentifiedList({ models, declared, catalog }) {
  const available = (catalog?.allModels?.() ?? []).length > 0;
  if (!available) {
    return { supported: false, intro: INTRO, footer: FOOTER, unavailableText: UNAVAILABLE_TEXT, rows: [] };
  }
  return { supported: true, intro: INTRO, footer: FOOTER, rows: buildUnidentifiedRows({ models, declared, catalog }) };
}

/**
 * The declaration the editor / Confirm / candidate pick writes. `form` absent →
 * `{ catalogId }` (identity only). Returns `{ decl }` or `{ error: { field, message } }`.
 */
export function buildDeclaration({ catalogId, form }) {
  const id = String(form ? form.catalogId ?? "" : catalogId ?? "").trim();
  if (id === "") return { error: { field: "catalogId", message: "Pick the model this is." } };
  if (!form) return { decl: { catalogId: id } };
  const decl = { catalogId: id };
  const input = parseFloat(form.costIn);
  const output = parseFloat(form.costOut);
  if (form.price === "free") {
    decl.price = "free";
  } else if (form.price === "custom" && (Number.isFinite(input) || Number.isFinite(output))) {
    // Free is a complete answer; Custom needs at least one finite rate (a blank one counts as 0).
    decl.price = { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 };
  } else {
    return { error: { field: "price", message: "Choose Free or enter a price." } };
  }
  decl.caches = form.caching === "custom" ? { read: form.reads !== false, write: form.writes !== false } : false;
  return { decl };
}

/** `modelRouting` with `decl` merged into `declaredModels[key]` (same-key fields overwrite, absent fields keep). */
export function mergeDeclared(routing, key, decl) {
  const base = routing && typeof routing === "object" ? routing : { preset: "balanced" };
  const declared = base.declaredModels ?? {};
  return { ...base, declaredModels: { ...declared, [key]: { ...(declared[key] ?? {}), ...decl } } };
}

export function createModelsUnidentified({ listModels, configGet, configUpdate, catalog, publish }) {
  let chain = Promise.resolve();
  const serialize = (fn) => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const listFor = async (config) => {
    const models = await listModels(config?.modelOverrides ?? {});
    return { models: Array.isArray(models) ? models : [] };
  };
  const compute = async (config) => {
    const { models } = await listFor(config);
    return {
      models,
      list: unidentifiedList({ models, declared: config?.modelRouting?.declaredModels ?? {}, catalog }),
    };
  };

  async function list() {
    return (await compute(await configGet())).list;
  }

  function declare(input = {}) {
    return serialize(async () => {
      const { key, catalogId, form } = input;
      const config = await configGet();
      const { models } = await listFor(config);
      if (!models.some((m) => modelKey(m.providerID, m.id) === key)) return { ...UNKNOWN_MODEL_REPLY };
      const built = buildDeclaration({ catalogId, form });
      if (built.error) return { ok: false, field: built.error.field, code: "invalid", message: built.error.message };
      const modelRouting = mergeDeclared(config?.modelRouting, key, built.decl);
      const next = await configUpdate({ modelRouting });
      publish?.({ kind: "models.updated", payload: {} });
      const { models: fresh, list: freshList } = await compute(next);
      const modelID = fresh.find((m) => modelKey(m.providerID, m.id) === key)?.id ?? key;
      if (!freshList.supported) {
        return {
          ok: true,
          outcome: "catalogue-unavailable",
          row: null,
          list: freshList,
          message:
            "Saved. Manta couldn't load the model catalogue, so it can't confirm what Auto still needs — reopen Settings in a minute.",
        };
      }
      const row = freshList.rows.find((r) => r.key === key) ?? null;
      if (!row) {
        return { ok: true, outcome: "resolved", row: null, list: freshList, message: `Saved — Auto can now describe ${modelID}` };
      }
      const missing = describeMissing(row.missing);
      return {
        ok: true,
        outcome: "still-needs",
        row,
        list: freshList,
        message: missing ? `Identity saved — Auto still needs: ${missing}.` : "Identity saved.",
      };
    });
  }

  return { list, declare };
}

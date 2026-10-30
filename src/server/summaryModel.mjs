// summaryModel.mjs — the box side of the "Summary model" setting (cold-cache
// handoff spec, Part A): which connected model writes handoffs after a long
// break, session titles and remembered instructions.
//
// The RANKING is pure and lives in src/shared/summaryModel.mjs. This module owns
// what changes over time:
//
//   • the stored choice — `summaryModel` / `summaryModelOptOut` in the box
//     config, written ONLY here (`config:update` strips both keys);
//   • the reconciler — ONE serialized queue; picks a model when none is set,
//     re-picks an automatic choice that stopped being valid, never moves a
//     user's choice, never changes anything when the model list can't be read;
//   • the status snapshot the Settings card reads (never a fresh network read);
//   • `resolveCheapWriter` — the one answer to "which model writes this small job".
//
// Every I/O is injected, so the tests run against fakes and never touch the box.

import { rankSummaryModels, searchSummaryCandidates, shortlist, publicCandidate, SUMMARY_SEARCH_MAX } from "../shared/summaryModel.mjs";
import { readModalities } from "../shared/modelGuide.mjs";
import { resolveListPrice } from "./optimizer/prices.mjs";
import { buildBenchmarkField } from "./routingServices.mjs";

const keyOf = (providerID, modelID) => `${providerID}/${modelID}`;
const isStr = (v) => typeof v === "string" && v !== "";
const MAX_CAS_ATTEMPTS = 3;

export const REASON_OPTED_OUT = "Off. Handoffs, titles and remembered instructions use each conversation's own model.";
export const REASON_UNKNOWN = "Couldn't read the connected models just now, so nothing was changed.";
export const REASON_NONE_CONNECTED = "No connected model can be used as a summary model.";
export const REASON_NOT_ELIGIBLE = "That model isn't available as a summary model.";

/** PURE. A stored pair, or null when it is absent / malformed. */
export function readStoredSummaryModel(cfg) {
  const m = cfg?.summaryModel;
  if (!m || typeof m !== "object" || !isStr(m.providerID) || !isStr(m.modelID)) return null;
  return { providerID: m.providerID, modelID: m.modelID, source: m.source === "user" ? "user" : "auto", pickedAt: typeof m.pickedAt === "number" ? m.pickedAt : 0 };
}

/**
 * PURE. A.4 step 3: what the reconciler does with the stored choice.
 *
 * @param {{ stored: ReturnType<typeof readStoredSummaryModel>, optOut: boolean,
 *           eligible: Set<string>, pick: {providerID:string,modelID:string}|null, pickReason?: string }} a
 * @returns {{ state: "ok"|"unset"|"opted-out"|"unavailable", reason?: string, current: {providerID:string,modelID:string,source:"auto"|"user"}|null,
 *             betterAvailable: boolean, write?: { value: object|null } }}
 *   `write` present = the stored value must change (a user choice is never in it).
 */
export function decideSummaryModel({ stored, optOut, eligible, pick, pickReason }) {
  if (optOut) return { state: "opted-out", reason: REASON_OPTED_OUT, current: null, betterAvailable: false };
  const valid = stored && eligible.has(keyOf(stored.providerID, stored.modelID));
  if (stored?.source === "user") {
    return valid
      ? { state: "ok", current: stored, betterAvailable: false }
      : {
          state: "unavailable",
          reason: "The summary model you chose isn't connected any more, or no longer qualifies. Choose another, or handoffs after a long break will re-read the whole conversation.",
          current: stored,
          betterAvailable: false,
        };
  }
  if (valid) {
    const better = !!pick && keyOf(pick.providerID, pick.modelID) !== keyOf(stored.providerID, stored.modelID);
    return { state: "ok", current: stored, betterAvailable: better };
  }
  if (pick) return { state: "ok", current: { providerID: pick.providerID, modelID: pick.modelID, source: "auto" }, betterAvailable: false, write: { value: { providerID: pick.providerID, modelID: pick.modelID, source: "auto" } } };
  return {
    state: "unset",
    reason: pickReason ?? REASON_NONE_CONNECTED,
    current: null,
    betterAvailable: false,
    ...(stored ? { write: { value: null } } : {}),
  };
}

const sameStored = (a, b) => (a === null || b === null ? a === b : a.providerID === b.providerID && a.modelID === b.modelID && a.source === b.source && a.pickedAt === b.pickedAt);

/**
 * @param {object} d
 * @param {() => Promise<any[]>} d.listModels  STRICT: rejects when the list can't be read
 * @param {() => Promise<any>} d.configGet
 * @param {(patch: object) => Promise<any>} d.configUpdate
 * @param {{ matchModel?: Function, allModels?: Function }} [d.catalog]  models.dev catalogue (exact matches only)
 * @param {() => any} [d.loadPriceCatalog]  the validated price cache, or null
 * @param {() => Promise<any>} [d.readOpencodeConfig]
 * @param {() => Promise<Set<string>>} [d.subscriptionIds]  connected SUBSCRIPTION_PROVIDERS ids
 * @param {(sessionId: string) => Promise<{providerID:string,modelID:string}|null>} [d.lastUsedModel]
 * @param {() => number} [d.now]
 * @param {(msg: string, err?: any) => void} [d.warn]
 */
export function createSummaryModel(d) {
  const now = d.now ?? Date.now;
  const warn = d.warn ?? ((m, e) => console.warn(m, e?.message ?? e ?? ""));

  /** The last computed view; null until the first reconcile settles. */
  let snap = null;
  let tail = Promise.resolve();
  let queuedReconcile = null;

  // One mutation at a time: reconcile and set share this chain.
  function exclusive(fn) {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  }

  async function buildRanking(models) {
    const catalog = d.catalog ?? {};
    let ocConfig = null;
    let priceCatalog = null;
    let subs = new Set();
    try { ocConfig = (await d.readOpencodeConfig?.()) ?? null; } catch { /* unpriced via config */ }
    try { priceCatalog = d.loadPriceCatalog?.() ?? null; } catch { /* unpriced via catalogue */ }
    try { subs = (await d.subscriptionIds?.()) ?? new Set(); } catch { /* no subscription preference */ }
    let field = null;
    try { field = buildBenchmarkField({ allModels: () => catalog.allModels?.() ?? [] }); } catch { /* family-only */ }
    const entries = models.map((model) => {
      let catalogEntry = null;
      try {
        const match = catalog.matchModel?.(model.id, {
          modalities: readModalities(model.capabilities?.input),
          context: model.limit?.context,
          output: model.limit?.output,
        });
        catalogEntry = match?.kind === "exact" ? match.candidates?.[0] ?? null : null;
      } catch { /* unidentified */ }
      let listPrice = null;
      try {
        listPrice = resolveListPrice({ providerID: model.providerID, modelID: model.id, config: ocConfig, catalog: priceCatalog, model, oneHour: false });
      } catch { /* unpriced */ }
      return { model, catalogEntry, listPrice };
    });
    return rankSummaryModels({ entries, field, subscriptionIds: subs });
  }

  function viewOf({ decision, ranked, modelsByKey, listFailed = false }) {
    const cur = decision.current;
    const byKey = new Map(ranked.candidates.map((c) => [keyOf(c.providerID, c.modelID), c]));
    const curKey = cur ? keyOf(cur.providerID, cur.modelID) : null;
    const inRank = curKey ? byKey.get(curKey) : null;
    const name = inRank?.name ?? (curKey ? modelsByKey.get(curKey)?.name : null) ?? cur?.modelID ?? "";
    return {
      state: decision.state,
      reason: decision.reason,
      current: cur ? { providerID: cur.providerID, modelID: cur.modelID, name, source: cur.source } : null,
      betterAvailable: decision.betterAvailable === true,
      ranked: ranked.candidates,
      byKey,
      active: decision.state === "ok" && inRank ? inRank.model : null,
      listFailed,
    };
  }

  async function reconcileOnce() {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      let models;
      try {
        models = await d.listModels();
        if (!Array.isArray(models)) throw new Error("model list unavailable");
      } catch (e) {
        warn("[summary-model] couldn't read the model list; leaving the choice unchanged:", e);
        const cfg = await d.configGet();
        const stored = readStoredSummaryModel(cfg);
        snap = {
          state: "unknown",
          reason: REASON_UNKNOWN,
          current: cfg?.summaryModelOptOut === true ? null : stored && { providerID: stored.providerID, modelID: stored.modelID, name: snap?.current?.name ?? stored.modelID, source: stored.source },
          betterAvailable: false,
          ranked: snap?.ranked ?? [],
          byKey: snap?.byKey ?? new Map(),
          active: null,
          listFailed: true,
        };
        return;
      }
      const cfg0 = await d.configGet();
      const before = { stored: readStoredSummaryModel(cfg0), optOut: cfg0?.summaryModelOptOut === true };
      const ranked = await buildRanking(models);
      const eligible = new Set(ranked.candidates.map((c) => keyOf(c.providerID, c.modelID)));
      const decision = decideSummaryModel({ ...before, eligible, pick: ranked.pick, pickReason: ranked.reason });
      const modelsByKey = new Map(models.map((m) => [keyOf(m.providerID, m.id), m]));

      if (decision.write) {
        // Compare-and-set: only write when the stored pair is still what we decided from.
        const cfg1 = await d.configGet();
        const now1 = { stored: readStoredSummaryModel(cfg1), optOut: cfg1?.summaryModelOptOut === true };
        if (!sameStored(now1.stored, before.stored) || now1.optOut !== before.optOut) continue; // lost the race → decide again
        const value = decision.write.value ? { ...decision.write.value, pickedAt: now() } : null;
        await d.configUpdate({ summaryModel: value });
      }
      snap = viewOf({ decision, ranked, modelsByKey });
      return;
    }
    warn("[summary-model] the stored choice kept changing under the reconciler; will re-check on the next trigger");
  }

  /** Reconcile now (serialized). A request while one is running schedules exactly one more. */
  function reconcile() {
    if (queuedReconcile) return queuedReconcile;
    const p = exclusive(async () => {
      if (queuedReconcile === p) queuedReconcile = null;
      try {
        await reconcileOnce();
      } catch (e) {
        warn("[summary-model] reconcile failed:", e);
      }
    });
    queuedReconcile = p;
    return p;
  }

  async function ensureSnapshot() {
    if (!snap) await reconcile();
    return snap;
  }

  function publicStatus(s) {
    const cands = shortlist(s.ranked, s.state === "ok" || (s.state === "unknown" && s.current && s.byKey.has(keyOf(s.current.providerID, s.current.modelID))) ? s.current : null).map(publicCandidate);
    return {
      current: s.current,
      state: s.state,
      ...(s.state !== "ok" && s.reason ? { reason: s.reason } : {}),
      betterAvailable: s.betterAvailable,
      candidates: cands,
    };
  }

  async function status() {
    return publicStatus(await ensureSnapshot());
  }

  async function search({ query } = {}) {
    const s = await ensureSnapshot();
    return { models: searchSummaryCandidates(s.ranked, query, SUMMARY_SEARCH_MAX).map(publicCandidate) };
  }

  /** @param {{ providerID?: string, modelID?: string, none?: boolean }} input */
  function set(input) {
    return exclusive(async () => {
      if (input?.none === true) {
        await d.configUpdate({ summaryModel: null, summaryModelOptOut: true });
        await reconcileOnce();
        return publicStatus(snap);
      }
      const { providerID, modelID } = input ?? {};
      if (!isStr(providerID) || !isStr(modelID)) throw Object.assign(new Error(REASON_NOT_ELIGIBLE), { rpcStatus: 400 });
      if (!snap || snap.listFailed) await reconcileOnce();
      if (!snap?.byKey.has(keyOf(providerID, modelID))) throw Object.assign(new Error(REASON_NOT_ELIGIBLE), { rpcStatus: 400 });
      await d.configUpdate({ summaryModel: { providerID, modelID, source: "user", pickedAt: now() }, summaryModelOptOut: false });
      await reconcileOnce();
      return publicStatus(snap);
    });
  }

  /** The Summary model — only while its status is `ok` — as a model record with its context limit; else null. NEVER the session model. */
  async function activeModel() {
    const s = await ensureSnapshot();
    if (s.state !== "ok" || !s.active) return null;
    const m = s.active;
    return { providerID: m.providerID, modelID: m.id, name: m.name ?? m.id, limit: { context: m.limit?.context ?? 0 } };
  }

  /**
   * A.5: who writes a small one-shot job for this session — the Summary model
   * when `ok`, else the session's own last-used model, else null (the caller
   * skips; opencode is never left to choose).
   * @returns {Promise<{ providerID: string, modelID: string, from: "summary"|"session" }|null>}
   */
  async function resolveCheapWriter(sessionId) {
    try {
      const m = await activeModel();
      if (m) return { providerID: m.providerID, modelID: m.modelID, from: "summary" };
    } catch (e) {
      warn("[summary-model] summary model unreadable, trying the session's own:", e);
    }
    if (isStr(sessionId) && d.lastUsedModel) {
      const used = await d.lastUsedModel(sessionId).catch(() => null);
      if (used && isStr(used.providerID) && isStr(used.modelID)) return { providerID: used.providerID, modelID: used.modelID, from: "session" };
    }
    return null;
  }

  return { reconcile, status, search, set, activeModel, resolveCheapWriter };
}

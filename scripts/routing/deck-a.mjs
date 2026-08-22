// deck-a.mjs — Deck A, the scenario replay harness for Automatic Manta Routing
// (BET-1276).
//
// Runs the routing DECISION (src/shared/modelRouter.mjs chooseModel) against the
// LIVE box — real catalogue, real usage snapshots, real config — varying the
// five inputs that move the decision (agent, preset, conversation size,
// account state, candidate pool) through the dev-only overrides bag
// (src/shared/routingOverrides.mjs) and judging each scenario against DECISION
// PROPERTIES, never a model name (models change; the property is what the set
// is built on).
//
// The trick that makes this fast and non-destructive: `routing:choose` is
// read-only. We never send a prompt; we vary inputs and read the winner. The
// whole deck replays in seconds and reruns after every tuning change.
//
// HOW TO RUN:  npm run routing:deck
//
// It is deliberately NOT part of `npm test` — it depends on the box's live
// account/catalogue/ledger state, which the test suite forbids (AGENTS.md →
// Testing). It is a diagnostic you run and read.
//
// IMPORTANT — prompt content is NOT an input to routing. The decision is a
// lookup over { agent, preset, conversation size, attachments, account state,
// tick list }; it never reads the prompt. Do NOT rebuild this deck around
// prompt difficulty — see docs/routing-scenarios.md.

import { configGet } from "../../src/server/local.mjs";
import { listSnapshots } from "../../src/server/usage.mjs";
import { listRoutableModels } from "../../src/server/opencode.mjs";
import { buildRoutingServices } from "../../src/server/routingServices.mjs";
import { lookupModel, matchModel, allModels } from "../../src/server/modelCatalog.mjs";
import { createProviderHealth } from "../../src/server/providerHealth.mjs";
import { chooseModel } from "../../src/shared/modelRouter.mjs";
import { applyRoutingOverrides, resolveNowOverride } from "../../src/shared/routingOverrides.mjs";
import { endpointKey } from "../../src/shared/endpointKey.mjs";
import { tierForScore, qualityScore } from "../../src/shared/modelQuality.mjs";
import { tierRank } from "../../src/shared/modelGuide.mjs";
import { marginalCost } from "../../src/shared/marginalCost.mjs";
import { blendedPrice } from "../../src/shared/blendedPrice.mjs";
import { resolveIdentity } from "../../src/shared/modelIdentity.mjs";

// Optional ledger reader — degrades to "absent" when the box's Node can't
// provide it (the services contract: a missing ledger never breaks a decision).
let endpointSummary = null;
try {
  const mod = await import("../../src/server/modelLedger.mjs");
  endpointSummary = mod.endpointSummary ?? null;
} catch {
  endpointSummary = null;
}

const OVERRIDES_ON = process.env.NODE_ENV !== "production";
const isObj = (v) => v !== null && typeof v === "object";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmtMoney = (v) => (num(v) === null ? "-" : `$${v.toFixed(4)}`);

const catalogIndex = { lookupModel, matchModel, allModels };
const providerHealth = createProviderHealth({});
const providerHealthState = (pid) => providerHealth.state(pid);

async function buildBoxContext() {
  const cfg = (await configGet()) ?? {};
  const policy = isObj(cfg?.modelRouting) ? { ...cfg.modelRouting } : {};
  return { cfg, policy };
}

// Assemble the RoutingServices context the same way production does, then run
// the read-only decision through the shared overrides merge.
async function runDecision({ cfg, policy, scenario, nowMs }) {
  const surface = scenario.surface === "sub" ? "sub" : "main";
  let catalog = [];
  try {
    catalog = await listRoutableModels(surface, cfg);
    if (!Array.isArray(catalog)) catalog = [];
  } catch {
    catalog = [];
  }
  let services = null;
  try {
    const snapshotList = (() => {
      try {
        const s = listSnapshots();
        return Array.isArray(s) ? s : [];
      } catch {
        return [];
      }
    })();
    services = await buildRoutingServices(
      cfg,
      {
        catalogIndex,
        endpoints: catalog,
        snapshots: snapshotList,
        providerHealthState,
        endpointSummary: endpointSummary ?? undefined,
      },
      nowMs,
    );
  } catch {
    services = null;
  }

  const effNow = resolveNowOverride(scenario.overrides, OVERRIDES_ON, nowMs);

  const incumbentInput = scenario.incumbent;
  const fullIncumbent = incumbentInput
    ? catalog.find(
        (c) =>
          c?.providerID === incumbentInput.providerID &&
          String(c?.id ?? c?.modelID ?? "") ===
            String(incumbentInput.modelID ?? incumbentInput.id ?? ""),
      ) ?? null
    : null;
  const catalogIncumbent =
    fullIncumbent ??
    (incumbentInput
      ? { providerID: incumbentInput.providerID, id: incumbentInput.modelID ?? incumbentInput.id }
      : null);

  const { services: effServices, catalog: effCatalog } = applyRoutingOverrides({
    services,
    catalog,
    surface,
    overrides: scenario.overrides,
    gated: OVERRIDES_ON,
  });

  const decision = chooseModel({
    intent: {
      kind: surface === "sub" ? "subagent" : "main",
      agent: scenario.agent ?? "general",
      needs: scenario.needs ?? {},
      contextTokens: typeof scenario.contextTokens === "number" ? scenario.contextTokens : undefined,
      incumbent: catalogIncumbent,
    },
    catalog: effCatalog,
    policy: scenario.policyOverride ? { ...policy, ...scenario.policyOverride } : policy,
    nowMs: effNow,
    services: effServices,
  });

  return { decision, trace: decision.trace, catalog: effCatalog };
}

// The winner's "decision facts" — everything the matchers are allowed to read.
function factsOf({ decision, trace }) {
  const w = trace?.winner;
  const winner = decision?.model ?? null;
  return {
    winnerKey: endpointKey(winner),
    winnerModelID: winner?.id ?? winner?.modelID ?? null,
    winnerTier: tierForScore(w?.quality?.known ? w.quality.score : undefined),
    costValue: num(w?.cost?.value),
    costBasis: w?.cost?.basis ?? null,
    mixSource: w?.cost?.mixSource ?? null,
    reason: decision?.reason ?? "",
    changed: decision?.changed === true,
    trace,
  };
}

// The CLOSED matcher vocabulary (12b). The issue's list is the whole
// vocabulary; this deck documents two set-membership additions the §12c
// scenarios need which the list's negative-only `excludes` cannot express:
// `winnerIn` (winner is one of the given endpoint keys) and `winnerNotIn`
// (winner is none of them — the generalised, positive complement of the issue's
// `excludes`). They are still DECISION-property assertions (endpoint keys,
// never model names); keep the list closed to exactly the §12b set plus these
// two — do not add a new matcher here without updating the spec's closed list.
function evaluateExpectation(expect, fact, results) {
  if (!expect) return { pass: true, detail: "" };
  const fails = [];
  const check = (cond, detail) => {
    if (cond !== true) fails.push(detail);
  };
  const getCost = (ref) => (ref && ref.facts ? num(ref.facts.costValue) : null);

  if (expect.tierAtLeast !== undefined) {
    check(tierRank(fact.winnerTier) >= tierRank(String(expect.tierAtLeast)), `tier>=${expect.tierAtLeast} (got ${fact.winnerTier})`);
  }
  if (expect.tierAtMost !== undefined) {
    check(tierRank(fact.winnerTier) <= tierRank(String(expect.tierAtMost)), `tier<=${expect.tierAtMost} (got ${fact.winnerTier})`);
  }
  if (expect.sameModelAs !== undefined) {
    const ref = results[expect.sameModelAs];
    check(!!ref?.facts && ref.facts.winnerModelID === fact.winnerModelID, `sameModelAs ${expect.sameModelAs} (${ref?.facts?.winnerModelID} vs ${fact.winnerModelID})`);
  }
  if (expect.differentModelFrom !== undefined) {
    const ref = results[expect.differentModelFrom];
    check(!!ref?.facts && ref.facts.winnerModelID !== fact.winnerModelID, `differentModelFrom ${expect.differentModelFrom}`);
  }
  if (expect.equalsScenario !== undefined) {
    const ref = results[expect.equalsScenario];
    check(
      !!ref?.facts && ref.facts.winnerKey === fact.winnerKey && ref.facts.costBasis === fact.costBasis,
      `equalsScenario ${expect.equalsScenario}`,
    );
  }
  if (expect.cheaperThan !== undefined) {
    const refCost = getCost(results[expect.cheaperThan]);
    check(refCost !== null && fact.costValue !== null && fact.costValue < refCost, `cheaperThan ${expect.cheaperThan} (${fmtMoney(fact.costValue)} vs ${fmtMoney(refCost)})`);
  }
  if (expect.dearerThan !== undefined) {
    const refCost = getCost(results[expect.dearerThan]);
    check(refCost !== null && fact.costValue !== null && fact.costValue > refCost, `dearerThan ${expect.dearerThan} (${fmtMoney(fact.costValue)} vs ${fmtMoney(refCost)})`);
  }
  if (expect.keepsIncumbent !== undefined) {
    // keepsIncumbent=true means the decision KEPT the incumbent (changed=false).
    check(fact.changed !== !!expect.keepsIncumbent, `keepsIncumbent=${expect.keepsIncumbent} (changed=${fact.changed})`);
  }
  if (expect.excludes !== undefined) {
    const keys = Array.isArray(expect.excludes) ? expect.excludes : [expect.excludes];
    check(!keys.includes(fact.winnerKey), `excludes ${keys.join(",")} (winner ${fact.winnerKey})`);
  }
  if (expect.reasonMentions !== undefined) {
    check(String(expect.reasonMentions) !== "" && fact.reason.includes(String(expect.reasonMentions)), `reasonMentions "${expect.reasonMentions}" (got "${fact.reason}")`);
  }
  if (expect.traceField !== undefined) {
    const { path, equals } = expect.traceField;
    const val = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), fact.trace);
    check(val === equals, `traceField ${path}=${equals} (got ${JSON.stringify(val)})`);
  }
  if (expect.winnerIn !== undefined) {
    const keys = Array.isArray(expect.winnerIn) ? expect.winnerIn : [expect.winnerIn];
    check(keys.includes(fact.winnerKey), `winnerIn ${keys.join(",")} (got ${fact.winnerKey})`);
  }
  if (expect.winnerNotIn !== undefined) {
    const keys = Array.isArray(expect.winnerNotIn) ? expect.winnerNotIn : [expect.winnerNotIn];
    check(!keys.includes(fact.winnerKey), `winnerNotIn ${keys.join(",")} (got ${fact.winnerKey})`);
  }
  return { pass: fails.length === 0, detail: fails.join(", ") };
}

// Special scenario modes — the ones the spec's closed matcher list can't
// express because they are properties of a sequence, not a single decision.
//   pacing       (A19): same consumed %, early vs late in the window
//   determinism  (A26/A29): same winner+reason across N repeats incl. a
//                shuffled input order
//   sensitivity  (A30): change exactly one input at a time from a baseline
async function evaluateSpecial({ scenario, cfg, policy, results, mkRun, scenarioById }) {
  if (scenario.mode === "pacing") {
    // Same consumed %, two instants in the SAME subscription window. Pacing
    // (not gauge-reading) is proven by the cost differing materially with the
    // instant even though the gauge (pct) is identical.
    const DAY = 24 * 60 * 60 * 1000;
    const now0 = Date.now();
    const span = 30 * DAY;
    const startedAt = now0 - 15 * DAY;
    const resetsAt = startedAt + span;
    const account = {
      kind: "subscription",
      windows: [{ kind: "subscription", pct: scenario.pacing.pct, startedAt, resetsAt }],
      ...(scenario.pacing.overagePrice !== undefined ? { overagePrice: scenario.pacing.overagePrice } : {}),
    };
    const earlyNow = startedAt + span * scenario.pacing.earlyFraction;
    const lateNow = startedAt + span * scenario.pacing.lateFraction;
    const build = (nowMs) =>
      mkRun({ ...scenario, overrides: { ...(scenario.overrides ?? {}), accounts: { [scenario.pacing.providerID]: account }, nowMs } });
    const early = await build(earlyNow);
    const late = await build(lateNow);
    const e = num(early.facts.costValue);
    const l = num(late.facts.costValue);
    const ratio = e !== null && l !== null && l > 0 ? e / l : null;
    const pass = e !== null && l !== null && ratio !== null && (ratio >= 2 || 1 / ratio >= 2);
    return {
      pass,
      detail: `early=${fmtMoney(e)} late=${fmtMoney(l)} (${early.facts.costBasis} → ${late.facts.costBasis})`,
      facts: early.facts,
    };
  }
  if (scenario.mode === "determinism") {
    const n = scenario.repeats ?? 10;
    let first = null;
    let stable = true;
    for (let i = 0; i < n; i++) {
      // Shuffle the allowed-list so a tie between candidates must be resolved
      // the same way regardless of input order (the shuffle is what A26 is).
      let overrides = { ...(scenario.overrides ?? {}) };
      if (Array.isArray(overrides.enabledMain) || overrides.enabledMain === undefined) {
        const base = scenario.baseKeys ? [...scenario.baseKeys] : [];
        const shuf = [...base].sort(() => (shuffleRng() ? 1 : -1));
        overrides = { ...overrides, enabledMain: shuf.length ? shuf : overrides.enabledMain };
      }
      const r = await mkRun({ ...scenario, overrides });
      if (!first) first = r.facts;
      if (r.facts.winnerKey !== first.winnerKey || r.facts.reason !== first.reason) stable = false;
    }
    // Membership (winnerIn / specific expectations) is still evaluated on the
    // first repeat so the determinism scenario can also pin the intended set.
    const expect = evaluateExpectation(scenario.expect, first, results);
    const pass = stable && expect.pass;
    const detail = [`${n} repeats, winner ${first?.winnerKey}`, ...(stable ? [] : ["→ DIVERGED"]), ...(expect.pass ? [] : [expect.detail])].join(" ");
    return { pass, detail, facts: first };
  }
  if (scenario.mode === "sensitivity") {
    const base = scenarioById[scenario.baseline];
    if (!base) return { pass: false, detail: `unknown baseline ${scenario.baseline}`, facts: null };
    const out = [];
    let pass = true;
    for (const fl of scenario.flips) {
      // flip = the FULL baseline scenario with exactly the declared fields
      // overridden, so only that input differs from the baseline's winner.
      const flipped = { ...base, ...fl.scenario };
      const r = await mkRun(flipped);
      const moved = r.facts.winnerKey !== results[scenario.baseline]?.facts?.winnerKey;
      const ok = moved === !!fl.moves;
      if (!ok) pass = false;
      out.push(`${fl.label}:${moved ? "moved" : "kept"}${ok ? "" : " (WRONG)"}`);
    }
    return { pass, detail: out.join(" · "), facts: results[scenario.baseline]?.facts ?? null };
  }
  return { pass: true, detail: "", facts: null };
}

// Deterministic-ish shuffle seed so repeats are reproducible per run.
let _rng = 0x2f6e2b1;
function shuffleRng() {
  _rng = (_rng * 1103515245 + 12345) & 0x7fffffff;
  return _rng & 1;
}

async function main() {
  const fs = await import("node:fs/promises");
  const deck = JSON.parse(await fs.readFile(new URL("./scenarios.json", import.meta.url), "utf8"));
  const { cfg, policy } = await buildBoxContext();

  const results = {};
  const rows = [];
  const scenarioById = Object.fromEntries(deck.scenarios.map((s) => [s.id, s]));

  const mkRun = async (scenario) => {
    const r = await runDecision({ cfg, policy, scenario, nowMs: Date.now() });
    r.facts = factsOf(r);
    return r;
  };

  for (const scenario of deck.scenarios) {
    try {
      if (scenario.mode) {
        const res = await evaluateSpecial({ scenario, cfg, policy, results, mkRun, scenarioById });
        results[scenario.id] = { facts: res.facts, pass: res.pass, detail: res.detail };
        rows.push({ id: scenario.id, name: scenario.name, expected: scenario.expectedNote ?? "", ...res, winner: res.facts });
      } else {
        const r = await runDecision({ cfg, policy, scenario, nowMs: Date.now() });
        const fact = factsOf(r);
        const ev = evaluateExpectation(scenario.expect, fact, results);
        results[scenario.id] = { facts: fact, pass: ev.pass, detail: ev.detail };
        rows.push({ id: scenario.id, name: scenario.name, expected: scenario.expectedNote ?? "", pass: ev.pass, detail: ev.detail, winner: fact });
      }
    } catch (e) {
      results[scenario.id] = { facts: null, pass: false, detail: `ERROR ${e?.message ?? e}` };
      rows.push({ id: scenario.id, name: scenario.name, pass: false, detail: `ERROR ${e?.message ?? e}`, winner: null });
    }
  }

  printTable(rows);

  const findings = await inertSignalFindings({ cfg, policy, rows });

  const passed = rows.filter((r) => r.pass).length;
  console.log(`\n${"=".repeat(78)}`);
  console.log(`SUMMARY: ${passed}/${rows.length} scenarios passed · ${rows.length - passed} failed · ${findings.length} inert-signal finding(s)`);
  for (const r of rows) if (!r.pass) console.log(`  FAIL ${r.id}: ${r.detail}`);
  process.exitCode = rows.length - passed > 0 || findings.length > 0 ? 1 : 0;
}

function printTable(rows) {
  const w = (s, n) => String(s ?? "").slice(0, n).padEnd(n, " ");
  console.log("");
  console.log(`${w("id",5)} ${w("scenario",30)} ${w("expected",26)} ${w("winner",30)} ${w("basis",16)} ${w("result",6)}`);
  console.log("─".repeat(120));
  for (const r of rows) {
    const winner = r.winner ? r.winner.winnerKey : "-";
    const basis = r.winner ? r.winner.costBasis : "-";
    console.log(`${w(r.id,5)} ${w(r.name,30)} ${w(r.expected ?? "",26)} ${w(winner,30)} ${w(basis,16)} ${r.pass ? "PASS" : "FAIL"}`);
    if (!r.pass && r.detail) console.log(`      └ ${r.detail}`);
  }
}

// Per-endpoint marginal cost + blended price, resolved the SAME way the router
// does (identity → effective model, per-endpoint mix, reference, account) so
// the inert-signal checks read production values, not a guess. Mirrors
// `assess()` in src/shared/modelRouter.mjs for the cost/quality fields only.
function endpointCost(c, services, nowMs, replacementCost) {
  const key = endpointKey(c);
  const dec = services?.declared?.[key] ?? null;
  let m = c;
  try {
    const identity = resolveIdentity(c, dec, services?.catalogMatcher);
    m = identity?.effective ?? c;
  } catch {
    m = c;
  }
  const mix = services?.mix?.[key] ?? services?.mixDefault;
  const ref = dec?.price !== undefined ? null : services?.referenceByModel?.[c.id];
  const bp = blendedPrice(m, mix, ref);
  const now = num(nowMs) ?? Date.now();
  const cost = marginalCost({
    model: m,
    account: services?.accounts?.[c.providerID] ?? null,
    nowMs: now,
    mix,
    reference: ref,
    replacementCost,
  });
  return { key, blended: bp, cost };
}

// The cheapest acceptable non-subscription alternative (mirrors
// computeReplacementCost in modelRouter.mjs) — the subscription exchange rate.
function computeReplacementCost(catalog, services) {
  let best = null;
  for (const c of Array.isArray(catalog) ? catalog : []) {
    const account = services?.accounts?.[c.providerID] ?? null;
    if (account?.kind === "subscription") continue;
    const key = endpointKey(c);
    const dec = services?.declared?.[key] ?? null;
    let m = c;
    try {
      const identity = resolveIdentity(c, dec, services?.catalogMatcher);
      m = identity?.effective ?? c;
    } catch {
      m = c;
    }
    const ref = dec?.price !== undefined ? null : services?.referenceByModel?.[c.id];
    const p = blendedPrice(m, services?.mix?.[key] ?? services?.mixDefault, ref).price;
    if (best === null || num(p) === null) continue;
    if (num(p) < best) best = num(p);
  }
  return best === null ? undefined : best;
}

const distinctCount = (vals) =>
  new Set(
    vals
      .filter((v) => num(v) !== null)
      .map((v) => Math.fround(num(v))),
  ).size;

async function inertSignalFindings({ cfg, policy, rows }) {
  const findings = [];
  let catalog = [];
  let services = {};
  try {
    const snapshotList = (() => {
      try {
        const s = listSnapshots();
        return Array.isArray(s) ? s : [];
      } catch {
        return [];
      }
    })();
    catalog = await listRoutableModels("main", cfg);
    services = await buildRoutingServices(
      cfg,
      { catalogIndex, endpoints: catalog, snapshots: snapshotList, providerHealthState, endpointSummary: endpointSummary ?? undefined },
      Date.now(),
    );
  } catch (e) {
    findings.push(`catalogue scan unavailable: ${e?.message ?? e}`);
    return findings;
  }

  // Per-endpoint cost facts, computed once for checks 1 & 5.
  const nowMs = Date.now();
  const replacementCost = computeReplacementCost(catalog, services);
  const costByKey = {};
  for (const c of catalog) costByKey[endpointKey(c)] = endpointCost(c, services, nowMs, replacementCost);

  // 1. all marginal costs equal — the DEFAULT_MIX signature (pricing is inert
  // when every endpoint prices identically).
  const priced = Object.values(costByKey).filter((ec) => ec.cost?.exhausted !== true && num(ec.cost?.cost) !== null);
  if (catalog.length > 1 && priced.length > 1) {
    const distinct = new Set(priced.map((ec) => Math.fround(num(ec.cost.cost))));
    if (distinct.size === 1) {
      findings.push(`all ${priced.length} routable endpoints share one marginal cost (${fmtMoney(num(priced[0].cost.cost))}) — the DEFAULT_MIX signature`);
    }
  }

  // 2. more than 40% of endpoints resolve to quality-unknown. Resolve quality
  // the SAME WAY the router does (qualityScore against the resolved catalogue
  // entry) so the finding reflects production, not a crude proxy. Report the
  // offending endpoints so it is actionable (12d).
  let qualityUnknown = 0;
  const unknownEndpoints = [];
  for (const c of catalog) {
    let known = false;
    try {
      const entry =
        typeof services?.catalogEntryFor === "function" ? services.catalogEntryFor(c) : null;
      const q = qualityScore(c, entry, services?.qualityField);
      known = !!q && q.known !== false;
    } catch {
      known = false;
    }
    if (!known) {
      qualityUnknown++;
      unknownEndpoints.push(endpointKey(c));
    }
  }
  if (catalog.length && qualityUnknown / catalog.length > 0.4) {
    findings.push(`>40% of endpoints resolve to quality-unknown (${qualityUnknown}/${catalog.length}): ${unknownEndpoints.join(", ")}`);
  }

  // 3. a hard filter that never fires anywhere across the deck.
  const fireCounts = { "context headroom": 0, "tool calling": 0, "image input": 0, "pdf input": 0, "out-of-credit": 0 };
  for (const r of rows) {
    const dropped = r.winner && r.winner.trace && Array.isArray(r.winner.trace.dropped) ? r.winner.trace.dropped : [];
    for (const d of dropped) {
      if (Object.prototype.hasOwnProperty.call(fireCounts, d.reason)) fireCounts[d.reason] += d.n ?? 1;
    }
  }
  for (const [filter, count] of Object.entries(fireCounts)) {
    if (count === 0) findings.push(`hard filter never fires anywhere in the deck: ${filter}`);
  }

  // 4. reliability, latency AND throughput each distinguish at least one pair.
  const relVals = catalog.map((c) => services?.reliability?.samples?.[endpointKey(c)]?.rate);
  const p50Vals = catalog.map((c) => services?.telemetry?.[endpointKey(c)]?.p50Ms ?? null);
  const p90Vals = catalog.map((c) => services?.telemetry?.[endpointKey(c)]?.p90Ms ?? null);
  const tpVals = catalog.map((c) => services?.telemetry?.[endpointKey(c)]?.tokensPerSec ?? null);
  if (catalog.length > 1) {
    const rel = distinctCount(relVals);
    if (rel < 2) findings.push(`reliability does not distinguish any pair of endpoints (${rel === 0 ? "no samples" : `${rel} distinct value`})`);
    const p50 = distinctCount(p50Vals);
    if (p50 < 2) findings.push(`latency p50 does not distinguish any pair of endpoints (${p50 === 0 ? "no telemetry" : `${p50} distinct value`})`);
    const p90 = distinctCount(p90Vals);
    if (p90 < 2) findings.push(`latency p90 does not distinguish any pair of endpoints (${p90 === 0 ? "no telemetry" : `${p90} distinct value`})`);
    const tp = distinctCount(tpVals);
    if (tp < 2) findings.push(`throughput does not distinguish any pair of endpoints (${tp === 0 ? "no telemetry" : `${tp} distinct value`})`);
  }

  // 5. any endpoint whose cost.basis is unknown while its provider reports a
  // cost — the "provider prices it but routing didn't read the account" tell.
  const unknownWithCost = [];
  for (const ec of Object.values(costByKey)) {
    if (ec.cost?.basis === "unknown" && ec.blended?.known === true && num(ec.blended.price) > 0) {
      unknownWithCost.push(ec.key);
    }
  }
  if (unknownWithCost.length) {
    findings.push(`endpoint(s) priced cost.basis=unknown while the provider reports a cost: ${unknownWithCost.join(", ")}`);
  }

  // 6. a decision using default mix while the ledger has data.
  const hasLedger = !!services?.reliability?.samples && Object.keys(services.reliability.samples).length > 0;
  for (const r of rows) {
    if (r.winner && r.winner.mixSource === "default" && hasLedger) {
      findings.push(`decision ${r.id} used default mix while the ledger has data`);
    }
  }

  console.log("\nINERT-SIGNAL SECTION (12d):");
  if (findings.length === 0) {
    console.log("  no inert signals — every signal varies across the live catalogue");
  } else {
    for (const f of findings) console.log(`  FINDING: ${f}`);
  }
  return findings;
}

main().catch((e) => {
  console.error("[deck-a] fatal:", e?.message ?? e);
  process.exitCode = 1;
});

// src/server/ctoFacts.mjs — the Adaptive CTO Blackboard store + gatekeeper
// (BET-1389 / spec §6.1–§6.8).
//
// The blackboard is a per-project collection of durable *facts* — short,
// evidence-backed statements maintained by the CTO. Facts are created through
// a **collaborative pipeline** (D10): any producer (an agent session, the CTO
// itself, the user, or a rollup sync) submits a *proposal* to a per-project
// FIFO queue (D3 — single writer per project), and a **gatekeeper** resolves
// it into add/update/supersede/merge/reject. Nothing writes facts directly
// except the gatekeeper — that single-writer rule is the whole point.
//
// Determinism + testability: the module is dependency-injected like the other
// server engines. Pure functions (retention math, queue idempotency, the
// head-of-chain rule, checkable pattern matching, half-life tuning) are what
// the tests pin; `createFactsEngine` wires them to real stores and model I/O.
// All model-needing steps go through the injected `runEphemeral` (`gatekeeper`
// task class, §12.3) and degrade deterministically when no model runner is
// present — the engine keeps working with a degraded gatekeeper, no model cost.
//
// Storage:
//   - facts/<project>.json         — active facts ({v, facts:[…]}), cap 50.
//   - facts-archive/<project>.json — superseded/displaced facts ({v, entries}),
//                                    capped at 10× (ctoStores.mjs §6.3).
//   - engine-state.json            — per-project pending proposal queue + the
//                                    applied-proposal idempotency record, sender
//                                    reliability Beta counters, checkable verify
//                                    bookkeeping, and half-life tuning state.

import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { factsStore, factsArchiveStore, ledgerStore, engineStateStore } from "./ctoStores.mjs";

export const FACT_VERSION = 1;

export const KINDS = Object.freeze([
  "status",
  "blocker",
  "decision",
  "theory",
  "invariant",
  "anomaly",
]);

export const CAP_ACTIVE = 50;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

// Default per-kind half-lives (§6.4, D11), in HOURS. Tuned monthly (§6.8).
//   blocker -> no decay while an unresolved ref exists (holds until resolved).
export const HALF_LIVES_POLICY = Object.freeze({
  status: 3 * 24,
  blocker: null,
  decision: 180 * 24,
  theory: 21 * 24,
  invariant: 180 * 24,
  anomaly: 7 * 24,
});

export const KIND_WEIGHTS = Object.freeze({
  status: 1,
  blocker: 1,
  decision: 1,
  theory: 1,
  invariant: 1,
  anomaly: 1,
});

export const TUNING_CLAMP = 0.5;
export const VERIFY_CYCLE_MS = 6 * HOUR_MS;
export const OVERTURN_WINDOW_MS = 48 * HOUR_MS;

const STATEMENT_LIMIT = 200;

export function senderKey(sender) {
  if (sender && typeof sender === "object" && sender.sessionID) {
    return `session:${sender.sessionID}`;
  }
  if (typeof sender === "string" && sender.length > 0) return sender;
  return "unknown";
}

export function validateFact(f) {
  if (!f || typeof f !== "object") return false;
  if (f.v !== FACT_VERSION) return false;
  if (!KINDS.includes(f.kind)) return false;
  if (typeof f.statement !== "string" || f.statement.length === 0) return false;
  if (f.statement.length > STATEMENT_LIMIT) return false;
  if (!Array.isArray(f.refs) || f.refs.length === 0) return false;
  if (!f.refs.every((r) => typeof r === "string" && r.length > 0)) return false;
  if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) return false;
  if (typeof f.id !== "string" || f.id.length === 0) return false;
  return true;
}

export function newFactId({ project, statement, refs, nowMs }) {
  return (
    "cto:" +
    createHash("sha1")
      .update(`${project}|${statement}|${Array.isArray(refs) ? refs.join(",") : ""}|${nowMs ?? 0}`)
      .digest("hex")
      .slice(0, 12)
  );
}

export function isActiveFact(f) {
  return !!f && !f.superseded_by;
}

export function liveHeadOf(fact, activeById) {
  let cur = fact;
  let guard = 0;
  while (cur && cur.superseded_by && activeById?.[cur.superseded_by] && guard < 1024) {
    cur = activeById[cur.superseded_by];
    guard += 1;
  }
  return cur;
}

export function archiveEntry(fact, nowMs) {
  return { ...fact, ts: nowMs };
}

export function senderReliability({ confirmed = 0, rejected = 0 } = {}) {
  return (confirmed + 1) / (confirmed + rejected + 2);
}

export function retentionOf(fact, { nowMs, halfLives = HALF_LIVES_POLICY, weights = KIND_WEIGHTS, reliability = 1 } = {}) {
  if (!fact) return 0;
  const t = nowMs ?? Date.now();
  if (fact.valid_until != null && t >= fact.valid_until) return 0;
  const weight = weights[fact.kind] ?? 1;
  const lastAccess = fact.last_accessed ?? fact.created ?? t;
  const hours = Math.max(0, (t - lastAccess) / HOUR_MS);
  const hl = halfLives?.[fact.kind] ?? null;
  let decay;
  if (fact.kind === "blocker" && Array.isArray(fact.refs) && fact.refs.length > 0) {
    decay = 1;
  } else if (hl == null || hl <= 0) {
    decay = 1;
  } else {
    decay = Math.pow(0.5, hours / hl);
  }
  const access = 1 + Math.log(1 + (fact.access_count ?? 0));
  return weight * decay * access * reliability;
}

export function lowestRetention(activeFacts, opts) {
  if (!Array.isArray(activeFacts)) return { fact: null, score: null };
  let best = null;
  let bestScore = null;
  for (const f of activeFacts) {
    if (!isActiveFact(f)) continue;
    const s = retentionOf(f, opts);
    if (bestScore == null || s < bestScore) {
      best = f;
      bestScore = s;
    }
  }
  return { fact: best, score: bestScore };
}

export function validateProposal(p) {
  if (!p || typeof p !== "object") return false;
  if (typeof p.proposalId !== "string" || p.proposalId.length === 0) return false;
  if (typeof p.project !== "string" || p.project.length === 0) return false;
  if (!KINDS.includes(p.kind)) return false;
  if (typeof p.statement !== "string" || p.statement.length === 0) return false;
  if (p.statement.length > STATEMENT_LIMIT) return false;
  if (!Array.isArray(p.refs)) return false;
  return true;
}

export function enqueueProposal(state, proposal) {
  if (!validateProposal(proposal)) return { state, added: false, reason: "invalid" };
  const s = state ?? {};
  const queue = { ...(s.factQueue ?? {}) };
  const applied = { ...(s.appliedProposals ?? {}) };
  if (applied[proposal.proposalId]) return { state: s, added: false, reason: "already-applied" };
  const proj = proposal.project;
  const list = Array.isArray(queue[proj]) ? queue[proj].slice() : [];
  if (list.some((q) => q.proposalId === proposal.proposalId)) {
    return { state: s, added: false, reason: "already-queued" };
  }
  list.push(proposal);
  queue[proj] = list;
  return { state: { ...s, factQueue: queue, appliedProposals: applied }, added: true };
}

export function popProposal(state, project) {
  const queue = { ...(state?.factQueue ?? {}) };
  const list = Array.isArray(queue[project]) ? queue[project].slice() : [];
  if (list.length === 0) return { state, proposal: null };
  const [proposal, ...rest] = list;
  const next = { ...(state ?? {}), factQueue: { ...queue, [project]: rest } };
  return { state: next, proposal };
}

export function markApplied(state, proposalId, outcome) {
  const s = state ?? {};
  const applied = { ...(s.appliedProposals ?? {}) };
  applied[proposalId] = outcome ?? { action: "processed" };
  return { ...s, appliedProposals: applied };
}

export async function gatekeeperPrecheck(proposal, activeFacts, { resolveRef = null, traceRefs = true } = {}) {
  if (!Array.isArray(proposal.refs) || proposal.refs.length === 0) {
    return { ok: false, reason: "zero refs" };
  }
  const targetId = proposal.supersedes == null ? null : String(proposal.supersedes);
  if (targetId) {
    const idx = new Map((activeFacts ?? []).map((f) => [f.id, f]));
    const target = idx.get(targetId);
    if (!target) return { ok: false, reason: "supersede target not found", targetId };
    if (!isActiveFact(target)) {
      const head = liveHeadOf(target, Object.fromEntries(idx));
      return { ok: false, reason: "supersede target is not the live head", targetId: head?.id ?? targetId };
    }
  }
  if (resolveRef && traceRefs) {
    for (const ref of proposal.refs) {
      let ok = false;
      try {
        ok = (await resolveRef(ref)) === true;
      } catch {
        ok = false;
      }
      if (!ok) return { ok: false, reason: "unresolved ref", ref };
    }
  }
  return { ok: true, targetId };
}

export function buildGatekeeperContext(proposal, activeFacts) {
  const heads = (activeFacts ?? [])
    .filter(isActiveFact)
    .slice(0, 12)
    .map(
      (f) =>
        `- [${f.id}] (${f.kind}, conf ${f.confidence}) ${f.statement} ` +
        `refs:[${(f.refs ?? []).join(",")}]`,
    )
    .join("\n");
  return [
    {
      priority: "high",
      text:
        `You are the blackboard gatekeeper. Decide how to file this proposal from sender "${senderKey(proposal.sender)}". ` +
        `Return ONE line of JSON: {"action":"add"|"update"|"supersede"|"merge"|"reject","targetId":"<id or null>","reason":"<short>"}. ` +
        `"supersede" replaces a head fact (old stays, chained); "merge" unions refs into an existing fact; ` +
        `"update" refines an existing fact in place; "reject" refuses. Never invent refs.`,
    },
    {
      priority: "high",
      text: `Proposal kind=${proposal.kind} conf=${proposal.confidence ?? 0.5} valid_until=${proposal.valid_until ?? "none"}\n${proposal.statement}\nrefs:[${(proposal.refs ?? []).join(",")}]`,
    },
    { priority: "medium", text: `Existing LIVE facts:\n${heads || "(none)"}` },
  ];
}

export function parseGatekeeperDecision(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const action = ["add", "update", "supersede", "merge", "reject"].includes(parsed.action)
      ? parsed.action
      : null;
    if (!action) return null;
    return {
      action,
      targetId: parsed.targetId == null ? null : String(parsed.targetId),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

export function validateDecision(decision, activeFacts, proposal) {
  const targetId = decision?.targetId ? String(decision.targetId) : null;
  const target =
    targetId && Array.isArray(activeFacts) ? activeFacts.find((f) => f.id === targetId && isActiveFact(f)) : null;
  if (decision?.action === "add" || decision?.action === "reject") {
    return { action: decision.action, targetId: null, reason: decision.reason ?? "" };
  }
  if (target) return { action: decision.action, targetId: target.id, reason: decision.reason ?? "" };
  const proposed = proposal.supersedes ? String(proposal.supersedes) : null;
  const proposedTarget =
    proposed && Array.isArray(activeFacts) ? activeFacts.find((f) => f.id === proposed && isActiveFact(f)) : null;
  if (proposedTarget) {
    return { action: "supersede", targetId: proposedTarget.id, reason: "degraded: invalid model target" };
  }
  return { action: "add", targetId: null, reason: "degraded: no valid target" };
}

export function applyResolution(proposal, decision, activeFacts, { nowMs = Date.now() } = {}) {
  const now = nowMs;
  const facts = Array.isArray(activeFacts) ? activeFacts.slice() : [];
  const action = decision?.action ?? "add";
  const targetId = decision?.targetId ? String(decision.targetId) : null;
  const targetIndex = facts.findIndex((f) => f.id === targetId && isActiveFact(f));
  const target = targetIndex >= 0 ? facts[targetIndex] : null;

  if (action === "reject") return { action, reason: decision?.reason ?? "rejected", facts };
  if (action === "update" && target) {
    facts[targetIndex] = {
      ...target,
      statement: proposal.statement ?? target.statement,
      confidence: proposal.confidence ?? target.confidence,
      refs: Array.from(new Set([...(target.refs ?? []), ...(proposal.refs ?? [])])),
      last_accessed: now,
      access_count: (target.access_count ?? 0) + 1,
    };
    return { action, targetId: target.id, facts };
  }
  if (action === "merge" && target) {
    facts[targetIndex] = {
      ...target,
      refs: Array.from(new Set([...(target.refs ?? []), ...(proposal.refs ?? [])])),
      confidence: Math.max(target.confidence ?? 0, proposal.confidence ?? 0),
      last_accessed: now,
      access_count: (target.access_count ?? 0) + 1,
    };
    return { action, targetId: target.id, facts };
  }

  const id = newFactId({ project: proposal.project, statement: proposal.statement, refs: proposal.refs, nowMs: now });
  const newFact = {
    v: FACT_VERSION,
    id,
    kind: proposal.kind,
    statement: proposal.statement,
    refs: proposal.refs.slice(),
    confidence: proposal.confidence ?? 0.5,
    created: proposal.created ?? now,
    last_accessed: now,
    access_count: 0,
    sender: proposal.sender,
  };
  if (proposal.valid_until != null) newFact.valid_until = proposal.valid_until;
  if (action === "supersede" && target) {
    const ti = facts.findIndex((f) => f.id === target.id);
    if (ti >= 0) facts[ti] = { ...facts[ti], superseded_by: id };
  }
  facts.push(newFact);
  return { action, facts, factId: id, targetId: target ? target.id : null };
}

export function enforceCap(activeFacts, { cap = CAP_ACTIVE, nowMs, halfLives, weights } = {}) {
  const facts = Array.isArray(activeFacts) ? activeFacts.slice() : [];
  const displaced = [];
  while (facts.filter(isActiveFact).length > cap) {
    const low = lowestRetention(facts, { nowMs, halfLives, weights });
    if (!low.fact) break;
    const i = facts.findIndex((f) => f.id === low.fact.id);
    if (i < 0) break;
    displaced.push(facts.splice(i, 1)[0]);
  }
  return { facts, displaced };
}

export function matchCheckable(statement) {
  const s = String(statement ?? "");
  const branch = s.match(/\bbranch\s+([A-Za-z0-9_\-.\/]+)\b/i);
  if (branch) return { kind: "branch", surface: "git", probe: branch[1] };
  const ci = s.match(/\bCI\b[\s\S]*?\b(green|passing|passed|failed|failing|broken)\b/i);
  if (ci) return { kind: "ci", surface: "ci", probe: ci[1].toLowerCase() };
  const issue = s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  if (issue) return { kind: "issue", surface: "issue", probe: issue[1] };
  const ver = s.match(/\bversion\s+(\d+(?:\.\d+){1,3})\b/i);
  if (ver) return { kind: "version", surface: "version", probe: ver[1] };
  return null;
}

export async function maybeStampCheckable(fact, { surfaceExists = async () => false } = {}) {
  if (fact?.checkable) return fact;
  const match = matchCheckable(fact?.statement);
  if (!match || typeof surfaceExists !== "function") return fact;
  let exists = false;
  try {
    exists = (await surfaceExists(match.surface)) === true;
  } catch {
    exists = false;
  }
  if (!exists) return fact;
  return { ...fact, checkable: { probe: match.probe, last_checked: 0, result: null } };
}

export function median(arr) {
  const a = Array.isArray(arr) ? arr.slice().sort((x, y) => x - y) : [];
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function recomputeHalfLives(entries, { halfLivesPolicy = HALF_LIVES_POLICY, clamp = TUNING_CLAMP } = {}) {
  const out = {};
  if (!Array.isArray(entries)) return out;
  for (const kind of KINDS) {
    const base = halfLivesPolicy[kind];
    if (base == null || base <= 0) continue;
    const hrs = entries
      .filter((e) => e && e.kind === kind && typeof e.hours === "number")
      .map((e) => e.hours);
    const med = median(hrs);
    if (med == null) continue;
    const lo = base * (1 - clamp);
    const hi = base * (1 + clamp);
    out[kind] = Math.max(1, Math.min(hi, Math.max(lo, med)));
  }
  return out;
}

export function createFactsEngine(deps = {}) {
  const {
    facts = factsStore,
    archive = factsArchiveStore,
    engineState = engineStateStore,
    ledger = ledgerStore,
    runEphemeral = null,
    now = () => Date.now(),
    presenceCheck = async () => false,
    surfaceExists = async () => false,
    verify = async () => ({ ok: true }),
    resolveRef = null,
    traceRefs = true,
    halfLives = null,
    listProjects = null,
  } = deps;

  let disposed = false;

  async function log(entry) {
    try {
      await ledger.append({ actor: "cto", ts: now(), ...entry });
    } catch {}
  }

  async function loadState() {
    try {
      const s = await engineState.load();
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  }
  async function saveState(s) {
    try {
      await engineState.save({ ...s, v: 1 });
    } catch {}
  }

  function currentHalfLives(tuning) {
    const tuned = tuning?.halfLives && Object.keys(tuning.halfLives).length ? tuning.halfLives : null;
    return { ...HALF_LIVES_POLICY, ...(halfLives ?? tuned ?? {}) };
  }

  async function loadFacts(project) {
    try {
      const p = await facts.load(project);
      return Array.isArray(p?.facts) ? p.facts : [];
    } catch {
      return [];
    }
  }
  async function saveFacts(project, factArray) {
    await facts.save(project, { v: 1, facts: factArray });
  }
  async function loadArchive(project) {
    try {
      const p = await archive.load(project);
      return Array.isArray(p?.entries) ? p.entries : [];
    } catch {
      return [];
    }
  }
  async function saveArchive(project, entries) {
    await archive.save(project, { v: 1, entries });
  }

  async function listKnownProjects() {
    if (typeof listProjects === "function") {
      try {
        const p = await listProjects();
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    try {
      const dir = facts.dir;
      if (typeof dir !== "string" || !dir) return [];
      const names = await readdir(dir);
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  async function bumpReliability(sender, delta) {
    const key = senderKey(sender);
    if (!key) return;
    const state = await loadState();
    const rel = { ...(state.factReliability ?? {}) };
    const cur = { confirmed: 0, rejected: 0, ...(rel[key] ?? {}) };
    if (delta.confirmed) cur.confirmed += delta.confirmed;
    if (delta.rejected) cur.rejected += delta.rejected;
    rel[key] = cur;
    await saveState({ ...state, factReliability: rel });
  }

  async function submitProposal(raw) {
    const proposal = { created: now(), sender: "cto", ...raw };
    if (!validateProposal(proposal)) return { ok: false, error: "invalid proposal" };
    const state = await loadState();
    const res = enqueueProposal(state, proposal);
    if (res.added) await saveState(res.state);
    return { ok: res.added, added: res.added, reason: res.reason, proposalId: proposal.proposalId };
  }

  async function resolveOne(proposal, activeFacts) {
    const pre = await gatekeeperPrecheck(proposal, activeFacts, { resolveRef, traceRefs });
    if (!pre.ok) return { action: "reject", reason: pre.reason, reject: true };
    let decision = null;
    if (runEphemeral) {
      try {
        const res = await runEphemeral({
          taskClass: "gatekeeper",
          context: buildGatekeeperContext(proposal, activeFacts),
        });
        decision = parseGatekeeperDecision(typeof res?.text === "string" ? res.text : null);
      } catch {
        decision = null;
      }
    }
    if (!decision) {
      decision = {
        action: proposal.supersedes ? "supersede" : "add",
        targetId: proposal.supersedes ?? null,
        reason: "degraded",
      };
    }
    const validated = validateDecision(decision, activeFacts, proposal);
    const applied = applyResolution(proposal, validated, activeFacts, { nowMs: now() });
    if (applied.action === "reject") return { ...applied, reject: true };
    return applied;
  }

  function mergeReliability(st, key, delta) {
    const rel = { ...(st.factReliability ?? {}) };
    const cur = { confirmed: 0, rejected: 0, ...(rel[key] ?? {}) };
    cur.confirmed += delta.confirmed ?? 0;
    cur.rejected += delta.rejected ?? 0;
    rel[key] = cur;
    return { ...st, factReliability: rel };
  }

  async function pump(project) {
    if (disposed) return { processed: 0, byAction: {} };
    let state = await loadState();
    const tally = { processed: 0, byAction: {} };
    const relDeltas = new Map(); // senderKey -> {confirmed, rejected}
    const noteRel = (sender, delta) => {
      const key = senderKey(sender);
      if (!key) return;
      const e = relDeltas.get(key) ?? { confirmed: 0, rejected: 0 };
      relDeltas.set(key, {
        confirmed: e.confirmed + (delta.confirmed ?? 0),
        rejected: e.rejected + (delta.rejected ?? 0),
      });
    };
    const projects = project ? [project] : Object.keys(state.factQueue ?? {});
    for (const proj of projects) {
      const halfLivesNow = currentHalfLives(state.factTuning ?? {});
      for (;;) {
        const pop = popProposal(state, proj);
        if (!pop.proposal) break;
        const proposal = pop.proposal;
        state = pop.state;
        if (state.appliedProposals?.[proposal.proposalId]) continue;
        let activeFacts = await loadFacts(proj);
        const result = await resolveOne(proposal, activeFacts);
        let outcome;
        if (result.reject) {
          outcome = { action: "reject", reason: result.reason };
          noteRel(proposal.sender, { rejected: 1 });
          await log({ kind: "cto.fact_reject", project: proj, proposalId: proposal.proposalId, reason: result.reason });
        } else {
          const capRes = enforceCap(result.facts, { cap: CAP_ACTIVE, nowMs: now(), halfLives: halfLivesNow });
          if (capRes.displaced.length > 0) {
            const entries = await loadArchive(proj);
            await saveArchive(proj, [...entries, ...capRes.displaced.map((f) => archiveEntry(f, now()))]);
            await log({ kind: "cto.fact_displace", project: proj, count: capRes.displaced.length });
          }
          activeFacts = capRes.facts;
          const newId = result.factId;
          const fi = newId ? activeFacts.findIndex((f) => f.id === newId) : -1;
          if (fi >= 0) {
            const stamped = await maybeStampCheckable(activeFacts[fi], { surfaceExists });
            if (stamped !== activeFacts[fi]) activeFacts[fi] = stamped;
          }
          await saveFacts(proj, activeFacts);
          outcome = { action: result.action, targetId: result.targetId, factId: result.factId };
          if (result.action === "supersede" && result.targetId) {
            const present = await presenceCheck();
            await log({ kind: "cto.fact_supersede", project: proj, superseded: result.targetId, replacement: result.factId, present });
            const old = (await loadFacts(proj)).find((x) => x.id === result.targetId);
            if (old && typeof old.created === "number") {
              const st = await loadState();
              const lifespans = [...(st.factTuning?.lifespans ?? []), { kind: proposal.kind, hours: (now() - old.created) / HOUR_MS }];
              await saveState({ ...st, factTuning: { ...(st.factTuning ?? {}), lifespans } });
            }
            if (old && now() - (old.created ?? 0) < OVERTURN_WINDOW_MS) {
              await bumpReliability(old.sender, { rejected: 1 });
            }
          }
        }
        state = markApplied(state, proposal.proposalId, outcome);
        tally.processed += 1;
        tally.byAction[outcome.action] = (tally.byAction[outcome.action] ?? 0) + 1;
      }
    }
    for (const [key, delta] of relDeltas) {
      state = mergeReliability(state, key, delta);
    }
    await saveState(state);
    return tally;
  }

  async function touchFacts({ project, ids }) {
    if (!Array.isArray(ids) || ids.length === 0) return { touched: 0 };
    const projects = project ? [project] : await listKnownProjects();
    let touched = 0;
    for (const proj of projects) {
      const active = await loadFacts(proj);
      let changed = false;
      const byId = new Set(ids);
      for (let i = 0; i < active.length; i++) {
        if (byId.has(active[i]?.id) && isActiveFact(active[i])) {
          active[i] = { ...active[i], last_accessed: now(), access_count: (active[i].access_count ?? 0) + 1 };
          changed = true;
          touched += 1;
        }
      }
      if (changed) await saveFacts(proj, active);
    }
    return { touched };
  }

  async function verifyDue() {
    if (disposed) return { checked: 0, superseded: 0 };
    const t = now();
    let checked = 0;
    let superseded = 0;
    let seq = 0;
    for (const proj of await listKnownProjects()) {
      let working = await loadFacts(proj);
      let changed = false;
      const failed = [];
      for (let i = 0; i < working.length; i++) {
        const f = working[i];
        if (!f?.checkable || !isActiveFact(f)) continue;
        if (t - (f.checkable.last_checked ?? 0) < VERIFY_CYCLE_MS) continue;
        let ok = false;
        let result = null;
        try {
          const r = await verify({ surface: matchCheckable(f.statement)?.surface, probe: f.checkable.probe });
          ok = r?.ok === true;
          result = r?.result ?? null;
        } catch {
          ok = false;
          result = "verify error";
        }
        checked += 1;
        working[i] = { ...f, checkable: { ...f.checkable, last_checked: t, result: ok ? "ok" : "failed" } };
        failed.push({ f: working[i], ok });
        if (ok) changed = true;
      }
      for (const { f, ok } of failed) {
        if (ok) continue;
        seq += 1;
        const res = await resolveOne(
          {
            proposalId: `verify:${f.id}:${t}:${seq}`,
            project: proj,
            kind: f.kind,
            statement: f.statement,
            refs: f.refs,
            sender: "cto",
            confidence: Math.max(0.05, (f.confidence ?? 0.5) * 0.4),
            supersedes: f.id,
          },
          working,
        );
        const idxOld = working.findIndex((x) => x.id === f.id);
        if (idxOld >= 0) {
          working[idxOld] = { ...working[idxOld], checkable: { ...(working[idxOld].checkable ?? {}), last_checked: t, result: "failed" } };
        }
        if (!res.reject && res.action === "supersede" && res.facts) {
          const present = await presenceCheck();
          await log({ kind: "cto.fact_verify_supersede", project: proj, fact: f.id, present });
          working = res.facts;
          changed = true;
          superseded += 1;
        }
      }
      if (changed) await saveFacts(proj, working);
    }
    return { checked, superseded };
  }

  async function recomputeHalfLivesNow() {
    const state = await loadState();
    const lifespans = state.factTuning?.lifespans ?? [];
    const updated = recomputeHalfLives(lifespans, { halfLivesPolicy: HALF_LIVES_POLICY });
    if (Object.keys(updated).length === 0) return { updated: null };
    const tuned = { ...(state.factTuning?.halfLives ?? {}), ...updated };
    await saveState({ ...state, factTuning: { lifespans: state.factTuning?.lifespans ?? [], halfLives: tuned } });
    await log({ kind: "cto.halflife_tune", updated });
    return { updated };
  }

  async function getState() {
    const state = await loadState();
    return {
      appliedProposalCount: Object.keys(state.appliedProposals ?? {}).length,
      pendingByProject: Object.fromEntries(
        Object.entries(state.factQueue ?? {}).map(([p, q]) => [p, q.length]),
      ),
      senderReliability: state.factReliability ?? {},
      halfLives: currentHalfLives(state.factTuning ?? {}),
    };
  }

  function dispose() {
    disposed = true;
  }

  return {
    submitProposal,
    pump,
    touchFacts,
    verifyDue,
    recomputeHalfLives: recomputeHalfLivesNow,
    getState,
    listFacts: (project) => loadFacts(project).then((arr) => arr.filter(isActiveFact)),
    listProjects: listKnownProjects,
    dispose,
  };
}

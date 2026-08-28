// src/server/ctoRollups.mjs
// BET-1381 — hour/day/week rollups (spec §5.3). The P1 read-layer that folds
// A6's segment summaries up the three-tier hierarchy: Hour ← that hour's
// segment summaries; Day ← its hours; Week ← its days. Each level reads only
// the level below.
//
// Properties (each honored below and asserted in ctoRollups.test.mjs):
//   - Each reduce is ONE cheap-model call (the `ambient-summarize` class),
//     conditioned on the preceding same-level rollup (the running context) so
//     news is never re-reported.
//   - A reduce runs when its window closes (hour tick for hours; day/week at
//     local-midnight ticks — the engine wires those timers). Quiet windows
//     (zero inputs) write NOTHING.
//   - Rollups are WRITE-ONCE: a rollup file that already exists is never
//     rewritten; attempting a write into an existing window is a programming
//     error and throws.
//   - Reduce batches are preemptible BETWEEN reduce calls: the session runner
//     checks presence between calls and stops the batch after the in-flight
//     call (§5.3 + §3.4 rule 4). Segment-close summaries (the trickle, ctoSegments)
//     are exempt and never pass through this path.
//   - Evidence pointers propagate: every rollup bullet keeps refs to the leaf
//     segment ids it was reduced from (hour refs = segment ids; day/week refs =
//     the union of the level-below's bullet refs).
//
// Pure logic + injected I/O in the style of delegate.mjs / ctoEngine.mjs — no
// live tmux/opencode/network in tests. All model + store + presence seams are
// injected (`runEphemeral`, `rollups`, `loadInputs`, `loadPreceding`, `exists`,
// `presenceCheck`, `factsStore`, `resolveSegment`, `now`).
//
// Fact sync (P1, §5.3 "ADD/UPDATE/NOOP"): after each day-level reduce the
// engine applies a deterministic ADD/UPDATE/NOOP against the project's facts
// store (§6) DIRECTLY from the rollup — single-writer, the engine itself (§15).
// This is deliberately isolated in one exported function, `syncFactsFromRollup`,
// so a later P2 collaborative gatekeeper can delete it cleanly.

import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { rollupsStore, segmentsStore, factsStore, ledgerStore } from "./ctoStores.mjs";

export const ROLLUP_VERSION = 1;
export const ROLLUP_LEVELS = Object.freeze(["hour", "day", "week"]);
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

export const LEVEL_MS = Object.freeze({ hour: HOUR_MS, day: DAY_MS, week: WEEK_MS });

// The next level up (input relation): hour is the leaf over segments.
export const NEXT_LEVEL = Object.freeze({ hour: "day", day: "week", week: null });

export function isRollupLevel(level) {
  return ROLLUP_LEVELS.includes(level);
}

// ---------------------------------------------------------------------------
// Window math (local time — day/week rollups close at local midnight)
// ---------------------------------------------------------------------------

export function startOfHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Start of the local week (Monday).
export function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.getTime();
}

const STARTS = Object.freeze({ hour: startOfHour, day: startOfDay, week: startOfWeek });

export function windowFor(level, ts) {
  assertLevel(level);
  const start = STARTS[level](ts);
  return [start, start + LEVEL_MS[level]];
}

export function windowId(window) {
  return String(window[0]);
}

// The window immediately before `window` at the same level (the running
// context's predecessor).
export function previousWindow(window, level) {
  assertLevel(level);
  return [window[0] - LEVEL_MS[level], window[0]];
}

export function assertLevel(level) {
  if (!isRollupLevel(level)) {
    throw new Error(`rollups level must be one of ${ROLLUP_LEVELS.join(", ")} (got ${JSON.stringify(level)})`);
  }
}

// ---------------------------------------------------------------------------
// Reduce input selection — each level reads only the level below.
// ---------------------------------------------------------------------------
// An item (a segment summary, an hour rollup, a day rollup) is assigned to the
// window that CONTAINS the item's own window start (item.window[0] ∈ [ws,we)),
// which partitions items cleanly across contiguous windows (no double-counting
// at boundaries). Returns the items sorted by start. Pure — `items` are the
// already-loaded inputs, each with a `.window` of [start, end].

export function selectReduceInputs(level, window, items) {
  assertLevel(level);
  const [ws, we] = window;
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && Array.isArray(it.window) && it.window[0] >= ws && it.window[0] < we)
    .sort((a, b) => a.window[0] - b.window[0]);
}

// ---------------------------------------------------------------------------
// Ref propagation — every bullet keeps refs to LEAF segment ids.
// ---------------------------------------------------------------------------
// hour inputs are raw segments (their own id is the leaf ref). day/week inputs
// are rollups whose bullets already carry leaf refs — the rollup-level refs are
// the union of the level-below's bullet refs.

export function collectRefs(level, inputs) {
  if (level === "hour") {
    return Array.from(new Set((inputs || []).map((i) => i && i.id).filter((x) => typeof x === "string"))).sort();
  }
  const refs = new Set();
  for (const input of inputs || []) {
    for (const b of input?.bullets || []) {
      if (Array.isArray(b?.refs)) {
        for (const r of b.refs) if (typeof r === "string") refs.add(r);
      }
    }
  }
  return Array.from(refs).sort();
}

// ---------------------------------------------------------------------------
// Rollup shape + validation
// ---------------------------------------------------------------------------

export function validateRollup(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.v !== ROLLUP_VERSION) return false;
  if (!isRollupLevel(obj.level)) return false;
  if (
    !Array.isArray(obj.window) ||
    obj.window.length !== 2 ||
    typeof obj.window[0] !== "number" ||
    typeof obj.window[1] !== "number" ||
    !(obj.window[1] - obj.window[0] === LEVEL_MS[obj.level])
  ) {
    return false;
  }
  if (!Array.isArray(obj.bullets)) return false;
  return obj.bullets.every(
    (b) =>
      b &&
      typeof b === "object" &&
      typeof b.text === "string" &&
      b.text.length > 0 &&
      (b.refs === undefined || (Array.isArray(b.refs) && b.refs.every((r) => typeof r === "string"))),
  );
}

// Tolerant extractor for the model's JSON rollup — take the first `{` .. last
// `}` (a model may wrap the JSON in prose or fences). Parse-only; schema
// validation is validateRollup's job.
export function parseRollupText(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// The reduced context producer. Assembles the reduce's context blocks in
// priority order under the `ambient-summarize` task class: the instruction
// (high), the level-below content it must fold (medium, with ids so the model
// can attach refs), the preceding same-level rollup as running context
// (medium, so news is never re-reported), and a refs pointer to the leaf
// segment ids being propagated.
export function buildReduceContext({ level, window, inputs, refs, preceding } = {}) {
  const inputLines = (inputs || []).map((it) => {
    if (level === "hour") {
      const s = it?.summary || {};
      return `[${it.id}] ${s.one_liner || s.intent || "segment"}${
        s.project ? ` (project: ${s.project})` : ""
      } — window ${it.window ? `${it.window[0]}..${it.window[1]}` : "?"}`;
    }
    const bullets = (it?.bullets || []).map((b) => `- ${b.text}`).join("\n");
    return `[${it.id}] ${bullets || "(no bullets)"}`;
  });

  const blocks = [];
  blocks.push({
    priority: "high",
    text:
      `You are the Adaptive CTO's ${level}ly rollup summarizer. Reduce the ` +
      `${level} window ${window[0]}..${window[1]} below into a compact bulleted ` +
      `rollup of what got done. Output ONLY JSON of the form ` +
      `{"bullets":[{"text":"<summary sentence>","refs":["<segmentId>",...]}]}. ` +
      `Each bullet's refs must reference the leaf segment id(s) it came from. ` +
      `Report only NEWS not already covered by the running context. Keep bullets ` +
      `concrete and factual.`,
  });
  if (refs && refs.length) {
    blocks.push({
      priority: "medium",
      text: `Leaf segment ids in this ${level}: ${refs.join(", ")}.` +
        (preceding ? "" : " (no preceding same-level rollup exists)"),
    });
  }
  if (inputLines.length) {
    blocks.push({
      priority: "medium",
      text: `The ${level} below (level-below inputs) to fold in:\n${inputLines.join("\n")}`,
    });
  }
  if (preceding && Array.isArray(preceding.bullets) && preceding.bullets.length) {
    blocks.push({
      priority: "medium",
      text:
        `Running context — the preceding same-${level} rollup (already reported, do not re-report):\n` +
        preceding.bullets.map((b) => `- ${b.text}`).join("\n"),
    });
  }
  return blocks;
}

// The degraded fallback used when the model call is gated/unavailable/failed:
// one bullet per level-below input, carrying correct leaf refs, so the
// hierarchy is never silently empty.
export function degradedRollup({ level, window, inputs, refs } = {}) {
  let bullets;
  if (level === "hour") {
    bullets = (inputs || []).map((it) => {
      const s = it?.summary || {};
      return { text: s.one_liner || s.intent || "unspecified work", refs: it.id ? [it.id] : [] };
    });
  } else {
    bullets = [];
    for (const input of inputs || []) {
      for (const b of input?.bullets || []) {
        bullets.push({ text: typeof b?.text === "string" ? b.text : "work", refs: Array.isArray(b.refs) ? b.refs : [] });
      }
    }
    if (!bullets.length) bullets = [{ text: `${level} of ${window[0]}`, refs: refs || [] }];
  }
  return { v: ROLLUP_VERSION, level, window, bullets };
}

// ---------------------------------------------------------------------------
// Fact sync (P1, isolated — see module header). After a day-level reduce the
// engine applies ADD/UPDATE/NOOP against each project's facts store, grouped
// per project by resolving each bullet's refs → segment → project. Deterministic
// and small; a later P2 collaborative gatekeeper replaces this direct path.
// ---------------------------------------------------------------------------

export function normalizeStatement(text) {
  return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function refSignature(refs) {
  return (Array.isArray(refs) ? [...refs] : []).sort().join("|");
}

// Deterministic ADD/UPDATE/NOOP decision against an existing fact list.
//   - NOOP:   an active fact with the same normalized statement already exists.
//   - UPDATE: an active fact from a prior rollup sync shares the same ref
//             signature but a different statement — supersede it, add the new.
//   - ADD:    otherwise (new news).
// Returns { action, existing? }.
export function decideFactAction(existing, statement, refs) {
  const norm = normalizeStatement(statement);
  const sig = refSignature(refs);
  if (!norm) return { action: "noop" };
  for (const f of existing) {
    if (f?.superseded_by || f?.valid_until) continue; // inactive → can't block
    if (normalizeStatement(f?.statement) === norm) return { action: "noop", existing: f };
  }
  for (const f of existing) {
    if (f?.superseded_by || f?.valid_until) continue;
    if (f?.sender?.sessionID === undefined && refSignature(f?.refs) === sig && sig) {
      return { action: "update", existing: f };
    }
  }
  return { action: "add" };
}

// The isolated P1 fact-sync entry point. `dayRollup` is a validated day-level
// rollup; `resolveSegment` maps a segment id to `{ project, ... }` (or null);
// `factsStore` is the per-project facts store ({load(project), save(project,data)}).
// Applies ADD/UPDATE/NOOP per project and returns a tally.
export async function syncFactsFromRollup(dayRollup, { resolveSegment, facts = factsStore, sender = "cto", now = Date.now() } = {}) {
  if (!dayRollup || dayRollup.level !== "day" || !Array.isArray(dayRollup.bullets)) {
    return { applied: 0, added: 0, updated: 0, noop: 0 };
  }
  const byProject = new Map();
  for (const b of dayRollup.bullets) {
    if (!b || typeof b.text !== "string" || !b.text.trim()) continue;
    const refs = Array.isArray(b.refs) ? b.refs.filter((r) => typeof r === "string") : [];
    let project = null;
    for (const ref of refs) {
      try {
        const seg = await resolveSegment(ref);
        if (seg?.project) {
          project = seg.project;
          break;
        }
      } catch {
        /* resolve a single ref fails → try the next */
      }
    }
    if (!project) continue; // can't attribute → skip (never fabricate a project)
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push({ text: b.text, refs });
  }

  const tally = { applied: 0, added: 0, updated: 0, noop: 0 };
  for (const [project, bullets] of byProject) {
    let payload;
    try {
      payload = await facts.load(project);
    } catch {
      payload = { facts: [] };
    }
    const existing = Array.isArray(payload?.facts) ? payload.facts : [];
    const factsOut = [...existing];
    const ts = now();
    for (const b of bullets) {
      const { action, existing: hit } = decideFactAction(existing, b.text, b.refs);
      if (action === "noop") {
        tally.noop += 1;
        if (hit) {
          hit.last_accessed = ts;
          hit.access_count = (hit.access_count || 0) + 1;
        }
        continue;
      }
      if (action === "update" && hit) {
        hit.superseded_by = "cto:" + createHash("sha1").update(b.text).digest("hex").slice(0, 12);
      }
      const fact = {
        v: 1,
        id: "cto:" + createHash("sha1").update(`${project}|${b.text}|${refSignature(b.refs)}`).digest("hex").slice(0, 12),
        kind: "decision",
        statement: b.text.slice(0, 200),
        refs: b.refs,
        confidence: 0.5,
        created: ts,
        last_accessed: ts,
        access_count: 1,
        sender,
      };
      factsOut.push(fact);
      tally.applied += 1;
      if (action === "update") tally.updated += 1;
      else tally.added += 1;
    }
    try {
      await facts.save(project, { facts: factsOut });
    } catch {
      /* facts persistence is best-effort — never throw into the reduce */
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Rollup runner — the pending-reduce executor with write-once + preemption.
// ---------------------------------------------------------------------------
// The engine owns the window-close TIMERS (§5.3) and hands this runner the
// concrete windows whose closes it detected via the tick. The runner does the
// reduces (each one `runEphemeral` call), enforces write-once + quiet-window
// no-op, and preempts the batch between calls when the user is present.
//
// deps:
//   runEphemeral   — async ({taskClass, context}) => {text} — the ← one reduce
//                    call, wrapped by the engine in the §3.3 ephemeral rate gate.
//   rollups        — rollups store {load, save} (default rollupsStore).
//   segments       — segments store (default segmentsStore), used by default
//                    loadInputs/loadPreceding for the hour level.
//   fs             — {readdir, ...} for default dir enumeration (default fsp).
//   loadInputs     — async ({level, window, now}) => inputs (injectable; default
//                    enumerates the level-below files from the stores).
//   loadPreceding  — async ({level, window}) => preceding same-level rollup|null.
//   exists         — async ({level, id}) => bool — write-once detector. Default
//                    true iff a stored payload already carries `bullets`.
//   presenceCheck  — async () => bool — true when the user is present; the batch
//                    stops after the in-flight reduce call.
//   facts, resolveSegment — for day-level fact sync (default factsStore + a
//                    segments-store-backed resolver when `segments` provided).
//   now            — () => epoch ms.
//   ledger         — A1 ledger {append} (best-effort).

export async function defaultLoadPreceding({ level, window, rollups } = {}) {
  try {
    const p = await rollups.load(level, windowId(previousWindow(window, level)));
    if (p && typeof p === "object" && "bullets" in p) return p;
    return null;
  } catch {
    return null;
  }
}

export function defaultExists({ rollups } = {}) {
  return async ({ level, id } = {}) => {
    try {
      const p = await rollups.load(level, id);
      return p && typeof p === "object" && "bullets" in p;
    } catch {
      return false;
    }
  };
}

// Enumerate the level-below inputs for a window from the real stores.
export function defaultLoadInputs({ fs = fsp, rollups = rollupsStore, segments = segmentsStore } = {}) {
  return async ({ level, window } = {}) => {
    assertLevel(level);
    const [ws, we] = window;
    if (level === "hour") {
      const dir = segments.dir;
      let names = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        return [];
      }
      const out = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        let seg;
        try {
          seg = await segments.load(id);
        } catch {
          continue;
        }
        if (seg && Array.isArray(seg.window) && seg.window[0] >= ws && seg.window[0] < we) {
          out.push({ id, window: seg.window, ts: seg.ts, summary: seg.summary });
        }
      }
      return out.sort((a, b) => a.window[0] - b.window[0]);
    }
    const belowLevel = level === "day" ? "hour" : "day";
    const dir = rollups.dirFor(belowLevel);
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      let r;
      try {
        r = await rollups.load(belowLevel, id);
      } catch {
        continue;
      }
      if (r && Array.isArray(r.window) && r.window[0] >= ws && r.window[0] < we) {
        out.push({ id, window: r.window, bullets: Array.isArray(r.bullets) ? r.bullets : [] });
      }
    }
    return out.sort((a, b) => a.window[0] - b.window[0]);
  };
}

export function createRollupRunner(deps = {}) {
  const {
    runEphemeral = async () => ({ ok: false, gated: true }),
    rollups = rollupsStore,
    segments = segmentsStore,
    fs = fsp,
    loadInputs,
    loadPreceding,
    exists,
    presenceCheck = async () => false,
    facts = factsStore,
    resolveSegment,
    now = () => Date.now(),
    ledger = ledgerStore,
  } = deps;

  const loadInputsFn = loadInputs ?? defaultLoadInputs({ fs, rollups, segments });
  const loadPrecedingFn =
    loadPreceding ?? (({ level, window }) => defaultLoadPreceding({ level, window, rollups }));
  const existsFn = exists ?? defaultExists({ rollups });

  const defaultResolveSegment = async (id) => {
    try {
      const s = await segments.load(id);
      return s && s.project ? { project: s.project } : null;
    } catch {
      return null;
    }
  };
  const resolveSegmentFn = resolveSegment ?? defaultResolveSegment;

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: "cto", ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  // Reduce ONE window: choose the level-below inputs, thread the running
  // context, make ONE cheap-model call (degrading on gated/failure), write the
  // rollup once, and sync facts after a day-level reduce. Never throws into a
  // poller; a write-once violation DOES throw (programming error per §5.3).
  async function reduceWindow(level, window) {
    assertLevel(level);
    const id = windowId(window);
    const inputs = await loadInputsFn({ level, window, now: now() });
    // Quiet window (zero level-below inputs) → write NOTHING (absence is free).
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return { skipped: true, level, window, id };
    }
    // Write-once: a rollup that already exists is never rewritten.
    if (await existsFn({ level, id })) {
      throw new Error(`rollup ${level}/${id} already exists (write-once — refusing to rewrite)`);
    }
    const refs = collectRefs(level, inputs);
    const preceding = await loadPrecedingFn({ level, window });
    const context = buildReduceContext({ level, window, inputs, refs, preceding });

    let rollup = null;
    try {
      const res = await runEphemeral({ taskClass: "ambient-summarize", context });
      const parsed = parseRollupText(res?.text);
      if (res?.ok && parsed && validateRollup({ ...parsed, v: ROLLUP_VERSION, level, window })) {
        rollup = { ...parsed, v: ROLLUP_VERSION, level, window };
      }
    } catch {
      rollup = null;
    }
    if (!rollup) {
      rollup = degradedRollup({ level, window, inputs, refs });
      await ledgerLog({ kind: "cto.rollup_degraded", level, id });
    }
    await rollups.save(level, id, rollup);
    await ledgerLog({ kind: "cto.rollup_written", level, id, bullets: rollup.bullets.length });

    let factTally = null;
    if (level === "day") {
      factTally = await syncFactsFromRollup(rollup, {
        resolveSegment: resolveSegmentFn,
        facts,
        now,
      }).catch(() => null);
      if (factTally) await ledgerLog({ kind: "cto.facts_synced", id, ...factTally });
    }
    return { saved: true, level, window, id, factTally };
  }

  // Run a batch of pending reduces with preemption BETWEEN calls: after each
  // reduce, if the user is present we stop the batch (§5.3 checkpoint). Also
  // won't start a further call if present from the start. Returns outcomes.
  async function processDue(pending) {
    const outcomes = [];
    for (const item of pending || []) {
      if (await presenceCheck()) break;
      const [level, window] = Array.isArray(item) ? item : [item.level, item.window];
      outcomes.push(await reduceWindow(level, window));
    }
    return outcomes;
  }

  return {
    reduceWindow,
    processDue,
    // exposed for tests / diagnostics
    _loadInputs: loadInputsFn,
    _loadPreceding: loadPrecedingFn,
  };
}

// ctoToolRegistry.mjs — §7.2 registry + fusion + lifecycle + connect asks
// (BET-1395) + the §7.3 vitality / §7.6 relevance axes (BET-1396).
//
// The registry fuses the four §7.1 evidence channels into ONE row per tool
// identity ("one identity, one row"), derives engagement, runs the two
// lifecycle bars, and raises §7.4 connect asks as needs-you decision cards:
//
//   observed (evidence accumulates) → candidate (either axis crosses its bar:
//     engagement ≥3 uses across ≥2 weeks; OR the vitality path — a credential
//     exists at all) → ONE connect ask (Connect read-only / Not now / Never)
//     → integrated (the FIRST successful §7.5 probe run flips it here;
//     applyProbeResult does the flip).
//
// Raw evidence (unknown CLIs/hosts/keys) is classified by the LLM fallback at
// most ONCE per identity — the model's judgment is cached in the registry
// entry and never re-asked (§7.1-4). Near-duplicates fold: a host that is a
// subdomain of an already-known identity's domain is not a new tool; git
// remotes are collected at host granularity so slug-covered hosts never
// become rows in the first place (§7.3 near-duplicate suppression).
//
// All I/O is injected; pure helpers are exported for tests.

import { toolRegistryStore, toolUsageStore, ledgerStore } from "./ctoStores.mjs";
import { displayName as catalogDisplayName } from "./ctoToolCatalog.mjs";
import {
  CHANNEL_TRANSCRIPT,
  CHANNEL_CONFIG,
  extractFromDbRows,
  collectConfigEvidence,
  SCAN_ROW_CAP,
} from "./ctoToolScan.mjs";
// One-way dep (ctoProbes never imports this module): the §7.2 well-known
// vitality pair {last_event, inflow_rate} pulled from a probe's extract map.
import { vitalityOf, CADENCE_WEEKLY_MS } from "./ctoProbes.mjs";
import { betaLowerBound } from "./ctoVerdicts.mjs";

export const TOOL_REGISTRY_VERSION = 1;

// The raw store payload → the working registry shape (the writers' shared
// normalization, BET-1440's single source): rows persisted before the
// deep-read/decay fields existed are back-filled so every consumer sees the
// fields at their §7.2-schema defaults (spread order: stored row wins). Pure.
function payloadFrom(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    v: TOOL_REGISTRY_VERSION,
    tools: (Array.isArray(p?.tools) ? p.tools : []).map((t) => ({
      deepAskRound: 0,
      deepAskAtUses: 0,
      deepReArmAt: null,
      deepAskBarMet: false,
      lastDeepAskDay: null,
      asSourceDecayed: false,
      decayedAtUses: 0,
      ...(t ?? {}),
    })),
    lastScanTs: Number.isFinite(p?.lastScanTs) ? p.lastScanTs : null,
    lastFusedTs: Number.isFinite(p?.lastFusedTs) ? p.lastFusedTs : null,
    lastAskDay: typeof p?.lastAskDay === "string" ? p.lastAskDay : null,
    lastDeepAskDay: typeof p?.lastDeepAskDay === "string" ? p.lastDeepAskDay : null,
  };
}
export const ACTOR = "cto";

// Evidence-log cap (all channels) — the usage log is a bounded FIFO.
export const USAGE_ROWS_CAP = 4000;
// Per-tool evidence trail cap (§7.2 `evidence: [{channel, detail, ts}]`).
export const EVIDENCE_CAP = 20;
// Raw evidence must appear this many times before ONE LLM classification is
// spent on it (junk singletons are never classified).
export const RAW_CLASSIFY_MIN_USES = 2;
// The engagement bar (§7.4): ≥3 uses across ≥2 distinct weeks.
export const ENGAGEMENT_MIN_USES = 3;
export const ENGAGEMENT_MIN_WEEKS = 2;
// "Not now" re-arms after 30 days (§7.4 ring semantics).
export const NOT_NOW_REARM_MS = 30 * 24 * 3_600_000;
// Max connect asks per tool (§7.4: askRound < 3).
export const MAX_ASK_ROUNDS = 3;
// A fresh bar crossing re-arms a declined ask early: this many uses beyond
// the snapshot taken at ask time counts as fresh engagement (§7.4
// "a fresh axis-bar crossing"; the vitality path's bar cannot re-cross, so
// for credentials only the 30-day timer re-arms).
export const REARM_FRESH_USES = 2;
// Deep-read ask bar (spec §7.6 + BET-1404 on-call decision): max relevance
// ≥ 0.5. The vitality half of the bar is `ewma > 0` — the only vitality
// threshold precedent in shipped code (the daily-cadence regime,
// `effectiveCadenceMs`); selectivity belongs to the relevance half.
export const DEEP_RELEVANCE_MIN = 0.5;
// Dismissal decay chain (spec §7.6): trip when the as_source Beta lower bound
// drops below 0.3 after ≥3 reports (§9.4's 0.95 tail convention). "Then
// dormant" is the §7.3 dead condition under the standard lifecycle — no
// second dormancy definition lives here.
export const AS_SOURCE_MIN_REPORTS = 3;
export const AS_SOURCE_DECAY_LOWER_BOUND = 0.3;
// The classification task class (§12.1 — cheapest nano tier).
export const TOOL_CLASSIFY_TASK_CLASS = "ambient-summarize";

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
const EWMA_TAU_DAYS = 7; // engagement EWMA decay constant (1-week τ)

export function emptyConsent() {
  return { metadata: null, deep_read: null, write: null };
}

export function emptyVitality() {
  return { last_event: null, inflow_rate: null, ewma: null, last_probed: null };
}

// ISO week bucket (year-Www) — the ≥2-weeks engagement bar's unit.
export function weekKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = (new Date(utc).getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(utc - day * DAY_MS);
  const jan1 = Date.UTC(monday.getUTCFullYear(), 0, 1);
  const week = Math.floor((monday.getTime() - jan1) / (7 * DAY_MS)) + 1;
  return `${monday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function humanize(identity) {
  return catalogDisplayName(identity);
}

// §7.2 schema (verbatim axes) + the lifecycle bookkeeping the engine needs
// on top: engagement/vitality are the spec'd axes; uses/weeksActive/weeks are
// derived counters (the bar's inputs); askRound/askAtUses/reArmAt/
// unneverAtUses drive the §7.4 ask gate.
function baseTool(identity, ts) {
  return {
    tool: identity,
    displayName: humanize(identity),
    source: "catalog",
    raw: false,
    unclassifiable: false,
    firstSeenTs: ts,
    // §7.2 engagement axis.
    engagement: { ewma_per_week: 0, last_used: ts, per_project: {} },
    // §7.2 vitality axis — §7.5 probes are the only writer; empty until then.
    vitality: { last_event: null, inflow_rate: null, ewma: null, last_probed: null },
    ewmaAt: ts, // EWMA decay watermark (internal, single-application)
    uses: 0,
    weeksActive: 0,
    weeks: [],
    evidence: [],
    status: "observed",
    role: null, // §7.3 quadrants need vitality probes (§7.5) — derived later
    consent: emptyConsent(),
    askRound: 0,
    askAtUses: 0,
    reArmAt: null,
    unneverAtUses: null,
    // Deep-read ring ask bookkeeping (§7.4 ring semantics apply per ask).
    deepAskRound: 0,
    deepAskAtUses: 0,
    deepReArmAt: null,
    deepAskBarMet: false, // the deep bar's met-state snapshot at ask time
    lastDeepAskDay: null,
    // Dismissal decay chain (§7.6): the as_source trip's persisted state.
    asSourceDecayed: false,
    decayedAtUses: 0,
    llmAt: null,
    relevance: {}, // §7.6 blackboard match — refreshed weekly (later issue)
    as_source: { reports: 0, accepted: 0 }, // §7.2 counters — fed by §9.5 later
    as_workflow: { suggestions: 0, accepted: 0 },
  };
}

// Engagement EWMA decay applied lazily (single application via the `ewmaAt`
// watermark): `ewma *= exp(-Δdays/τ)`.
export function decayEwma(tool, nowMs) {
  const from = tool?.ewmaAt ?? tool?.engagement?.last_used ?? nowMs;
  const deltaDays = (nowMs - from) / DAY_MS;
  if (!(deltaDays > 0)) return tool?.engagement?.ewma_per_week ?? 0;
  return (tool?.engagement?.ewma_per_week ?? 0) * Math.exp(-deltaDays / EWMA_TAU_DAYS);
}

export function hasCredential(tool) {
  return (tool?.evidence ?? []).some((e) => e?.channel === "secret");
}

// The engagement bar (§7.4).
export function engagementBarMet(tool) {
  return (tool?.uses ?? 0) >= ENGAGEMENT_MIN_USES && (tool?.weeksActive ?? 0) >= ENGAGEMENT_MIN_WEEKS;
}

// §7.3 quadrant role (D13), derived at read time for the §10.5 row-4 drill-
// down — "high engagement" = the engagement bar (§7.4), "high vitality" = a
// live inflow (EWMA > 0) or a recent probe-reported event. Low on both axes
// WITH prior engagement is the dead-tool candidate the drill-down flags.
// Display-only: the stored `role` field stays the registry's own (null until
// a later issue writes it).
export const VITALITY_RECENT_MS = 14 * DAY_MS;

export function deriveRole(tool, { nowMs = Date.now() } = {}) {
  const engHigh = engagementBarMet(tool);
  const vit = tool?.vitality ?? {};
  const ewmaLive = (typeof vit.ewma === "number" && vit.ewma > 0) || (typeof vit.inflow_rate === "number" && vit.inflow_rate > 0);
  const recentEvent =
    typeof vit.last_event === "number" && typeof nowMs === "number" && nowMs - vit.last_event < VITALITY_RECENT_MS;
  const vitHigh = ewmaLive || recentEvent;
  if (engHigh && vitHigh) return "both";
  if (engHigh) return "workflow";
  if (vitHigh) return "data-source";
  if ((tool?.uses ?? 0) > 0) return "dead";
  return null;
}

// Either axis crossed its bar (§7.4 observed → candidate).
export function barCrossed(tool) {
  return engagementBarMet(tool) || hasCredential(tool);
}

// The deep-read ask bar (§7.6): a tool with metadata consent whose vitality ×
// relevance clears the bar — vitality EWMA high (`ewma > 0`, the daily-cadence
// regime; BET-1404 on-call decision) AND max relevance ≥ 0.5. Returns the
// bar's state plus the argmax-relevance project (what the ask's concrete
// intent names). `met` implies metadata consent; the deep ask adds its own
// consent gates on top.
export function deepReadBar(tool) {
  const consent = tool?.consent ?? {};
  if (consent.metadata !== "yes") return { met: false, project: null, relevance: 0 };
  const ewma = tool?.vitality?.ewma;
  if (!(typeof ewma === "number" && ewma > 0)) return { met: false, project: null, relevance: 0 };
  let project = null;
  let best = 0;
  for (const [p, r] of Object.entries(tool?.relevance ?? {})) {
    const s = Number(r);
    if (Number.isFinite(s) && s > best) {
      best = s;
      project = p;
    }
  }
  if (project === null || !(best >= DEEP_RELEVANCE_MIN)) {
    return { met: false, project, relevance: best };
  }
  return { met: true, project, relevance: best };
}

// Near-duplicate suppression (§7.3): a host that is a subdomain of an
// already-known tool's domain evidence folds into that tool. Git remotes are
// recorded host-only (no per-slug rows), so slug-covered hosts never become
// new rows in the first place.
export function findHostParent(tools, host) {
  const h = String(host ?? "").toLowerCase();
  if (!h || !h.includes(".")) return null;
  for (const t of tools) {
    for (const e of t?.evidence ?? []) {
      const d = typeof e?.detail === "string" ? e.detail : "";
      if (!d.startsWith("domain:")) continue;
      const known = d.slice("domain:".length).toLowerCase();
      if (known && (h === known || h.endsWith(`.${known}`))) return t;
    }
  }
  return null;
}

// Raw evidence without a catalog identity still becomes a registry entry,
// keyed by the raw token itself — that is what the LLM fallback classifies
// (at most once). Webhook/schedule labels are free text, not tool tokens:
// they stay log-only evidence.
const RAW_HOST_PREFIX = /^(?:www|api|app|mcp|hooks|gateway)\./;

function rawIdentityFromDetail(detail) {
  if (detail.startsWith("cli:")) return detail.slice(4);
  if (detail.startsWith("domain:")) return detail.slice(7).replace(RAW_HOST_PREFIX, "");
  if (detail.startsWith("mcp:")) return detail.slice(4);
  if (detail.startsWith("secret:")) return detail.slice(7).toLowerCase();
  if (detail.startsWith("key:")) return "issue-tracker";
  return null;
}

// ---------------------------------------------------------------------------
// Fusion: one evidence row → the registry (pure; returns a NEW array)
// ---------------------------------------------------------------------------

export function fuseRow(tools, row, { nowMs } = {}) {
  const arr = Array.isArray(tools) ? [...tools] : [];
  if (!row || typeof row !== "object") return arr;
  const ts = Number(row.ts) || nowMs;
  const project = typeof row.project === "string" && row.project ? row.project : null;
  const detail = typeof row.detail === "string" ? row.detail : "";
  const channel = typeof row.channel === "string" ? row.channel : "unknown";

  let host = null;
  if (detail.startsWith("domain:")) host = detail.slice("domain:".length);
  if (detail.startsWith("git:")) host = detail.slice("git:".length);
  // Near-dup: a raw (identity-less) host row folds into the tool that already
  // covers its parent domain. Catalog-matched rows already share the identity.
  if (row.identity == null && host) {
    const parent = findHostParent(arr, host);
    if (parent) row = { ...row, identity: parent.tool };
  }

  if (row.identity == null) {
    // Unclassified raw evidence → a raw registry entry keyed by the token
    // itself, for the one-shot LLM classification (§7.1-4). Labels stay
    // log-only.
    const rawIdentity = rawIdentityFromDetail(detail);
    if (rawIdentity) row = { ...row, identity: rawIdentity, source: "raw" };
  }

  const identity = typeof row.identity === "string" && row.identity ? row.identity.toLowerCase() : null;
  if (!identity) return arr; // no derivable identity — log-only evidence

  let tool = arr.find((t) => t?.tool === identity);
  if (!tool) {
    tool = baseTool(identity, ts);
    tool.raw = row.source === "raw";
    tool.source = tool.raw ? "raw" : "catalog";
    arr.push(tool);
  }
  const prevEwmaAt = tool.ewmaAt ?? tool.engagement?.last_used ?? ts;
  const deltaDays = Math.max(0, ts - prevEwmaAt) / DAY_MS;
  tool.engagement = tool.engagement ?? { ewma_per_week: 0, last_used: ts, per_project: {} };
  tool.engagement.ewma_per_week = (tool.engagement.ewma_per_week ?? 0) * Math.exp(-deltaDays / EWMA_TAU_DAYS) + 1;
  tool.engagement.last_used = Math.max(tool.engagement.last_used ?? ts, ts);
  tool.ewmaAt = Math.max(prevEwmaAt, ts);
  tool.uses += 1;
  if (project) tool.engagement.per_project[project] = (tool.engagement.per_project[project] ?? 0) + 1;
  const wk = weekKey(ts);
  if (wk && !tool.weeks.includes(wk)) {
    tool.weeks.push(wk);
    if (tool.weeks.length > 120) tool.weeks.splice(0, tool.weeks.length - 120);
  }
  tool.weeksActive = tool.weeks.length;
  if (detail) {
    const exists = tool.evidence.some((e) => e?.channel === channel && e?.detail === detail);
    if (!exists) {
      tool.evidence.push({ channel, detail, ts });
      if (tool.evidence.length > EVIDENCE_CAP) tool.evidence.splice(0, tool.evidence.length - EVIDENCE_CAP);
    }
  }
  return arr;
}

// ---------------------------------------------------------------------------
// LLM fallback (§7.1-4): classify an unrecognized identity at most once.
// ---------------------------------------------------------------------------

function rawEvidenceLines(tool, cap = 6) {
  return (tool?.evidence ?? [])
    .slice(0, cap)
    .map((e) => `${e?.channel ?? "?"}: ${e?.detail ?? ""}`.trim())
    .filter(Boolean);
}

// Returns a canonical kebab-case identity, or null (unclassifiable).
export function parseClassification(text) {
  const first = String(text ?? "").split("\n")[0]?.trim().toLowerCase() ?? "";
  if (!first || first.startsWith("unknown") || first === "n/a") return null;
  return /^[a-z0-9][a-z0-9_-]{1,40}$/.test(first) ? first : null;
}

// ---------------------------------------------------------------------------
// The registry engine
// ---------------------------------------------------------------------------

export function createToolRegistry(deps = {}) {
  const {
    registryStore = toolRegistryStore,
    usageStore = toolUsageStore,
    cards = null, // { upsertConnect, resolveConnectCards, listOpen }
    ledger = ledgerStore,
    recordVerdict = null, // async ({subject, verdict, never?}) => {ok}
    runEphemeral = null, // async ({taskClass, context}) => {text}
    now = () => Date.now(),
    // I/O seams for the daily scan (index.mjs supplies the live ones).
    collectDb = null, // async ({sinceTs, untilTs, cap}) => db part rows
    collectSurfaces = null, // async () => {config, forgeRepos, webhooks, gitRemotes, schedules}
    backfillStartInstant = null, // first-scan lower bound (the backfill range)
    // BET-1396 §7.5: async (toolId, {secret}) — the probe runner's
    // scaffoldSpec; called at consent time so the ENGINE authors the tool's
    // probe-spec template (AI-authored content goes through the runner's
    // validated writeSpec; no other writer touches probes/<tool>.yaml).
    scaffoldProbes = null,
  } = deps;

  // BET-1464 defect 3: every tool-registry.json write routes through
  // patchStore — the read-fresh-merge-save runs under the registry store's
  // own mutex, keyed by the store path. This replaces the old per-instance
  // write chain (`serialized`) with the ONE shared discipline every CTO
  // store writer uses: a writer whose body awaits (the scan's db batch, the
  // LLM classification, the consent-time probe scaffold) holds the mutex
  // across the whole body, so a connect answer landing mid-scan can no
  // longer be silently overwritten by the scan's stale save — the user's
  // explicit "never" reverting (the same snapshot-spreading-writer class
  // BET-1425 fixed for engine-state). Mutators receive the RAW store payload
  // and normalize via payloadFrom; returning an empty patch means "no
  // change, no save" (the early-exit error paths rely on that).
  function patchRegistry(mutate) {
    return patchStore(registryStore, async (fresh) => mutate(payloadFrom(fresh)));
  }

  async function loadPayload() {
    try {
      return payloadFrom(await registryStore.load());
    } catch {
      return { v: TOOL_REGISTRY_VERSION, tools: [], lastScanTs: null, lastFusedTs: null, lastAskDay: null, lastDeepAskDay: null };
    }
  }

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: ACTOR, ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  // Append evidence rows to the bounded usage log (all channels funnel here —
  // the §7.1 log). Returns the number of rows appended. The usage log is its
  // own file, so its patch mutex is the usage store's own (BET-1464 defect 3
  // — two concurrent channels could previously drop each other's rows).
  async function appendUsage(rows) {
    if (!rows.length) return 0;
    await patchStore(usageStore, (fresh) => {
      const payload = fresh && typeof fresh === "object" ? fresh : {};
      const prev = Array.isArray(payload.rows) ? payload.rows : [];
      return { rows: [...prev, ...rows].slice(-USAGE_ROWS_CAP) };
    });
    return rows.length;
  }

  // Fuse every usage row past the watermark into the registry (mutates the
  // given payload; not saved).
  async function fusePending(payload) {
    const log = (await usageStore.load().catch(() => ({}))) ?? {};
    const rows = Array.isArray(log.rows) ? log.rows : [];
    const watermark = payload.lastFusedTs ?? 0;
    let maxTs = payload.lastFusedTs ?? 0;
    let tools = payload.tools;
    for (const r of rows) {
      const ts = Number(r?.ts) || 0;
      if (ts <= watermark) continue;
      tools = fuseRow(tools, r, { nowMs: now() });
      maxTs = Math.max(maxTs, ts);
    }
    payload.tools = tools;
    payload.lastFusedTs = maxTs || payload.lastFusedTs;
    return payload;
  }

  // One LLM classification (≤1 per scan): the oldest raw identity past the
  // uses threshold. Never re-asks a classified or unclassifiable identity.
  async function classifyOneRaw(payload) {
    if (typeof runEphemeral !== "function") return payload;
    const target = payload.tools
      .filter((t) => t?.raw && !t?.unclassifiable && t?.llmAt == null && (t?.uses ?? 0) >= RAW_CLASSIFY_MIN_USES)
      .sort((a, b) => (a?.firstSeenTs ?? 0) - (b?.firstSeenTs ?? 0))[0];
    if (!target) return payload;
    const context = [
      {
        priority: 1,
        text: [
          "Classify the external tool behind this observed agent evidence into ONE canonical tool identity.",
          `Identity token: ${target.tool}`,
          "Evidence:",
          ...rawEvidenceLines(target).map((l) => `- ${l}`),
          'Reply with exactly one line: a kebab-case tool id (e.g. "github", "stripe") or the word "unknown" if it is not an external tool.',
        ].join("\n"),
      },
    ];
    target.llmAt = now();
    try {
      const res = await runEphemeral({ taskClass: TOOL_CLASSIFY_TASK_CLASS, context });
      const canonical = parseClassification(res?.text);
      if (!canonical) {
        // Unclassifiable — cached; this identity is never re-asked (§7.1-4).
        target.unclassifiable = true;
        return payload;
      }
      if (canonical === target.tool) {
        target.raw = false;
        target.source = "llm";
        target.displayName = humanize(canonical);
        return payload;
      }
      // Merge the raw entry into the canonical identity (or create it).
      let canon = payload.tools.find((t) => t?.tool === canonical);
      if (!canon) {
        canon = baseTool(canonical, target.firstSeenTs);
        canon.source = "llm";
        payload.tools.push(canon);
      }
      canon.uses += target.uses;
      canon.engagement.last_used = Math.max(canon.engagement?.last_used ?? 0, target.engagement?.last_used ?? 0);
      canon.firstSeenTs = Math.min(canon.firstSeenTs ?? Infinity, target.firstSeenTs ?? Infinity);
      canon.engagement.ewma_per_week = (canon.engagement?.ewma_per_week ?? 0) + (target.engagement?.ewma_per_week ?? 0);
      for (const [p, n] of Object.entries(target.engagement?.per_project ?? {})) {
        canon.engagement.per_project[p] = (canon.engagement.per_project[p] ?? 0) + n;
      }
      for (const wk of target.weeks ?? []) {
        if (!canon.weeks.includes(wk)) canon.weeks.push(wk);
      }
      canon.weeksActive = canon.weeks.length;
      for (const e of target.evidence ?? []) {
        if (!canon.evidence.some((x) => x?.channel === e?.channel && x?.detail === e?.detail)) {
          canon.evidence.push(e);
        }
      }
      canon.evidence = canon.evidence.slice(-EVIDENCE_CAP);
      canon.llmAt = target.llmAt;
      payload.tools = payload.tools.filter((t) => t !== target);
      return payload;
    } catch {
      // The call failed after being spent — cache "unclassifiable" (§7.1-4:
      // at most once, never re-asked for the same identity).
      target.unclassifiable = true;
      return payload;
    }
  }

  // Lifecycle (§7.3/§7.4): EWMA decay, observed→candidate promotion, and at
  // most one new connect ask per day. Returns `{changed, asked}`.
  async function lifecycleStep(payload) {
    const nowMs = now();
    let changed = false;
    let asked = null;

    // Decay every tool's engagement EWMA to now (single lazy application).
    for (const t of payload.tools) {
      const deltaDays = (nowMs - (t?.ewmaAt ?? t?.engagement?.last_used ?? nowMs)) / DAY_MS;
      if (deltaDays > 0) {
        t.engagement.ewma_per_week = (t?.engagement?.ewma_per_week ?? 0) * Math.exp(-deltaDays / EWMA_TAU_DAYS);
        t.ewmaAt = nowMs;
        changed = true;
      }
    }

    // §7.6 decay-chain revival (§7.3/B7): renewed engagement re-promotes a
    // tripped tool — fresh uses beyond the trip's snapshot clear the flag
    // (deep analyses + candidate generation resume) and the deep-read ask
    // re-arms on the §7.4 30-day timer. No second dormancy definition: the
    // standard lifecycle owns everything downstream (Q2 decision).
    for (const t of payload.tools) {
      if (t?.asSourceDecayed !== true) continue;
      if ((t?.uses ?? 0) > (t?.decayedAtUses ?? 0) + REARM_FRESH_USES) {
        t.asSourceDecayed = false;
        t.decayedAtUses = 0;
        t.deepReArmAt = nowMs + NOT_NOW_REARM_MS;
        changed = true;
        await ledgerLog({ kind: "cto.tool.as_source_revived", tool: t.tool, uses: t.uses ?? 0 });
      }
    }

    // Promote observed → candidate when either axis crosses its bar. After an
    // un-never (§7.4: "returns the tool to observed; a new ask still requires
    // a fresh bar crossing") the promotion needs NEW engagement beyond the
    // un-never snapshot — barCrossed is monotone in uses, so without the
    // snapshot a just-un-never'd tool would instantly re-promote and re-ask.
    for (const t of payload.tools) {
      if (t?.status !== "observed" || !barCrossed(t)) continue;
      if (t.unneverAtUses != null && (t?.uses ?? 0) <= t.unneverAtUses + REARM_FRESH_USES) continue;
      t.unneverAtUses = null;
      t.status = "candidate";
      changed = true;
      await ledgerLog({ kind: "cto.tool.candidate", tool: t.tool, uses: t.uses, weeksActive: t.weeksActive });
    }

    // Connect-ask gate (§7.4): candidate + no consent yet + askRound < 3 +
    // re-armed + no open connect card + ≤1 new ask/day.
    if (cards && typeof cards.upsertConnect === "function") {
      let open = [];
      try {
        open = (typeof cards.listOpen === "function" ? await cards.listOpen() : []) ?? [];
      } catch {
        open = [];
      }
      const openConnectTools = new Set(
        open.flatMap((c) => (c?.variant === "connect" && Array.isArray(c?.refs) ? c.refs : [])),
      );
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const eligible = payload.tools
        .filter((t) => {
          if (t?.status !== "candidate") return false;
          const consent = t?.consent ?? {};
          if (consent.metadata === "yes" || consent.metadata === "never") return false;
          if ((t?.askRound ?? 0) >= MAX_ASK_ROUNDS) return false;
          if (consent.metadata === "no") {
            // §7.4 re-arm semantics: 30 days, or a fresh axis-bar crossing —
            // BUT the fresh-crossing path exists only on the engagement axis
            // (a credential-exists bar cannot re-cross, so on the vitality
            // path the 30-day timer is the only re-arm).
            const fresh = engagementBarMet(t) && (t?.uses ?? 0) > (t?.askAtUses ?? 0) + REARM_FRESH_USES;
            const timer = t?.reArmAt != null && nowMs >= t.reArmAt;
            if (!timer && !fresh) return false;
          }
          if (openConnectTools.has(t.tool)) return false;
          return barCrossed(t);
        })
        .sort((a, b) => (b?.uses ?? 0) - (a?.uses ?? 0));

      if (eligible.length && payload.lastAskDay !== today) {
        const t = eligible[0];
        if (t.consent?.metadata === "no") t.consent.metadata = null; // re-armed
        const ev = (t?.evidence ?? []).slice(-4).map((e) => `${e?.channel}: ${e?.detail}`);
        const why = [
          `${t.displayName ?? t.tool} showed up ${t.uses}× across ${t.weeksActive} week(s) of agent work`,
          hasCredential(t) ? "and a credential for it exists on this box" : "",
          "— grant read-only metadata access so the CTO can keep it in its model, or decline.",
        ]
          .filter(Boolean)
          .join(" ");
        await cards.upsertConnect({
          toolId: t.tool,
          title: `Connect ${t.displayName ?? t.tool} (read-only)?`,
          body: why,
          evidence: ev,
          refs: [t.tool],
          ts: nowMs,
        });
        t.askRound = (t.askRound ?? 0) + 1;
        t.askAtUses = t.uses ?? 0;
        t.reArmAt = null;
        payload.lastAskDay = today;
        asked = t.tool;
        changed = true;
        await ledgerLog({ kind: "cto.tool.ask", tool: t.tool, askRound: t.askRound });
      }

      // Deep-read ask (§7.6, BET-1404): one ring up from metadata — for an
      // integrated tool whose metadata consent exists but deep_read hasn't
      // been asked (or was declined and re-armed), whose vitality × relevance
      // clears the bar. The ask states the concrete intent (analyze <tool>'s
      // data about <project> overnight and report findings). Ring semantics
      // per §7.4: never/not-now rules identical (30-day timer re-arm only —
      // the bar's vitality half cannot re-cross); ≤1 new ask/day; never for
      // a chain-tripped tool (the cascade stopped deep analyses).
      const deepEligible = payload.tools
        .filter((t) => {
          if (t?.status !== "integrated" || t?.asSourceDecayed === true) return false;
          const consent = t?.consent ?? {};
          if (consent.metadata !== "yes") return false;
          if (consent.deep_read === "yes" || consent.deep_read === "never") return false;
          if ((t?.deepAskRound ?? 0) >= MAX_ASK_ROUNDS) return false;
          if (consent.deep_read === "no") {
            // Vitality-path rule: the 30-day timer is the only re-arm.
            if (!(t?.deepReArmAt != null && nowMs >= t.deepReArmAt)) return false;
          }
          if (openConnectTools.has(t.tool)) return false;
          return deepReadBar(t).met;
        })
        .sort((a, b) => (b?.uses ?? 0) - (a?.uses ?? 0));

      if (deepEligible.length && payload.lastDeepAskDay !== today) {
        const t = deepEligible[0];
        if (t.consent?.deep_read === "no") t.consent.deep_read = null; // re-armed
        const bar = deepReadBar(t);
        const name = t.displayName ?? t.tool;
        const ev = (t?.evidence ?? []).slice(-4).map((e) => `${e?.channel}: ${e?.detail}`);
        await cards.upsertConnect({
          toolId: t.tool,
          ring: "deep_read",
          title: `Let the CTO analyze ${name}'s data?`,
          body: `The CTO would analyze ${name}'s data about ${bar.project} overnight and report findings — one read-only pass beyond metadata. Reports can be dismissed, and ignored reports wind the analyses down.`,
          evidence: ev,
          refs: [t.tool],
          ts: nowMs,
        });
        t.deepAskRound = (t.deepAskRound ?? 0) + 1;
        t.deepAskAtUses = t.uses ?? 0;
        t.deepReArmAt = null;
        t.deepAskBarMet = bar.met;
        payload.lastDeepAskDay = today;
        changed = true;
        await ledgerLog({ kind: "cto.tool.deep_ask", tool: t.tool, project: bar.project, askRound: t.deepAskRound });
      }
    }

    return { changed, asked };
  }

  // The daily batch (§7.1-2/3 + §7.3). First scan after install runs over the
  // cold-start backfill range; later scans run since the previous watermark.
  // The whole body runs under the registry store's mutex (BET-1464 defect 3):
  // the scan holds its snapshot across seconds-long awaits, so without the
  // mutex a connect answer landing mid-scan would be reverted by the scan's
  // save. Returns `{ok, scanned, asked}`.
  async function dailyScan() {
    const nowMs = now();
    const untilTs = nowMs;
    const rows = [];
    let asked = null;
    let scanLedger = false;
    await patchRegistry(async (payload) => {
      const sinceTs =
        payload.lastScanTs ??
        (Number.isFinite(backfillStartInstant) ? backfillStartInstant : nowMs - 30 * DAY_MS);
      try {
        if (typeof collectDb === "function") {
          const dbRows = await collectDb({ sinceTs, untilTs, cap: SCAN_ROW_CAP });
          rows.push(...extractFromDbRows(dbRows));
        }
        if (typeof collectSurfaces === "function") {
          const surfaces = (await collectSurfaces()) ?? {};
          rows.push(...collectConfigEvidence(surfaces, { ts: nowMs }));
        }
      } catch {
        /* channel failures never take the scan down */
      }
      await appendUsage(rows);
      await fusePending(payload);
      await classifyOneRaw(payload);
      const { changed, asked: askTool } = await lifecycleStep(payload);
      payload.lastScanTs = untilTs;
      asked = askTool;
      scanLedger = changed || askTool != null;
      return payload;
    });
    if (scanLedger) {
      await ledgerLog({ kind: "cto.tool.scan", asked: asked ?? null });
    }
    return { ok: true, scanned: rows.length, asked: asked ?? null };
  }

  // Resolve a connect ask (§7.4 three-way, per ring). Writes the consent
  // ring, the §9.5 verdict (accept / dismiss / never), and resolves the open
  // card. `ring` selects which ring the ask was about: "metadata" (default)
  // or "deep_read" (BET-1404 — the deep-read ask's connect grants deep_read,
  // its not-now re-arms on the 30-day timer; never kills ALL rings either
  // way). A deep_read grant backstops on metadata consent (the ask gate
  // already requires it; this keeps a hand-crafted answer from skipping a
  // ring).
  async function resolveConnect({ tool, answer, ring = "metadata" } = {}) {
    const id = typeof tool === "string" ? tool.trim().toLowerCase() : "";
    if (!id) return { ok: false, error: "missing tool" };
    if (answer !== "connect" && answer !== "not-now" && answer !== "never") {
      return { ok: false, error: `invalid answer "${answer}"` };
    }
    if (ring !== "metadata" && ring !== "deep_read") {
      return { ok: false, error: `invalid ring "${ring}"` };
    }
    const nowMs = now();
    // The consent write runs under the registry store's mutex (BET-1464
    // defect 3). An early-exit error path returns an empty patch: no save.
    let err = null;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      t.consent = t.consent ?? emptyConsent();
      if (answer === "connect") {
        if (ring === "deep_read") {
          if (t.consent.metadata !== "yes") {
            err = { ok: false, error: `tool "${id}" has no metadata consent` };
            return null;
          }
          t.consent.deep_read = "yes";
          t.deepReArmAt = null;
          await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "deep_read", value: "yes" });
        } else {
          // The metadata ring is granted. Status stays `candidate` until the
          // first §7.5 probe actually runs (applyProbeResult flips it).
          t.consent.metadata = "yes";
          t.reArmAt = null;
          await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "metadata", value: "yes" });
          // §7.5 BET-1396: the ENGINE authors the tool's probe-spec template at
          // consent time, filled with the evidenced credential key (if any). The
          // file is engine-written; its content is completed through the runner's
          // validated writeSpec path. Best-effort — consent never depends on it.
          if (typeof scaffoldProbes === "function") {
            const secretRow = (t.evidence ?? []).find((e) => e?.channel === "secret" && typeof e?.detail === "string" && e.detail.startsWith("secret:"));
            await scaffoldProbes(id, { secret: secretRow ? secretRow.detail.slice("secret:".length) : null }).catch(() => {});
          }
        }
      } else if (answer === "not-now") {
        if (ring === "deep_read") {
          t.consent.deep_read = "no";
          t.deepReArmAt = nowMs + NOT_NOW_REARM_MS;
          t.deepAskAtUses = t.uses ?? 0;
          await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "deep_read", value: "no" });
        } else {
          t.consent.metadata = "no";
          t.reArmAt = nowMs + NOT_NOW_REARM_MS;
          t.askAtUses = t.uses ?? 0;
          await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "metadata", value: "no" });
        }
      } else {
        // Never: kills ALL rings and suppresses future asks (revocable only in
        // the §10.5 tool drill-down).
        t.consent = { metadata: "never", deep_read: "never", write: "never" };
        await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "metadata", value: "never" });
      }
      return payload;
    });
    if (err) return err;

    // §9.5: every UI control that expresses a judgment writes exactly one
    // verdict. Connect → accept; Not now → dismiss; Never → never. The class
    // names the ring the ask was about (metadata / deep-read), so §9.4
    // per-class trust counting and the as_source sink stay unambiguous.
    if (typeof recordVerdict === "function") {
      try {
        const subjectClass = ring === "deep_read" ? "tool-deep-read" : "tool-metadata";
        if (answer === "connect") {
          await recordVerdict({ subject: { type: "tool", id, class: subjectClass }, verdict: "accept" });
        } else if (answer === "not-now") {
          await recordVerdict({ subject: { type: "tool", id, class: subjectClass }, verdict: "dismiss" });
        } else {
          await recordVerdict({ subject: { type: "tool", id, class: subjectClass }, verdict: "never", never: true });
        }
      } catch {
        /* best-effort — the consent ring is the source of truth */
      }
    }

    // Close the open connect card for this tool (best-effort).
    if (cards && typeof cards.resolveConnectCards === "function") {
      try {
        await cards.resolveConnectCards(id, `connect answer: ${answer}`);
      } catch {
        /* best-effort */
      }
    }
    return { ok: true, tool: id, answer };
  }

  // §7.4 "Un-never" (the tool drill-down, B11, calls this): returns the tool
  // to `observed`, clears the never-suppression on every ring, and requires a
  // FRESH bar crossing before the next ask — enforced by the `unneverAtUses`
  // snapshot the promotion gate checks (barCrossed is monotone in uses, so
  // without the snapshot the tool would instantly re-promote and re-ask,
  // exactly the immediate re-prompt the spec's fresh-crossing requirement
  // exists to prevent). The server rule ships here; the drill-down UI/route
  // is B11's.
  async function unNever(toolId) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id) return { ok: false, error: "missing tool" };
    let err = null;
    let uses = 0;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      if (t.consent?.metadata !== "never") {
        err = { ok: false, error: `tool "${id}" is not never'd` };
        return null;
      }
      t.consent = emptyConsent();
      t.status = "observed";
      t.unneverAtUses = t.uses ?? 0;
      t.reArmAt = null;
      uses = t.uses ?? 0;
      return payload;
    });
    if (err) return err;
    await ledgerLog({ kind: "cto.tool.unnever", tool: id, uses });
    return { ok: true, tool: id };
  }

  // §10.5 row-4 per-ring revoke (§7.4 "consent rings … revocable"): writes
  // the ring to "no". Revoking metadata stops the §7.5 probes for the tool
  // automatically (consentContext requires metadata=yes) — no extra wiring.
  // Revoking a ring that was never granted (or that is "never"-ring-killed)
  // is a no-op error, not a silent pass — the drill-down disables the button
  // for those states, and the server is the backstop.
  async function revokeConsent(toolId, ring) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id) return { ok: false, error: "missing tool" };
    if (ring !== "metadata" && ring !== "deep_read" && ring !== "write") {
      return { ok: false, error: `ring must be one of metadata, deep_read, write` };
    }
    let err = null;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      const cur = { ...emptyConsent(), ...(t.consent ?? {}) };
      if (cur[ring] !== "yes") {
        err = { ok: false, error: `ring "${ring}" is not granted for "${id}"` };
        return null;
      }
      t.consent = { ...cur, [ring]: "no" };
      return payload;
    });
    if (err) return err;
    await ledgerLog({ kind: "cto.tool.consent", tool: id, ring, value: "no" });
    return { ok: true, tool: id, ring, value: "no" };
  }

  // Read a consent ring for the future probe / tool-write gates (§7.4:
  // "metadata consent ≠ deep-read consent ≠ write").
  async function consentFor(tool, ring = "metadata") {
    const id = typeof tool === "string" ? tool.trim().toLowerCase() : "";
    if (!id) return null;
    const payload = await loadPayload();
    const t = payload.tools.find((x) => x?.tool === id);
    return t ? (t.consent?.[ring] ?? null) : null;
  }

  // ---------------------------------------------------------------------------
  // BET-1396 — §7.3 vitality / §7.6 relevance / §7.4 lifecycle. All mutating
  // writers are patchStore writers (BET-1464 defect 3) — the whole-payload
  // store's lost-update guard is the store mutex, shared with the scan and
  // connect writers.
  // ---------------------------------------------------------------------------

  // The full row for one tool (probe runner reads evidence hosts + vitality;
  // the probe spec's host allowlist is derived from this). null when unknown.
  async function toolRow(toolId) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id) return null;
    const payload = await loadPayload();
    return payload.tools.find((x) => x?.tool === id) ?? null;
  }

  // The §7.6 decay chain's probing cap (Q2 cascade): a chain-tripped tool's
  // metadata probes run AT MOST weekly. The runner consults this instead of
  // deriving chain state itself — one source of truth for the chain's
  // effects, and the reason CADENCE_WEEKLY_MS lives in this module.
  async function probeCadenceCapMs(toolId) {
    const row = await toolRow(toolId);
    return row?.asSourceDecayed === true ? CADENCE_WEEKLY_MS : null;
  }

  // §7.3 vitality: fold ONE successful metadata probe's extract into the
  // vitality axis. `fields` is the probe's extract map (untrusted but tiny);
  // only the §7.2 well-known pair {last_event, inflow_rate} is consumed.
  // `inflow_rate` semantics: the RAW count of new items since the previous
  // probe, normalized to a per-week rate against elapsed wall time
  // (cadence-independent; the spec cadence covers the very first sample).
  // The rate is EWMA-smoothed (τ = 7d, the engagement axis's constant) into
  // `vitality.ewma` — the runner reads it for the daily↔weekly adaptation.
  // First success also flips §7.4 candidate → integrated (probes ran).
  // NOTE: the body itself runs under the registry store's mutex — no
  // wrapper serialization exists any more (BET-1464 defect 3); nesting a
  // second patchStore on the same store would deadlock the promise tail.
  async function applyProbeResult(toolId, { fields, probedAt, cadenceMs } = {}) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id) return { ok: false, error: "missing tool" };
    const vit = vitalityOf(fields);
    let err = null;
    let flipped = false;
    let vitality = null;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      t.vitality = t.vitality ?? { last_event: null, inflow_rate: null, ewma: null, last_probed: null };
      const v = t.vitality;
      const ts = typeof probedAt === "number" ? probedAt : now();
      if (vit.last_event !== undefined) v.last_event = vit.last_event;
      if (vit.inflow_rate !== undefined) {
        const cad = Number.isFinite(cadenceMs) && cadenceMs > 0 ? cadenceMs : WEEK_MS;
        const elapsed = Number.isFinite(v.last_probed) ? Math.max(ts - v.last_probed, 1) : cad;
        const ratePerWeek = (vit.inflow_rate * WEEK_MS) / elapsed;
        const decay = Math.exp(-(elapsed / DAY_MS) / EWMA_TAU_DAYS);
        v.ewma = v.ewma == null ? ratePerWeek : v.ewma * decay + ratePerWeek * (1 - decay);
        v.inflow_rate = vit.inflow_rate;
      }
      v.last_probed = ts;
      if (t.status === "candidate") {
        t.status = "integrated";
        flipped = true;
      }
      vitality = { ...v };
      return payload;
    });
    if (err) return err;
    if (flipped) {
      await ledgerLog({ kind: "cto.tool.integrated", tool: id });
    }
    return { ok: true, vitality, flipped };
  }

  // §7.6 relevance: persist the weekly nano-score for one (tool, project)
  // pair into the row's `relevance[project]` (clamped to [0,1]).
  async function applyRelevance(toolId, project, score) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id || typeof project !== "string" || !project) return { ok: false, error: "missing tool/project" };
    const s = Number(score);
    if (!Number.isFinite(s)) return { ok: false, error: "invalid score" };
    let err = null;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      t.relevance = { ...(t.relevance ?? {}), [project]: Math.max(0, Math.min(1, s)) };
      return payload;
    });
    if (err) return err;
    return { ok: true };
  }

  // §9.5 as_source sink target (BET-1404): fold one tool-as-source verdict's
  // effects into the §7.2 counters — accept/edit (`success`) → accepted+1 &
  // reports+1; dismiss/veto/correct/never (`rejection`) → reports+1;
  // `access`/`decay` (open/expire) are ephemeral and never enter the
  // acceptance counters. After a report fold, evaluate the §7.6 dismissal
  // decay chain's trip: ≥ AS_SOURCE_MIN_REPORTS reports AND the Beta lower
  // bound below AS_SOURCE_DECAY_LOWER_BOUND flips `asSourceDecayed` — the
  // Q2 one-shot cascade (deep analyses stop, probing caps at weekly, dormant
  // is the §7.3 dead condition). Revival is the fresh-engagement path in
  // lifecycleStep (§7.3/B7: renewed engagement re-promotes).
  async function applyAsSource(toolId, effects) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id) return { ok: false, error: "missing tool" };
    const e = effects && typeof effects === "object" ? effects : {};
    const isReport = e.success === true || e.rejection === true;
    if (!isReport) return { ok: true, changed: false };
    let err = null;
    let out = null;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      t.as_source = t.as_source ?? { reports: 0, accepted: 0 };
      if (e.success === true) t.as_source.accepted = (t.as_source.accepted ?? 0) + 1;
      t.as_source.reports = (t.as_source.reports ?? 0) + 1;
      const reports = t.as_source.reports;
      const rejected = reports - (t.as_source.accepted ?? 0);
      const tripped =
        reports >= AS_SOURCE_MIN_REPORTS &&
        betaLowerBound(t.as_source.accepted ?? 0, rejected) < AS_SOURCE_DECAY_LOWER_BOUND;
      if (tripped && t.asSourceDecayed !== true) {
        t.asSourceDecayed = true;
        t.decayedAtUses = t.uses ?? 0;
        await ledgerLog({
          kind: "cto.tool.as_source_decayed",
          tool: id,
          reports,
          accepted: t.as_source.accepted ?? 0,
        });
      }
      out = { ok: true, changed: true, as_source: { ...t.as_source }, decayed: t.asSourceDecayed === true };
      return payload;
    });
    if (err) return err;
    return out;
  }

  // One evidence row on the tool's trail (probe failures; §7.2 evidence
  // shape). Deduped on (channel, detail); capped at EVIDENCE_CAP.
  async function appendEvidence(toolId, entry) {
    const id = typeof toolId === "string" ? toolId.trim().toLowerCase() : "";
    if (!id || !entry || typeof entry.channel !== "string" || typeof entry.detail !== "string") {
      return { ok: false, error: "missing tool/evidence" };
    }
    let err = null;
    let changed = false;
    await patchRegistry(async (payload) => {
      const t = payload.tools.find((x) => x?.tool === id);
      if (!t) {
        err = { ok: false, error: `unknown tool "${id}"` };
        return null;
      }
      const row = { channel: entry.channel, detail: entry.detail, ts: Number.isFinite(entry.ts) ? entry.ts : now() };
      const exists = (t.evidence ?? []).some((e) => e?.channel === row.channel && e?.detail === row.detail);
      if (exists) return null; // dedupe — an empty patch, no save
      t.evidence = [...(t.evidence ?? []), row];
      if (t.evidence.length > EVIDENCE_CAP) t.evidence.splice(0, t.evidence.length - EVIDENCE_CAP);
      changed = true;
      return payload;
    });
    if (err) return err;
    return { ok: true, changed };
  }

  // Registry view for the §10.5 tool surfaces (read-only, stable shape).
  // BET-1399: also copies the §7.2 vitality axis and derives the §7.3
  // quadrant role at read time (display-only — the stored `role` is written
  // by a later issue; deriving here keeps the drill-down honest without a
  // schema write on every read).
  async function listTools({ nowMs } = {}) {
    const t = Number.isFinite(nowMs) ? nowMs : now();
    const payload = await loadPayload();
    return payload.tools.map((row) => {
      const vitality = { ...emptyVitality(), ...(row.vitality ?? {}) };
      return {
        tool: row.tool,
        displayName: row.displayName ?? humanize(row.tool),
        status: row.status ?? "observed",
        role: row.role ?? null,
        derivedRole: deriveRole(row, { nowMs: t }),
        uses: row.uses ?? 0,
        weeksActive: row.weeksActive ?? 0,
        ewmaPerWeek: Math.round((row.engagement?.ewma_per_week ?? 0) * 100) / 100,
        lastSeenTs: row.engagement?.last_used ?? null,
        firstSeenTs: row.firstSeenTs ?? null,
        vitality,
        consent: { ...emptyConsent(), ...(row.consent ?? {}) },
        askRound: row.askRound ?? 0,
        // §7.6 chain visibility (§10.5 drill-down): counters + trip state so
        // the surface can explain why deep analyses stopped — no dead state.
        asSource: { ...(row.as_source ?? { reports: 0, accepted: 0 }) },
        asSourceDecayed: row.asSourceDecayed === true,
        // §7.6 relevance map (BET-1404 overnight candidates read it through
        // this projection; also drives the drill-down's relevance display).
        relevance: { ...(row.relevance ?? {}) },
      };
    });
  }

  return {
    dailyScan,
    resolveConnect,
    unNever,
    revokeConsent,
    consentFor,
    listTools,
    appendUsage,
    // BET-1396: §7.5 probe-runner surface (read the row, fold vitality /
    // relevance, append failure evidence). toolRow is a pure read — it never
    // touches the write mutex (must never queue behind an in-flight scan).
    toolRow,
    applyProbeResult,
    applyRelevance,
    appendEvidence,
    // §9.5 as_source sink target (BET-1404) — a patchStore writer like the
    // others; the verdict sink is fire-and-forget, so the mutex keeps
    // concurrent folds from clobbering each other.
    applyAsSource,
    // §7.6 decay chain: the runner asks instead of deriving chain state.
    probeCadenceCapMs,
  };
}

// Re-exported for callers that build rows by hand (tests, index.mjs wiring).
export { CHANNEL_TRANSCRIPT, CHANNEL_CONFIG, SCAN_ROW_CAP };

// ctoToolRegistry.mjs — §7.2 registry + fusion + lifecycle (BET-1395) + the
// §7.3 vitality / §7.6 relevance axes (BET-1396).
//
// ACCESS IS THE SECRET STORE. A key present in the manta secret store grants
// the CTO FULL access to the matching tool — no consent rings, no connect
// asks, no read/write split. The user adding a secret IS the grant; deleting
// it is the revocation. `consentFor()` is the one chokepoint every probe and
// read path funnels through, and it derives its answer from the store's KEY
// LIST at decision time (keys and hints only — a value is never read here).
// A tool with no matching secret has no access and asks nothing.
//
// The registry fuses the four §7.1 evidence channels into ONE row per tool
// identity ("one identity, one row"), derives engagement, and tracks the
// lifecycle bars for display:
//
//   observed (evidence accumulates) → candidate (either axis crosses its bar:
//     engagement ≥3 uses across ≥2 weeks; OR the vitality path — a credential
//     exists at all) → integrated (the FIRST successful §7.5 probe run flips
//     it here; applyProbeResult does the flip).
//
// Raw evidence (unknown CLIs/hosts/keys) is classified by the LLM fallback at
// most ONCE per identity — the model's judgment is cached in the registry
// entry and never re-asked (§7.1-4). Near-duplicates fold: a host that is a
// subdomain of an already-known identity's domain is not a new tool; git
// remotes are collected at host granularity so slug-covered hosts never
// become rows in the first place (§7.3 near-duplicate suppression).
//
// All I/O is injected; pure helpers are exported for tests.

import { toolRegistryStore, toolUsageStore, toolClassificationStore, ledgerStore, patchStore } from "./ctoStores.mjs";
import { displayName as catalogDisplayName, isKnownIdentity, matchSecretIdentity } from "./ctoToolCatalog.mjs";
// KEY NAMES ONLY — `listSecretKeys` returns an array of strings, so nothing
// value-bearing can reach this module even by accident. Never import a
// value-returning path here (`provideSecret` is not for this file).
import { listSecretKeys } from "./secrets.mjs";
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
      asSourceDecayed: false,
      decayedAtUses: 0,
      ...(t ?? {}),
    })),
    lastScanTs: Number.isFinite(p?.lastScanTs) ? p.lastScanTs : null,
    lastScanId: typeof p.lastScanId === "string" ? p.lastScanId : "",
    lastSurfaceDay: typeof p.lastSurfaceDay === "string" ? p.lastSurfaceDay : null,
    lastClassificationDay: typeof p.lastClassificationDay === "string" ? p.lastClassificationDay : null,
    scanRetryAt: Number.isFinite(p.scanRetryAt) ? p.scanRetryAt : 0,
    scanFailures: Number.isFinite(p.scanFailures) ? p.scanFailures : 0,
    lastFusedTs: Number.isFinite(p?.lastFusedTs) ? p.lastFusedTs : null,
  };
}
export const ACTOR = "cto";

// Evidence-log cap (all channels) — the usage log is a bounded FIFO.
export const USAGE_ROWS_CAP = 4000;
// Per-tool evidence trail cap (§7.2 `evidence: [{channel, detail, ts}]`).
export const EVIDENCE_CAP = 20;
// Raw evidence must appear this many times before ONE LLM classification is
// spent on it (low-evidence singletons remain unresolved).
export const RAW_CLASSIFY_MIN_USES = 2;
export const UNRESOLVED_PRUNE_LIMIT = 1000;
export const UNRESOLVED_RETENTION_MS = 90 * 24 * 3_600_000;

// ---------------------------------------------------------------------------
// IDENTITY RESOLUTION — the one seam. Everything in the grant / access /
// probe path resolves a tool name through these functions and NOTHING else:
// findToolRow (which row), resolveIdentities (which names), grantedKeyForName
// (which key may serve a name); there is no bare `.find` on a tool name left
// in this module (the sweep tests in ctoToolRegistry.test.mjs pin the seam
// under both names; consumers outside the module go through the
// `identitiesFor` engine method). The one deliberate exact-name comparison —
// the classification prune below — is commented in place where it lives.
//
// Why it has to be a seam rather than a convention: classification merges a
// raw row into its canonical one and keeps the old token as an ALIAS, so one
// tool legitimately answers to several names. Three review rounds in a row
// found the same shape of bug — the alias rule applied in one place and not
// its neighbour — and every one of them was a place that wrote its own
// lookup. A rule that lives in one function cannot be half-applied.
// ---------------------------------------------------------------------------

// A caller-supplied tool name, normalized. Identities are lowercase.
export function normalizeToolId(id) {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

// Every identity a registry row answers to: its canonical name plus the
// aliases classification folded into it. A row IS each of these.
export function identitiesOf(row) {
  return [row?.tool, ...(Array.isArray(row?.aliases) ? row.aliases : [])].filter(
    (id) => typeof id === "string" && id !== "",
  );
}

// The ONE row that answers to `id`. Resolution order is load-bearing and
// deterministic (independent of row order in the store):
//   1. EXACT PRIMARY always wins — a row whose `tool` IS the name answers
//      for it, and an alias on some other row must never shadow it.
//   2. Otherwise the row that claims the name as an ALIAS — but only when
//      exactly ONE row does. Two claimants is an ambiguous alias: there is
//      no defensible pick, so it resolves to NO row (fail closed), whichever
//      way the evidence happened to arrive.
export function findToolRow(tools, id) {
  const norm = normalizeToolId(id);
  if (!norm) return null;
  const arr = Array.isArray(tools) ? tools : [];
  const primary = arr.find((r) => normalizeToolId(r?.tool) === norm);
  if (primary) return primary;
  let owner = null;
  for (const r of arr) {
    if (!(Array.isArray(r?.aliases) ? r.aliases : []).some((a) => normalizeToolId(a) === norm)) continue;
    if (owner) return null;
    owner = r;
  }
  return owner;
}

// Every identity `id` is known by — the identity SET the grant is checked
// against. A row can only EXTEND that set, never shrink it: an unknown name
// resolves to itself, so a tool granted by a stored key that nothing has ever
// used still resolves (a registry row is not a precondition for access), and
// a row that answers to the name contributes its other names too (so the
// canonical name and any alias reach the same grant).
//
// THE ALIAS BRIDGE HAS ONE LIMIT, and it is authorization, not discovery: a
// requested name that is itself a KNOWN CATALOG identity is a distinct
// service its own keys could name, so an alias must never transfer a grant
// onto it — `GITHUB_TOKEN` must not authorize "stripe" because a model once
// merged their evidence rows, even when no stripe row exists to object. A
// name the catalog does NOT know can only be reached through the bridge at
// all, so the bridge is exactly what makes it reachable (multica-ai inherits
// multica's grant; the catalog knows `multica`, never `multica-ai`).
export function resolveIdentities(tools, id) {
  const norm = normalizeToolId(id);
  if (!norm) return [];
  const row = findToolRow(tools, norm);
  if (row && normalizeToolId(row.tool) !== norm && isKnownIdentity(norm)) return [norm];
  return row ? identitiesOf(row) : [norm];
}

// THE grant behind ONE name, given the identity set its row answers with —
// one rule for every direction (the access chokepoint below AND the list
// projection's per-row accessKey):
//   - the name's OWN key always serves it (the direct path — a key that
//     names the tool is the whole grant);
//   - otherwise a grant may cross the row's alias bridge ONLY when the name
//     is not itself a known catalog identity (see resolveIdentities).
// Pure so both consumers provably share it; resolveIdentities applies the
// same rule when building `ids`, so a caller that resolves the set through
// the seam cannot disagree with this one.
export function grantedKeyForName(granted, norm, ids) {
  const direct = granted.get(norm);
  if (direct) return direct;
  if (isKnownIdentity(norm)) return null;
  return (Array.isArray(ids) ? ids : []).map((id) => granted.get(id)).find(Boolean) ?? null;
}

// §6.7 "a consented tool for issue facts": does the registry report an issue
// tool the CTO can actually reach? Reads `accessKey` — the §7.4 grant — off
// the listTools projection, so the issue surface exists exactly when a secret
// in the store names the box's issue tool, and stops existing the moment that
// secret is deleted. Pure, so the wiring in index.mjs has nothing to get
// wrong and this rule is testable against a real projection.
export const ISSUE_TOOL_RE = /^(?:multica|issue-tracker)(?:[-/].*)?$/i;

export function isIssueToolGranted(tools) {
  return (Array.isArray(tools) ? tools : []).some(
    (t) =>
      identitiesOf(t).some((id) => ISSUE_TOOL_RE.test(id)) &&
      typeof t?.accessKey === "string" &&
      t.accessKey !== "",
  );
}

// Bound only unresolved, untouched candidates. A resolved identity is never
// an eviction candidate, even when it is old; nor is access ever at stake —
// the secret store grants it, not this row.
export function retainUnresolved(tools, nowMs) {
  const eligible = tools.filter((t) => t.raw && !t.unclassifiable &&
    t.status === "observed" && (t.uses ?? 0) <= 1 &&
    nowMs - (t.engagement?.last_used ?? t.firstSeenTs ?? nowMs) > UNRESOLVED_RETENTION_MS);
  const expired = new Set(eligible
    .sort((a, b) => (a.engagement?.last_used ?? a.firstSeenTs ?? 0) - (b.engagement?.last_used ?? b.firstSeenTs ?? 0))
    .slice(0, UNRESOLVED_PRUNE_LIMIT));
  return tools.filter((t) => !expired.has(t));
}

export function recoverLegacyClassification(tools, nowMs) {
  // Old records conflated errors/gating with an explicit model rejection.
  // Never guess which it was: allow one new assessment only after new use.
  const target = tools.find((t) => t.raw && t.unclassifiable &&
    !t.classificationOutcome && !t.classificationRecovery &&
    Number.isFinite(t.llmAt) && (t.engagement?.last_used ?? 0) > t.llmAt &&
    (t.uses ?? 0) >= RAW_CLASSIFY_MIN_USES &&
    t.status === "observed");
  if (!target) return null;
  target.classificationRecovery = { at: nowMs, previousLlmAt: target.llmAt, basis: "fresh-evidence" };
  target.unclassifiable = false;
  target.llmAt = null;
  return target.tool;
}
// The engagement bar (§7.4): ≥3 uses across ≥2 distinct weeks.
export const ENGAGEMENT_MIN_USES = 3;
export const ENGAGEMENT_MIN_WEEKS = 2;
// Renewed engagement beyond a decay trip's snapshot revives the tool: this
// many uses past it counts as fresh engagement.
export const REARM_FRESH_USES = 2;
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
// derived counters (the bar's inputs). Access is NOT a field here — it is
// derived from the secret store at decision time.
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
    // Channel 1: a credential names its tool the same way the §7.4 grant
    // does, so the evidence lands ON that tool — providing GITHUB_PAT is
    // engagement with github, not with a phantom "github_pat" row nothing
    // can ever reach (the store grants `github`). A key the catalog cannot
    // place falls through to the raw path below, which is what the one-shot
    // LLM classification is for.
    const fromSecret = detail.startsWith("secret:") ? matchSecretIdentity(detail.slice("secret:".length)) : null;
    if (fromSecret) {
      row = { ...row, identity: fromSecret, source: "catalog" };
    } else {
      // Unclassified raw evidence → a raw registry entry keyed by the token
      // itself, for the one-shot LLM classification (§7.1-4). Labels stay
      // log-only.
      const rawIdentity = rawIdentityFromDetail(detail);
      if (rawIdentity) row = { ...row, identity: rawIdentity, source: "raw" };
    }
  }

  const identity = typeof row.identity === "string" && row.identity ? row.identity.toLowerCase() : null;
  if (!identity) return arr; // no derivable identity — log-only evidence

  let tool = findToolRow(arr, identity);
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
    classificationStore = toolClassificationStore,
    ledger = ledgerStore,
    runEphemeral = null, // async ({taskClass, context}) => {text}
    // The access grant's source of truth: the secret store's KEY LIST, read
    // at decision time. An array of key NAMES and nothing else — see
    // `listSecretKeys`.
    listSecretKeys: readSecretKeys = () => listSecretKeys(),
    now = () => Date.now(),
    // I/O seams for the daily scan (index.mjs supplies the live ones).
    collectDb = null, // async ({sinceTs, untilTs, cap}) => db part rows
    collectSurfaces = null, // async () => {config, forgeRepos, webhooks, gitRemotes, schedules}
    backfillStartInstant = null, // first-scan lower bound (the backfill range)
    // BET-1396 §7.5: async (toolId, {secret}) — the probe runner's
    // scaffoldSpec; called for every tool the secret store grants (the grant
    // IS the trigger) so the ENGINE authors the tool's probe-spec template.
    // AI-authored content goes through the runner's validated writeSpec; no
    // other writer touches probes/<tool>.yaml. Idempotent per tool.
    scaffoldProbes = null,
  } = deps;

  // ---- The access grant (the single rule) ---------------------------------
  // Every stored key → the ONE tool it names → `identity → key`. Built fresh
  // on every call: the store is the live control surface, so a secret added a
  // second ago grants immediately and a deleted one stops granting
  // immediately. A key that names no known tool, or names more than one,
  // contributes nothing (see matchSecretIdentity). Key NAMES only — no value,
  // no hint, nothing else is in scope here.
  //
  // Deliberately uncached. This is an authorization decision, and a cache is
  // a second source of truth that can disagree with the store; the read is
  // one small JSON file and its callers (probe ticks, drill-down renders) are
  // minutes apart, not a tight loop. Correctness over a micro-optimisation.
  function grantedTools() {
    let keys;
    try {
      keys = readSecretKeys() ?? [];
    } catch {
      return new Map();
    }
    const granted = new Map();
    for (const key of Array.isArray(keys) ? keys : []) {
      const identity = typeof key === "string" ? matchSecretIdentity(key) : null;
      if (identity && !granted.has(identity)) granted.set(identity, key);
    }
    return granted;
  }

  // BET-1464 defect 3: every tool-registry.json write routes through
  // patchStore — the read-fresh-merge-save runs under the registry store's
  // own mutex, keyed by the store path. This replaces the old per-instance
  // write chain (`serialized`) with the ONE shared discipline every CTO
  // store writer uses: a writer whose body awaits (the scan's db batch, the
  // LLM classification) holds the mutex across the whole body, so a
  // concurrent writer's row can no longer be silently overwritten by a stale
  // save (the same snapshot-spreading-writer class BET-1425 fixed for
  // engine-state). Mutators receive the RAW store payload
  // and normalize via payloadFrom; returning an empty patch means "no
  // change, no save" (the early-exit error paths rely on that).
  function patchRegistry(mutate) {
    return patchStore(registryStore, async (fresh) => (await mutate(payloadFrom(fresh))) ?? {});
  }

  async function loadPayload() {
    try {
      return payloadFrom(await registryStore.load());
    } catch {
      return { v: TOOL_REGISTRY_VERSION, tools: [], lastScanTs: null, lastFusedTs: null };
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
      if (r.fused === true) continue;
      if (ts <= watermark) continue;
      tools = fuseRow(tools, r, { nowMs: now() });
      maxTs = Math.max(maxTs, ts);
    }
    payload.tools = tools;
    payload.lastFusedTs = maxTs || payload.lastFusedTs;
    return payload;
  }

  // Registry lock -> classification lock, never the reverse. The independent
  // store commits the reservation/result even if this registry transaction fails.
  async function classifyOneRaw(payload, replayCount = 0) {
    if (typeof runEphemeral !== "function") return payload;
    if (replayCount >= 100) return payload;
    const day = new Date(now()).toISOString().slice(0, 10);
    let target;
    let attempt;
    let replay = false;
    await patchStore(classificationStore, (fresh) => {
      const records = fresh.records ?? {};
      const eligible = payload.tools.filter((t) => t.raw && !t.unclassifiable && t.llmAt == null &&
        t.uses >= RAW_CLASSIFY_MIN_USES);
      target = eligible.find((t) => ["resolved", "rejected"].includes(records[t.tool]?.status));
      if (target) {
        attempt = records[target.tool];
        replay = true;
        return {};
      }
      if (fresh.day === day || payload.lastClassificationDay === day) return {};
      const due = eligible.filter((t) => Math.max(t.retryAfter ?? 0, records[t.tool]?.retryAfter ?? 0) <= now());
      const untried = due.filter((t) => !records[t.tool] && !t.classificationOutcome)
        .sort((a, b) => (a.firstSeenTs ?? 0) - (b.firstSeenTs ?? 0));
      const retries = due.filter((t) => records[t.tool] || t.classificationOutcome)
        .sort((a, b) => (records[a.tool]?.at ?? a.classificationOutcome?.at ?? 0) -
          (records[b.tool]?.at ?? b.classificationOutcome?.at ?? 0));
      // Alternate lanes when both exist; least-recently attempted retry first.
      const lane = untried.length && (fresh.lane !== "new" || !retries.length) ? "new" : "retry";
      target = (lane === "new" ? untried : retries)[0];
      if (!target) return {};
      const count = (records[target.tool]?.attempts ?? 0) + 1;
      attempt = { status: "reserved", at: now(), attempts: count,
        retryAfter: now() + DAY_MS * Math.min(14, 2 ** Math.min(count - 1, 4)) };
      return { day, lane, records: { ...records, [target.tool]: attempt } };
    });
    if (!target) return payload;
    if (!replay) payload.lastClassificationDay = day;
    const next = () => replay ? classifyOneRaw(payload, replayCount + 1) : payload;
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
    if (!replay) {
      let status = "retry";
      let canonical = null;
      try {
        const res = await runEphemeral({ taskClass: TOOL_CLASSIFY_TASK_CLASS, operation: "tool-classification", context });
        if (!res?.gated && res?.ok !== false && typeof res?.text === "string") {
          canonical = parseClassification(res.text);
          if (canonical) status = "resolved";
          else if (res.text.trim().toLowerCase() === "unknown") status = "rejected";
        }
      } catch { /* reservation survives a thrown provider error */ }
      attempt = { ...attempt, status, ...(canonical ? { canonical } : {}) };
      await patchStore(classificationStore, (fresh) => ({ records: { ...fresh.records, [target.tool]: attempt } }));
    }
    target.classificationOutcome = { status: attempt.status, at: attempt.at };
    if (attempt.status === "retry") {
      target.retryAfter = attempt.retryAfter;
      return payload;
    }
    target.llmAt = attempt.at;
    if (attempt.status === "rejected") {
      target.unclassifiable = true;
      return next();
    }
    const canonical = attempt.canonical;
    if (canonical === target.tool) {
      target.raw = false;
      target.source = "llm";
      target.displayName = humanize(canonical);
      return next();
    }
    // Merge the raw entry into the canonical identity (or create it).
    let canon = findToolRow(payload.tools, canonical);
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
    canon.classificationOutcome = target.classificationOutcome;
    canon.aliases = [...new Set([...(canon.aliases ?? []), target.tool, ...(target.aliases ?? [])])];
    payload.tools = payload.tools.filter((t) => t !== target);
    return next();
  }

  // Lifecycle (§7.3): EWMA decay, decay-chain revival, and the
  // observed→candidate promotion. Nothing here asks the user anything — the
  // secret store is the only grant. Returns `{changed}`.
  async function lifecycleStep(payload) {
    const nowMs = now();
    let changed = false;

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
    // tripped tool — fresh uses beyond the trip's snapshot clear the flag so
    // deep analyses + candidate generation resume. No second dormancy
    // definition: the standard lifecycle owns everything downstream.
    for (const t of payload.tools) {
      if (t?.asSourceDecayed !== true) continue;
      if ((t?.uses ?? 0) > (t?.decayedAtUses ?? 0) + REARM_FRESH_USES) {
        t.asSourceDecayed = false;
        t.decayedAtUses = 0;
        changed = true;
        await ledgerLog({ kind: "cto.tool.as_source_revived", tool: t.tool, uses: t.uses ?? 0 });
      }
    }

    // Promote observed → candidate when either axis crosses its bar.
    for (const t of payload.tools) {
      if (t.raw || t.unclassifiable) continue;
      if (t?.status !== "observed" || !barCrossed(t)) continue;
      t.status = "candidate";
      changed = true;
      await ledgerLog({ kind: "cto.tool.candidate", tool: t.tool, uses: t.uses, weeksActive: t.weeksActive });
    }

    return { changed };
  }

  // The daily batch (§7.1-2/3 + §7.3). First scan after install runs over the
  // cold-start backfill range; later scans run since the previous watermark.
  // The whole body runs under the registry store's mutex (BET-1464 defect 3):
  // the scan holds its snapshot across seconds-long awaits, so without the
  // mutex a concurrent writer's row would be reverted by the scan's save.
  // Returns `{ok, scanned}`.
  async function dailyScan() {
    const previous = await loadPayload();
    if (previous.scanRetryAt > now()) return { ok: false, deferred: true, retryAt: previous.scanRetryAt, scanned: 0 };
    const nowMs = now();
    const untilTs = nowMs;
    const rows = [];
    let scanLedger = false;
    let scanOk = true;
    let scanCode;
    await patchRegistry(async (payload) => {
      const sinceTs =
        payload.lastScanTs ??
        (Number.isFinite(backfillStartInstant) ? backfillStartInstant : nowMs - 30 * DAY_MS);
      await fusePending(payload);
      let dbCursor = null;
      try {
        if (typeof collectDb === "function") {
          const dbRows = await collectDb({ sinceTs, afterId: payload.lastScanId, untilTs, cap: SCAN_ROW_CAP });
          const last = dbRows.at(-1);
          dbCursor = dbRows.length >= SCAN_ROW_CAP
            ? { ts: last.time_created, id: last.id }
            : { ts: untilTs, id: "" };
          if (!Number.isFinite(dbCursor.ts) || dbCursor.ts < sinceTs || dbCursor.ts > untilTs ||
              typeof dbCursor.id !== "string" || (dbRows.length >= SCAN_ROW_CAP && !dbCursor.id)) {
            throw new Error("invalid-cursor");
          }
          rows.push(...extractFromDbRows(dbRows));
        }
      } catch (error) {
        scanOk = false;
        scanCode = error.code === "unsupported-runtime" ? "unsupported-runtime" : "db-unavailable";
        dbCursor = null;
      }
      try {
        const day = new Date(nowMs).toISOString().slice(0, 10);
        if (typeof collectSurfaces === "function" && payload.lastSurfaceDay !== day) {
          const surfaces = (await collectSurfaces()) ?? {};
          rows.push(...collectConfigEvidence(surfaces, { ts: nowMs }));
          payload.lastSurfaceDay = day;
        }
      } catch {
        scanOk = false;
        scanCode ??= "surfaces-unavailable";
      }
      // Fuse the complete page, not the capped diagnostic usage FIFO. The DB
      // cursor and fused counters commit together in this registry transaction.
      for (const row of rows) payload.tools = fuseRow(payload.tools, row, { nowMs });
      if (payload.lastClassificationDay !== new Date(nowMs).toISOString().slice(0, 10)) {
        recoverLegacyClassification(payload.tools, nowMs);
      }
      await classifyOneRaw(payload);
      const { changed } = await lifecycleStep(payload);
      payload.tools = retainUnresolved(payload.tools, nowMs);
      if (dbCursor) {
        payload.lastScanTs = dbCursor.ts;
        payload.lastScanId = dbCursor.id;
      }
      scanLedger = changed;
      payload.scanFailures = scanOk ? 0 : payload.scanFailures + 1;
      payload.scanRetryAt = scanOk ? 0 : nowMs + (scanCode === "unsupported-runtime" ? DAY_MS :
        Math.min(3_600_000, 300_000 * 2 ** Math.min(payload.scanFailures - 1, 4)));
      return payload;
    });
    if (scanLedger) {
      await ledgerLog({ kind: "cto.tool.scan" });
    }
    await scaffoldGrantedTools();
    try {
      await appendUsage(rows.map((row) => ({ ...row, fused: true })));
    } catch {
      await ledgerLog({ kind: "cto.tool.usage_persist_failed", code: "persist-error" });
    }
    const saved = await loadPayload();
    // Only prune outcomes proven applied to a committed registry. Pending
    // results and reservations survive; never modify aliases here.
    await patchStore(classificationStore, (fresh) => {
      const records = { ...fresh.records };
      let changed = false, pruned = 0;
      for (const [key, record] of Object.entries(records)) {
        if (!["resolved", "rejected"].includes(record.status)) continue;
        // NOT an identity lookup, and deliberately not routed through the
        // resolver: this asks "was THIS classification outcome applied to the
        // registry", which is a question about one specific record. The
        // rejected branch must match the raw row that was rejected under its
        // own name (an alias would mean a different decision was applied);
        // the resolved branch uses the resolver, because a resolved key is
        // exactly an identity the merged row now answers to.
        const applied = saved.tools.some((t) => record.status === "rejected"
          ? t.tool === key && t.unclassifiable && t.llmAt === record.at
          : !t.raw && identitiesOf(t).includes(key));
        if (!record.appliedAt && applied) { records[key] = { ...record, appliedAt: now() }; changed = true; }
        if (record.appliedAt && now() - record.appliedAt > 90 * DAY_MS && pruned < 1000) {
          delete records[key]; changed = true; pruned++;
        }
      }
      return changed ? { records } : {};
    });
    if (!scanOk) await ledgerLog({ kind: "cto.tool.scan_unavailable", code: scanCode, retryAt: saved.scanRetryAt });
    return { ok: scanOk, partial: Boolean(saved.lastScanId), scanned: rows.length };
  }

  // The grant IS the trigger: every tool the secret store grants gets its
  // §7.5 probe-spec template authored, filled with the granting key's NAME
  // (never its value). `scaffoldSpec` is idempotent — a tool that already has
  // a spec is left exactly as it is, so this runs safely on every scan and
  // needs no per-tool bookkeeping. Best-effort: the scan never fails on it.
  async function scaffoldGrantedTools() {
    if (typeof scaffoldProbes !== "function") return;
    for (const [tool, key] of grantedTools()) {
      await scaffoldProbes(tool, { secret: key }).catch(() => {});
    }
  }

  // THE CHOKEPOINT. Every probe / read path asks here whether the CTO may
  // touch a tool, and the answer comes from the secret store's key list —
  // read fresh, right now. A key that names this tool grants FULL access, so
  // the answer no longer depends on which ring a caller asks about — the
  // callers are unchanged, and every one of them gets the same "yes". No
  // secret → null: no access, and nothing is asked of the user.
  //
  // The STORE is the only thing that grants. The registry is consulted for
  // one purpose only — to learn which OTHER names this tool answers to (§7.2
  // aliases) — and it can only ever WIDEN the identity set: a name with no
  // row resolves to itself, so a secret nothing has used still grants, and a
  // consent record left by the retired ask flow is not consulted at all.
  // Rows cannot withhold a grant; they can only tell us it is the same tool.
  // The one limit — a known catalog name never inherits another service's
  // key through an alias bridge — lives in the resolver (resolveIdentities +
  // grantedKeyForName), not here: this is a consumer of the one seam.
  async function accessFor(tool) {
    const norm = normalizeToolId(tool);
    if (!norm) return null;
    const granted = grantedTools();
    // Cheap path first: the name itself is granted, whatever the registry says.
    const direct = granted.get(norm);
    if (direct) return direct;
    let tools = [];
    try {
      tools = (await loadPayload()).tools;
    } catch {
      tools = [];
    }
    return grantedKeyForName(granted, norm, resolveIdentities(tools, norm));
  }

  async function consentFor(tool) {
    return (await accessFor(tool)) ? "yes" : null;
  }

  // The grant behind a tool, for the §10.5 drill-down: which stored KEY makes
  // it reachable (a key name is not a secret), or null when nothing does.
  async function grantFor(tool) {
    return (await accessFor(tool)) ?? null;
  }

  // Is THIS stored key authorized FOR this tool — by the SAME authorization
  // seam every regular grant goes through, with NO independent alias policy?
  // The §7.5 probe specs pin a granting key's NAME at scaffold time; this is
  // how the runner checks a pinned key before sending that credential to the
  // tool's endpoint. Two conditions, both required:
  //   1. the EXACT pinned key is still present in the store — its identity
  //      being covered by some OTHER key is not enough (GITHUB_OLD_TOKEN
  //      absent must not pass because GITHUB_TOKEN exists);
  //   2. the policy would serve `tool` with a key of the pinned key's OWN
  //      identity — asked of grantedKeyForName itself, the same function the
  //      access chokepoint uses, so a cross-service alias (github's row
  //      claiming "stripe") can never authorize sending STRIPE_TOKEN's
  //      credential toward the github endpoint. When the pin fails, the
  //      fallback (grantFor) supplies the tool's own granting key.
  async function keyGrantedForTool(key, tool) {
    const norm = normalizeToolId(tool);
    if (!norm) return false;
    const idK = typeof key === "string" ? matchSecretIdentity(key) : null;
    if (!idK) return false;
    let keys;
    try {
      keys = readSecretKeys() ?? [];
    } catch {
      return false;
    }
    if (!Array.isArray(keys) || !keys.includes(key)) return false;
    const granted = grantedTools();
    let tools = [];
    try {
      tools = (await loadPayload()).tools;
    } catch {
      tools = [];
    }
    const served = grantedKeyForName(granted, norm, resolveIdentities(tools, norm));
    if (!served) return false;
    // grantedKeyForName answers with ONE key; a sibling key of the SAME
    // identity (both in the store) is the same service and is authorized too.
    return matchSecretIdentity(served) === idK;
  }

  // ---------------------------------------------------------------------------
  // BET-1396 — §7.3 vitality / §7.6 relevance / §7.4 lifecycle. All mutating
  // writers are patchStore writers (BET-1464 defect 3) — the whole-payload
  // store's lost-update guard is the store mutex, shared with the scan.
  // ---------------------------------------------------------------------------

  // The full row for one tool (probe runner reads evidence hosts + vitality;
  // the probe spec's host allowlist is derived from this). null when unknown.
  async function toolRow(toolId) {
    const id = normalizeToolId(toolId);
    if (!id) return null;
    return findToolRow((await loadPayload()).tools, id);
  }

  // The identity SET behind a tool name — the exact resolution the grant
  // (accessFor) is checked against, exposed for consumers that key their OWN
  // state by tool name (the §7.5 probe spec/state files) so their lookup can
  // agree with the grant under any of the row's names. Canonical first, the
  // requested name never dropped by the caller (it prepends its own).
  async function identitiesFor(toolId) {
    const id = normalizeToolId(toolId);
    if (!id) return [];
    let tools = [];
    try {
      tools = (await loadPayload()).tools;
    } catch {
      tools = [];
    }
    return resolveIdentities(tools, id);
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
    const id = normalizeToolId(toolId);
    if (!id) return { ok: false, error: "missing tool" };
    const vit = vitalityOf(fields);
    let err = null;
    let flipped = false;
    let vitality = null;
    await patchRegistry(async (payload) => {
      const t = findToolRow(payload.tools, id);
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
    const id = normalizeToolId(toolId);
    if (!id || typeof project !== "string" || !project) return { ok: false, error: "missing tool/project" };
    const s = Number(score);
    if (!Number.isFinite(s)) return { ok: false, error: "invalid score" };
    let err = null;
    await patchRegistry(async (payload) => {
      const t = findToolRow(payload.tools, id);
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
    const id = normalizeToolId(toolId);
    if (!id) return { ok: false, error: "missing tool" };
    const e = effects && typeof effects === "object" ? effects : {};
    const isReport = e.success === true || e.rejection === true;
    if (!isReport) return { ok: true, changed: false };
    let err = null;
    let out = null;
    await patchRegistry(async (payload) => {
      const t = findToolRow(payload.tools, id);
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
    const id = normalizeToolId(toolId);
    if (!id || !entry || typeof entry.channel !== "string" || typeof entry.detail !== "string") {
      return { ok: false, error: "missing tool/evidence" };
    }
    let err = null;
    let changed = false;
    await patchRegistry(async (payload) => {
      const t = findToolRow(payload.tools, id);
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
  //
  // THE GRANT IS ENUMERABLE HERE, NOT JUST ANSWERABLE. Access comes from the
  // secret store, which knows nothing about discovery, so a tool granted by a
  // key that nothing has ever used has no registry row — and every consumer
  // that derives access by scanning this list (the §6.7 issue surface, the
  // §7.6 overnight candidates, the §10.5 drill-down) would silently see no
  // access at all while `consentFor` said yes. So a granted tool with no row
  // is projected anyway, from the store: an honest empty row (zero uses, no
  // vitality, status `observed`) carrying its `accessKey`. It is a
  // PROJECTION, never a write — nothing about being granted makes a tool
  // "observed", and the registry still only records what it really saw.
  //
  // Both halves of that — "is this identity already here?" and "which row
  // carries the grant?" — resolve a row's identity THE SAME WAY, through
  // `findToolRow`, and the per-row accessKey goes through the same
  // `grantedKeyForName` rule the access chokepoint uses. They must: an exact
  // primary always wins over an alias, and a grant may cross an alias bridge
  // only onto a name the catalog does not know (see the seam block above).
  // When the resolved row does NOT display the grant — its primary is a
  // different known service, so the alias cannot carry the key — the granted
  // identity projects as its own row instead, keeping the list and the
  // chokepoint in agreement. One resolver, used for both, makes that
  // disagreement unrepresentable.
  async function listTools({ nowMs } = {}) {
    const t = Number.isFinite(nowMs) ? nowMs : now();
    const payload = await loadPayload();
    const granted = grantedTools();
    const seen = new Set();
    const rows = [...payload.tools];
    for (const tool of granted.keys()) {
      const row = findToolRow(rows, tool);
      if (row && grantedKeyForName(granted, normalizeToolId(row.tool), identitiesOf(row))) continue;
      rows.push(baseTool(tool, t));
    }
    return rows.map((row) => {
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
        // Every identity this row answers to, so a consumer matching on a
        // tool NAME sees the same identity set the grant was resolved against.
        aliases: [...(row.aliases ?? [])],
        // Access, as the drill-down must state it: the stored KEY that grants
        // this tool (a key name is not a secret), or null — in which case the
        // CTO cannot reach it and nothing will ask the user to change that.
        // THE SAME RULE the access chokepoint applies to a request for this
        // row's primary name (grantedKeyForName): its own key, or — only for
        // a name the catalog does not know — a grant reached via the alias
        // bridge.
        accessKey: grantedKeyForName(granted, normalizeToolId(row.tool), identitiesOf(row)),
        // §7.6 chain visibility (§10.5 drill-down): counters + trip state so
        // the surface can explain why deep analyses stopped — no dead state.
        asSource: { ...(row.as_source ?? { reports: 0, accepted: 0 }) },
        asSourceDecayed: row.asSourceDecayed === true,
        // §7.6 relevance map (BET-1404 overnight candidates read it through
        // this projection; also drives the drill-down's relevance display).
        relevance: { ...(row.relevance ?? {}) },
      };
    }).filter((row) => {
      // One row per identity, even if an alias collided during projection.
      if (seen.has(row.tool)) return false;
      seen.add(row.tool);
      return true;
    });
  }

  return {
    dailyScan,
    // The single access chokepoint + the grant behind it (§10.5 display).
    consentFor,
    grantFor,
    // Whether ONE stored key is still granted FOR a tool (same identity,
    // still in the store, identity still serves the tool through the seam) —
    // the probe runner's stale-pin check.
    keyGrantedForTool,
    listTools,
    appendUsage,
    // BET-1396: §7.5 probe-runner surface (read the row, fold vitality /
    // relevance, append failure evidence). toolRow is a pure read — it never
    // touches the write mutex (must never queue behind an in-flight scan).
    toolRow,
    // The identity set a name resolves to (the grant's own resolution) — the
    // seam consumers outside this module key their name-spaced state by.
    identitiesFor,
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

// ctoToolRegistry.mjs — §7.2 registry + fusion + lifecycle + connect asks
// (BET-1395).
//
// The registry fuses the four §7.1 evidence channels into ONE row per tool
// identity ("one identity, one row"), derives engagement, runs the two
// lifecycle bars, and raises §7.4 connect asks as needs-you decision cards:
//
//   observed (evidence accumulates) → candidate (either axis crosses its bar:
//     engagement ≥3 uses across ≥2 weeks; OR the vitality path — a credential
//     exists at all) → ONE connect ask (Connect read-only / Not now / Never)
//     → integrated (probes run — §7.5, a later issue; this module only grants
//     the metadata consent ring).
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

export const TOOL_REGISTRY_VERSION = 1;
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
// The classification task class (§12.1 — cheapest nano tier).
export const TOOL_CLASSIFY_TASK_CLASS = "ambient-summarize";

const DAY_MS = 24 * 3_600_000;
const EWMA_TAU_DAYS = 7; // engagement EWMA decay constant (1-week τ)

export function emptyConsent() {
  return { metadata: null, deep_read: null, write: null };
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

function baseTool(identity, ts) {
  return {
    tool: identity,
    displayName: humanize(identity),
    source: "catalog",
    raw: false,
    unclassifiable: false,
    firstSeenTs: ts,
    lastSeenTs: ts,
    ewmaAt: ts,
    uses: 0,
    weeksActive: 0,
    weeks: [],
    perProject: {},
    ewmaPerWeek: 0,
    evidence: [],
    status: "observed",
    role: null, // §7.3 quadrants need vitality probes (§7.5) — derived later
    consent: emptyConsent(),
    askRound: 0,
    askAtUses: 0,
    reArmAt: null,
    llmAt: null,
    relevance: {}, // §7.6 blackboard match — refreshed weekly (later issue)
    as_source: { reports: 0, accepted: 0 }, // §7.2 counters — fed by §9.5 later
    as_workflow: { suggestions: 0, accepted: 0 },
  };
}

// Engagement EWMA decay applied lazily (single application via the `ewmaAt`
// watermark): `ewma *= exp(-Δdays/τ)`.
export function decayEwma(tool, nowMs) {
  const from = tool?.ewmaAt ?? tool?.lastSeenTs ?? nowMs;
  const deltaDays = (nowMs - from) / DAY_MS;
  if (!(deltaDays > 0)) return tool?.ewmaPerWeek ?? 0;
  return (tool?.ewmaPerWeek ?? 0) * Math.exp(-deltaDays / EWMA_TAU_DAYS);
}

export function hasCredential(tool) {
  return (tool?.evidence ?? []).some((e) => e?.channel === "secret");
}

// The engagement bar (§7.4).
export function engagementBarMet(tool) {
  return (tool?.uses ?? 0) >= ENGAGEMENT_MIN_USES && (tool?.weeksActive ?? 0) >= ENGAGEMENT_MIN_WEEKS;
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
  const prevEwmaAt = tool.ewmaAt ?? tool.lastSeenTs ?? ts;
  const deltaDays = Math.max(0, ts - prevEwmaAt) / DAY_MS;
  tool.ewmaPerWeek = (tool.ewmaPerWeek ?? 0) * Math.exp(-deltaDays / EWMA_TAU_DAYS) + 1;
  tool.ewmaAt = Math.max(prevEwmaAt, ts);
  tool.uses += 1;
  tool.lastSeenTs = Math.max(tool.lastSeenTs ?? ts, ts);
  if (project) tool.perProject[project] = (tool.perProject[project] ?? 0) + 1;
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
  } = deps;

  async function loadPayload() {
    try {
      const p = await registryStore.load();
      return {
        v: TOOL_REGISTRY_VERSION,
        tools: Array.isArray(p?.tools) ? p.tools : [],
        lastScanTs: Number.isFinite(p?.lastScanTs) ? p.lastScanTs : null,
        lastFusedTs: Number.isFinite(p?.lastFusedTs) ? p.lastFusedTs : null,
        lastAskDay: typeof p?.lastAskDay === "string" ? p.lastAskDay : null,
      };
    } catch {
      return { v: TOOL_REGISTRY_VERSION, tools: [], lastScanTs: null, lastFusedTs: null, lastAskDay: null };
    }
  }

  async function savePayload(payload) {
    await registryStore.save(payload);
  }

  async function ledgerLog(entry) {
    try {
      await ledger.append({ actor: ACTOR, ts: now(), ...entry });
    } catch {
      /* best-effort */
    }
  }

  // Append evidence rows to the bounded usage log (all channels funnel here —
  // the §7.1 log). Returns the number of rows appended.
  async function appendUsage(rows) {
    if (!rows.length) return 0;
    const payload = (await usageStore.load().catch(() => ({}))) ?? {};
    const prev = Array.isArray(payload.rows) ? payload.rows : [];
    await usageStore.save({ ...payload, rows: [...prev, ...rows].slice(-USAGE_ROWS_CAP) });
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
      canon.lastSeenTs = Math.max(canon.lastSeenTs ?? 0, target.lastSeenTs ?? 0);
      canon.firstSeenTs = Math.min(canon.firstSeenTs ?? Infinity, target.firstSeenTs ?? Infinity);
      canon.ewmaPerWeek = (canon.ewmaPerWeek ?? 0) + (target.ewmaPerWeek ?? 0);
      for (const [p, n] of Object.entries(target.perProject ?? {})) {
        canon.perProject[p] = (canon.perProject[p] ?? 0) + n;
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
      const deltaDays = (nowMs - (t?.ewmaAt ?? t?.lastSeenTs ?? nowMs)) / DAY_MS;
      if (deltaDays > 0) {
        t.ewmaPerWeek = (t?.ewmaPerWeek ?? 0) * Math.exp(-deltaDays / EWMA_TAU_DAYS);
        t.ewmaAt = nowMs;
        changed = true;
      }
    }

    // Promote observed → candidate when either axis crosses its bar.
    for (const t of payload.tools) {
      if (t?.status === "observed" && barCrossed(t)) {
        t.status = "candidate";
        changed = true;
        await ledgerLog({ kind: "cto.tool.candidate", tool: t.tool, uses: t.uses, weeksActive: t.weeksActive });
      }
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
            const fresh = (t?.uses ?? 0) > (t?.askAtUses ?? 0) + REARM_FRESH_USES;
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
    }

    return { changed, asked };
  }

  // The daily batch (§7.1-2/3 + §7.3). First scan after install runs over the
  // cold-start backfill range; later scans run since the previous watermark.
  // Returns `{ok, scanned, asked}`.
  async function dailyScan() {
    const nowMs = now();
    const untilTs = nowMs;
    const payload = await loadPayload();
    const sinceTs =
      payload.lastScanTs ??
      (Number.isFinite(backfillStartInstant) ? backfillStartInstant : nowMs - 30 * DAY_MS);

    const rows = [];
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
    const { changed, asked } = await lifecycleStep(payload);
    payload.lastScanTs = untilTs;
    await savePayload(payload);
    if (changed || asked) {
      await ledgerLog({ kind: "cto.tool.scan", asked: asked ?? null });
    }
    return { ok: true, scanned: rows.length, asked: asked ?? null };
  }

  // Resolve a connect ask (§7.4 three-way). Writes the consent ring, the
  // §9.5 verdict (accept / dismiss / never), and resolves the open card.
  async function resolveConnect({ tool, answer } = {}) {
    const id = typeof tool === "string" ? tool.trim().toLowerCase() : "";
    if (!id) return { ok: false, error: "missing tool" };
    if (answer !== "connect" && answer !== "not-now" && answer !== "never") {
      return { ok: false, error: `invalid answer "${answer}"` };
    }
    const payload = await loadPayload();
    const t = payload.tools.find((x) => x?.tool === id);
    if (!t) return { ok: false, error: `unknown tool "${id}"` };
    const nowMs = now();
    t.consent = t.consent ?? emptyConsent();
    if (answer === "connect") {
      // The metadata ring is granted. Status stays `candidate` until probes
      // actually run (§7.5 flips it to `integrated` in a later issue).
      t.consent.metadata = "yes";
      t.reArmAt = null;
      await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "metadata", value: "yes" });
    } else if (answer === "not-now") {
      t.consent.metadata = "no";
      t.reArmAt = nowMs + NOT_NOW_REARM_MS;
      t.askAtUses = t.uses ?? 0;
      await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "metadata", value: "no" });
    } else {
      // Never: kills ALL rings and suppresses future asks (revocable only in
      // the §10.5 tool drill-down).
      t.consent = { metadata: "never", deep_read: "never", write: "never" };
      await ledgerLog({ kind: "cto.tool.consent", tool: id, ring: "metadata", value: "never" });
    }
    await savePayload(payload);

    // §9.5: every UI control that expresses a judgment writes exactly one
    // verdict. Connect → accept; Not now → dismiss; Never → never.
    if (typeof recordVerdict === "function") {
      try {
        if (answer === "connect") {
          await recordVerdict({ subject: { type: "tool", id, class: "tool-metadata" }, verdict: "accept" });
        } else if (answer === "not-now") {
          await recordVerdict({ subject: { type: "tool", id, class: "tool-metadata" }, verdict: "dismiss" });
        } else {
          await recordVerdict({ subject: { type: "tool", id, class: "tool-metadata" }, verdict: "never", never: true });
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

  // Read a consent ring for the future probe / tool-write gates (§7.4:
  // "metadata consent ≠ deep-read consent ≠ write").
  async function consentFor(tool, ring = "metadata") {
    const id = typeof tool === "string" ? tool.trim().toLowerCase() : "";
    if (!id) return null;
    const payload = await loadPayload();
    const t = payload.tools.find((x) => x?.tool === id);
    return t ? (t.consent?.[ring] ?? null) : null;
  }

  // Registry view for the §10.5 tool surfaces (read-only, stable shape).
  async function listTools() {
    const payload = await loadPayload();
    return payload.tools.map((t) => ({
      tool: t.tool,
      displayName: t.displayName ?? humanize(t.tool),
      status: t.status ?? "observed",
      role: t.role ?? null,
      uses: t.uses ?? 0,
      weeksActive: t.weeksActive ?? 0,
      ewmaPerWeek: Math.round((t.ewmaPerWeek ?? 0) * 100) / 100,
      lastSeenTs: t.lastSeenTs ?? null,
      firstSeenTs: t.firstSeenTs ?? null,
      consent: { ...emptyConsent(), ...(t.consent ?? {}) },
      askRound: t.askRound ?? 0,
    }));
  }

  return { dailyScan, resolveConnect, consentFor, listTools, appendUsage };
}

// Re-exported for callers that build rows by hand (tests, index.mjs wiring).
export { CHANNEL_TRANSCRIPT, CHANNEL_CONFIG, SCAN_ROW_CAP };

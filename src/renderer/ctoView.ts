// BET-1384: pure CTO-pane & sidebar derivation, extracted for testability.
// The CTO pane (§10) renders from a single `{kind:"ctoState"}` bus event
// (payload shape below) plus a `GET /api/cto/state` initial read. This module
// holds only deterministic mapping — no window.api, no React.
import type { Api } from "../shared/api";
import type { DelegateStartInput } from "../shared/types";

export type CtoDot = "active" | "disabled" | "thrifty" | "paused";

// Cold-start backfill (§10.6-4): informational progress for the learning card.
// Never a needs-you item — it does not count into the sidebar badge.
export type BackfillState = {
  done: number;
  total: number;
  startedAt: number | null;
  stopped: boolean;
  reason: string | null;
  stoppedAtDepthDays: number | null;
  active: boolean;
};

export type CtoState = {
  enabled: boolean;
  dot: CtoDot;
  pausedAt: number | null;
  needsYouCount: number;
  generationInFlight: boolean;
  tonightCount: number;
  // The A12 tier dial (§12.1) — BET-1419: tier-gated surfaces (the Tonight
  // line shows only at High) read it straight off the state event.
  tier?: string | null;
  backfill?: BackfillState;
};

// Server payload may omit backfill on older bridges; treat absent as idle.
export const idleBackfill: BackfillState = {
  done: 0,
  total: 0,
  startedAt: null,
  stopped: false,
  reason: null,
  stoppedAtDepthDays: null,
  active: false,
};

// A Health-card P1 row (§10.5 card 2). `n` = samples seen, `min` = minimum
// sample size before the value may be trusted. While `n < min` the renderer
// shows `collecting (n/k)` and never the number — a stat never displays noise
// as signal.
export type CtoHealthStat = {
  id:
    | "ambientSpendToday"
    | "digestOpens"
    | "pipelineLag"
    | "suggestionAcceptance"
    // BET-1400 rows (rendered since their server stats landed):
    | "forecastAccuracy"
    | "capHitsCaused"
    | "reserveFractile"
    // BET-1405 (§12.4): the monthly ROI self-report roll.
    | "roi";
  label: string;
  value: string | null;
  n: number;
  min: number;
  // BET-1405: when a not-ready row needs a specific collecting sentence
  // (e.g. the ROI row's `collecting — first report <date>`), the server
  // supplies it verbatim; otherwise the generic `collecting (n / min)` renders.
  collectingText?: string;
};

// Pure stat-display selector (§10.5): when a stat has not reached its minimum
// sample size, render `collecting (n / min)` — or the stat's own
// `collectingText` when the server supplied one — instead of the (possibly
// noisy) value. Returns the ready flag so the caller can de-emphasize
// collecting rows.
export function statDisplay(stat: CtoHealthStat): { text: string; ready: boolean } {
  const ready = stat?.n >= stat?.min && typeof stat?.value === "string" && stat.value !== "";
  if (!ready) {
    return {
      text: stat?.collectingText ?? `collecting (${stat?.n ?? 0} / ${stat?.min ?? 0})`,
      ready: false,
    };
  }
  return { text: stat.value as string, ready: true };
}

// Pure state→banner selector (§10.6-5): the paused banner (paused-at time +
// "no probes, no jobs…" + Resume) REPLACES the overview header exactly when
// the engine reports the kill switch is active (`dot === "paused"`). A null /
// pre-pairing state (dot undefined) is never paused. `pausedAt` is the
// epoch-ms the kill switch was thrown, for the banner's "paused at" line.
export function showPausedBanner(state: CtoState | null): boolean {
  return state?.dot === "paused";
}

// ---------------------------------------------------------------------------
// Tonight's-budget card (§10.5 card 3) — BET-1405. Pure selectors over the
// config + budget payload + usage snapshots; the card component renders them.
// ---------------------------------------------------------------------------

export type TonightBudgetMode = "full" | "ambient";

export type TonightBudgetGate = {
  tier?: "low" | "medium" | "high" | null;
  overnightOn?: boolean | null;
};

// Render-mode selection (§10.5 card 3): the full gauge (night pool, planned
// tonight, reserve line) renders ONLY at High with Overnight on. Below that,
// the card shows ambient spend vs cap only — never a gauge for a pool that
// cannot run (overnight is off, there is no pool to spend).
export function tonightBudgetMode(gate: TonightBudgetGate | null): TonightBudgetMode {
  return gate?.tier === "high" && gate?.overnightOn === true ? "full" : "ambient";
}

export type NightGaugeInput = {
  nightCapUsd: number;
  usedTodayUsd: number;
  plannedTonightUsd: number | null;
  reserveFrac: number | null;
};

export type NightGauge = {
  poolUsd: number;
  usedUsd: number;
  plannedUsd: number;
  reserveLineUsd: number | null;
  overflow: boolean;
};

/**
 * The night-pool gauge (§10.5 card 3): axis $0 → `ctoNightCapUsd`; segments
 * [used today][planned tonight] and the reserve line at the fractile — the
 * pool share held back at the binding provider's active reserve (null when no
 * windowed reserve exists). All inputs clamp into the pool; `overflow` flags
 * a used+planned that exceeds it (the gauge never silently truncates).
 */
export function nightGauge(input: NightGaugeInput): NightGauge {
  const pool = Math.max(0, Number(input?.nightCapUsd) || 0);
  const used = Math.max(0, Number(input?.usedTodayUsd) || 0);
  const planned = input?.plannedTonightUsd != null ? Math.max(0, Number(input.plannedTonightUsd) || 0) : 0;
  const overflow = used + planned > pool + 1e-9;
  const usedClamped = Math.min(used, pool);
  const plannedClamped = Math.min(planned, Math.max(0, pool - usedClamped));
  const reserveRaw = Number(input?.reserveFrac);
  const reserveLineUsd =
    input?.reserveFrac != null && Number.isFinite(reserveRaw) ? Math.max(0, Math.min(1, reserveRaw)) * pool : null;
  return { poolUsd: pool, usedUsd: usedClamped, plannedUsd: plannedClamped, reserveLineUsd, overflow };
}

/** Today's spend from the budget payload (the same day buckets the server
 *  meters into; day rolls at the viewer's local midnight). */
export function budgetTodayUsd(
  payload: { days?: Record<string, { usd?: number } | undefined> } | null | undefined,
  now = Date.now(),
): number {
  const d = new Date(now);
  const key = String(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  const usd = Number(payload?.days?.[key]?.usd);
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/** The binding windowed reserve (fraction) — the largest reserve among the
 *  persisted quota rows with an active reserve; null when none (windowless
 *  providers hold no reserve — no line renders). */
export function bindingReserveFrac(
  quotaRows: Record<string, { provider?: string; mode?: string | null; reserve?: number | null } | undefined> | null | undefined,
): number | null {
  if (!quotaRows || typeof quotaRows !== "object") return null;
  let best: number | null = null;
  for (const q of Object.values(quotaRows)) {
    if (!q || q.mode === "windowless") continue;
    const r = Number(q.reserve);
    if (!Number.isFinite(r)) continue;
    if (best == null || r > best) best = r;
  }
  return best;
}

export type ProviderWindowNote = { provider: string; label: string; resetsAt: number | null };
export type UsageWindowLike = { kind?: string; label?: string; resetsAt?: number | null };
export type UsageSnapshotLike = { provider?: string; windows?: UsageWindowLike[] | null };

/** Per-provider plan-window notes for the card's legend (§10.5 card 3):
 *  window label + reset instant from the usage poller's snapshots. Capped at
 *  `max` notes to keep the card a card. */
export function providerWindowNotes(snapshots: UsageSnapshotLike[] | null | undefined, max = 6): ProviderWindowNote[] {
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  const notes: ProviderWindowNote[] = [];
  for (const s of snaps) {
    const provider = typeof s?.provider === "string" && s.provider ? s.provider : null;
    if (!provider) continue;
    const windows = Array.isArray(s?.windows) ? s.windows : [];
    for (const w of windows) {
      if (!w) continue;
      const label = typeof w.label === "string" && w.label ? w.label : typeof w.kind === "string" ? w.kind : "";
      notes.push({ provider, label, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null });
    }
  }
  return notes.slice(0, Math.max(0, max));
}

export type ForecastAccuracyRow = { provider: string; mape14: number };

/** Forecast-accuracy rows (§14.5 cache) from the persisted quota state — only
 *  providers with a numeric 14-day MAPE speak; the rest are absent (never
 *  rendered as 0%). */
export function forecastAccuracyRows(
  quotaRows: Record<string, { provider?: string; mape14?: number | null } | undefined> | null | undefined,
): ForecastAccuracyRow[] {
  if (!quotaRows || typeof quotaRows !== "object") return [];
  const rows: ForecastAccuracyRow[] = [];
  for (const q of Object.values(quotaRows)) {
    if (!q || typeof q.provider !== "string" || !q.provider) continue;
    // typeof guard, not Number(): Number(null) === 0 would render an absent
    // forecast as a perfect 0% MAPE.
    if (typeof q.mape14 !== "number" || !Number.isFinite(q.mape14)) continue;
    rows.push({ provider: q.provider, mape14: q.mape14 });
  }
  return rows;
}

// State-dot tone (§10.1): active/disabled/thrifty/paused → ok/tx4/warn/danger.
// StatusDot's tones are ok/running/error/warn/idle; disabled maps to idle
// (bg-text-quiet = the quiet text tier), which is the tx4 analogue.
export function dotTone(dot: CtoDot | undefined): "ok" | "idle" | "warn" | "error" {
  switch (dot) {
    case "active":
      return "ok";
    case "thrifty":
      return "warn";
    case "paused":
      return "error";
    case "disabled":
    default:
      return "idle";
  }
}

// Sidebar badge (§10.1): count of open needs-you items only, hidden at zero.
// Returns null when there is nothing to show so the caller can omit the badge.
export function badgeLabel(state: CtoState | null | undefined): number | null {
  const n = state?.needsYouCount ?? 0;
  return n > 0 ? n : null;
}

// Status-dot visibility, independent of tone: always shown on the sidebar
// entry (the dot reflects enabled/disabled/thrifty/paused), so a null state
// defaults to the disabled (gray) tone rather than disappearing.
export function showDot(): boolean {
  return true;
}

// Digest-now button (§10.2): joins/starts the single-flight generation and
// renders the server's generation-in-flight flag as its spinner, so two
// views/devices can never double-generate. Busy ⇒ clicking is a no-op.
export function digestBusy(state: CtoState | null | undefined): boolean {
  return state?.generationInFlight === true;
}

// The backfill learning-card view (§10.6-4) — derived purely from the state
// so the component stays a dumb renderer. Returns null when there is nothing
// to show (never started, or completed cleanly).
export type BackfillCardView = {
  done: number;
  total: number;
  pct: number; // 0..1
  etaMs: number | null; // extrapolated wall ETA
  stopped: boolean;
  reason: string | null;
  stoppedAtDepthDays: number | null;
  // Active = a backfill is running right now. When stopped, the card still
  // renders (with the reason) so the "stopped at depth" is visible; a clean
  // completion shows nothing.
  show: boolean;
};

export function backfillCardView(state: CtoState | null | undefined): BackfillCardView | null {
  const b = state?.backfill;
  if (!b) return null;
  const total = Math.max(0, b.total || 0);
  const done = Math.max(0, Math.min(b.done || 0, total || b.done || 0));
  let etaMs: number | null = null;
  if (done > 0 && total > done && b.startedAt && Date.now() > b.startedAt) {
    const rate = (Date.now() - b.startedAt) / done;
    etaMs = Math.max(0, Math.round(rate * (total - done)));
  }
  return {
    done,
    total,
    pct: total > 0 ? done / total : 0,
    etaMs,
    stopped: !!b.stopped,
    reason: b.reason ?? null,
    stoppedAtDepthDays: b.stoppedAtDepthDays ?? null,
    show: !!b.active || !!b.stopped,
  };
}

// Human "~1h 12m" style ETA for the learning card.
export function formatEta(etaMs: number | null): string | null {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return null;
  const totalMin = Math.max(1, Math.round(etaMs / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `~${m}m`;
  if (m === 0) return `~${h}h`;
  return `~${h}h ${m}m`;
}

// BET-1385: overview sections (§10.3/§10.4/§10.6). Only deterministic mapping
// lives here — no window.api, no React; the components in `ctoSections.tsx`
// consume these pure derivations.

// The open needs-you card a Blocker section row renders (§10.3). Kept as a
// structural subset of the wire `CtoCard` so the component + tests don't need
// every field.
export type BlockerCard = {
  id: string;
  title: string;
  body: string;
  sourceKind: string;
  sourceId: string | null;
  sessionID: string | null;
  pendingSince: number;
  refs: string[];
};

// Readable relative time (age stamps, Just-finished relative time). Short
// forms: "<1m", "<Nm", "<Nh", "Nd". Pure + deterministic for a given clock.
export function relativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return "";
  const d = Math.max(0, now - ts);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (d < MIN) return "<1m";
  if (d < HOUR) return `<${Math.floor(d / MIN)}m`;
  if (d < DAY) return `<${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / DAY)}d`;
}

// The Blocker card's Answer-now action (§10.3). Pure resolution:
//   - question/permission → navigate to the owning session (the in-session
//     question card is focused via the existing manta-scroll-to-question
//     bridge in the component).
//   - inbox-note / health → no fix-surface navigation exists in the renderer
//     yet, so these resolve to the ledger fallback (the §10.3 honest route).
// When the card's target session no longer exists (or is absent), fall back
// to opening the matching ledger entry via an inline modal.
export type BlockerAction =
  | { action: "session"; sessionID: string }
  | { action: "ledger" };

export function blockerTarget(
  card: BlockerCard,
  knownSessions: Set<string>,
): BlockerAction {
  const sourceKind = card?.sourceKind ?? "";
  const isSessionTarget = sourceKind !== "inbox" && sourceKind !== "health";
  if (isSessionTarget) {
    return card.sessionID && knownSessions.has(card.sessionID)
      ? { action: "session", sessionID: card.sessionID }
      : { action: "ledger" };
  }
  return { action: "ledger" };
}

// A Just-finished rail entry (§10.4) drives its primary action ("open" a turn's
// session; "logs" a gate-failed job's failure detail in an inline surface) or,
// for a done job, NO action yet — branch/PR-open has no surface until the
// settings/forge page lands, so a done job renders no dead button.
export type FinishedVariant =
  | { action: "open" }
  | { action: "logs" }
  | { action: "none" };

export function finishedVariant(item: {
  kind: string;
  status?: string | null;
}): FinishedVariant {
  if (item?.kind === "job") {
    return item.status === "failed" ? { action: "logs" } : { action: "none" };
  }
  return { action: "open" };
}

// Digest tier → chip tone (§10.4). Maps the tier lattice blessedly collapsibly
// onto the statusdot/status-chip fill tones.
export function digestTone(tier: string | undefined): "ok" | "info" | "warn" | "danger" | "idle" {
  const t = tier && tier.trim().toLowerCase();
  if (!t) return "idle";
  if (["need", "blocker", "urgent"].includes(t)) return "danger";
  if (["tonight", "plan"].includes(t)) return "warn";
  if (["great", "progress", "met", "done"].includes(t)) return "ok";
  if (["info", "aware", "fact"].includes(t)) return "info";
  return "idle";
}

// Is an item expandable (has a `deep` technical layer)? §10.4.
export function digestExpandable(item: { deep?: string | null } | null | undefined): boolean {
  return typeof item?.deep === "string" && item.deep.trim().length > 0;
}

// Resting state (§10.6-1): "Nothing needs you ✓" renders only when there are
// no open needs-you cards AND all rails/digest are empty. Digest presence is
// passed as `digestHasItems` so an empty-but-present digest counts as empty.
export function resting(
  inputs: {
    cards?: BlockerCard[] | null;
    nowActive?: unknown[] | null;
    finished?: unknown[] | null;
    digestHasItems?: boolean;
  } = {},
): boolean {
  const cards = inputs.cards ?? [];
  const nowActive = inputs.nowActive ?? [];
  const finished = inputs.finished ?? [];
  return cards.length === 0 && nowActive.length === 0 && finished.length === 0 && !inputs.digestHasItems;
}

// Now-rail/digest shared: does the list of sessions have any blocked one — the
// "blocked — question above ↑" chip on a blocked Now card (never repeats the
// question).
export function stateTone(state: "working" | "blocked"): "ok" | "warn" {
  return state === "blocked" ? "warn" : "ok";
}

// Now-rail cost formatting (§10.4). A session's accumulated cost (USD) as a
// short `$X.XX` label, or null when absent/zero/NaN so the caller can omit the
// segment entirely (component may also choose how granular to show it).
export function nowCostLabel(cost: number | null | undefined): string | null {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
  return `$${cost.toFixed(2)}`;
}

// Now-rail meta composition (§10.4): `project · cost · elapsed`. The cost
// segment sits between the project name and the elapsed time and is dropped
// when absent (no `· ·` gap in the line). Pure + deterministic for tests.
export function nowRailMeta(project: string, cost: string | null, elapsed: string | null): string {
  return [project, cost, elapsed].filter((s): s is string => Boolean(s && s.length > 0)).join(" · ");
}

// ---------------------------------------------------------------------------
// BET-1392 — decision cards (§9.1 / §10.3) + the §14.3 silence audit
// ---------------------------------------------------------------------------

// The closed enum of bound-action option types (§9.1).
export type SuggestionActionType =
  | "config-change"
  | "queue-tonight"
  | "start-job"
  | "tool-write"
  | "record-decision";

// A structural subset of the wire `CtoCard` for the decision card — the
// component + tests don't need every card field.
export type DecisionCardRow = {
  id: string;
  variant: "decision";
  title: string;
  why?: string;
  cls?: string;
  score?: number;
  capped?: boolean;
  options?: { label: string; action: { type: string; payload: Record<string, unknown> } }[];
  evidence?: string[];
  refs?: string[];
};

// §9.1 worthiness gate (server-computed). A capped card was surfaced during
// cold start; surfaced with a ≥ p_ask probability.
export function suggestionConfidence(card: DecisionCardRow): number | null {
  const s = card?.score;
  return Number.isFinite(s) ? (s as number) : null;
}

// Selector: the open decision cards among the wire cards (the rest of the
// store stays the Blocker section's).
export function decisionCards(cards: ReadonlyArray<Record<string, unknown>>): DecisionCardRow[] {
  return (cards ?? []).filter((c) => c?.variant === "decision") as DecisionCardRow[];
}

// BET-1419: the open veto card (§10.3) among the wire cards — the overnight
// run's 30-min countdown. Structural subset of the wire CtoCard.
export type VetoCardRow = {
  id: string;
  title: string;
  body: string;
  dueMs: number | null;
  options: { label: string; action: { type: string; payload: Record<string, unknown> } }[];
};

export function vetoCards(cards: ReadonlyArray<Record<string, unknown>>): VetoCardRow[] {
  return (cards ?? []).filter((c) => c?.variant === "veto").map((c) => ({
    id: String(c.id ?? ""),
    title: String(c.title ?? ""),
    body: String(c.body ?? ""),
    dueMs: Number.isFinite(c.dueMs) ? (c.dueMs as number) : null,
    options: Array.isArray(c.options) ? (c.options as VetoCardRow["options"]) : [],
  }));
}

// BET-1395: the open connect-ask cards (§10.3 connect variant) among the wire
// cards — tool name + why + evidence trail + the three-way answer bound as
// `tool-connect` actions (the registry is the executor, always runnable).
export type ConnectCardRow = {
  id: string;
  title: string;
  body: string;
  evidence?: string[];
  options: { label: string; answer: string; action: { type: string; payload: Record<string, unknown> } }[];
};

export function connectCards(cards: ReadonlyArray<Record<string, unknown>>): ConnectCardRow[] {
  return (cards ?? [])
    .filter((c) => c?.variant === "connect")
    .map((c) => ({
      id: String(c.id ?? ""),
      title: String(c.title ?? ""),
      body: String(c.body ?? ""),
      evidence: Array.isArray(c.evidence) ? (c.evidence as string[]) : [],
      options: Array.isArray(c.options)
        ? (c.options as { label?: string; answer?: string; action?: { type?: string; payload?: Record<string, unknown> } }[]).map(
            (o) => ({
              label: String(o?.label ?? ""),
              answer: String(o?.answer ?? ""),
              action: { type: String(o?.action?.type ?? ""), payload: (o?.action?.payload ?? {}) as Record<string, unknown> },
            }),
          )
        : [],
    }));
}

// Live countdown to a veto card's `dueMs`: the ms remaining (≥ 0), or null
// when there is no due time or it already elapsed (the card resolves server-
// side; the client just hides the countdown rather than reading negative).
export function countdownRemaining(dueMs: unknown, now: number): number | null {
  if (!Number.isFinite(dueMs) || !Number.isFinite(now)) return null;
  const d = (dueMs as number) - now;
  return d > 0 ? d : null;
}

// §10.4 Tonight line visibility: hidden entirely when nothing is queued or
// High tier is off. Pure so the component + tests share one rule.
export function tonightVisible(tonightCount: number | undefined, tier: string | undefined): boolean {
  if (!Number.isFinite(tonightCount) || (tonightCount as number) <= 0) return false;
  return tier === "high";
}

// §9.1 P2 option viability: which action types have a runnable executor in P2.
// BET-1419: `queue-tonight` is now runnable (the tonight queue + §11 overnight
// execution are wired). `tool-write` stays non-runnable until the §7.4 tool
// registry lands — with the empty write ring the server never emits one, so
// no dead control is ever rendered.
const RUNNABLE_TYPES: Record<string, boolean> = {
  "config-change": true,
  "start-job": true,
  "record-decision": true,
  "queue-tonight": true,
  "tool-write": false,
};

export function runnableSuggestionOption(option: {
  action?: { type?: string };
} | null | undefined): boolean {
  return RUNNABLE_TYPES[option?.action?.type ?? ""] === true;
}

// The minimal renderer API surface the option executors need — injected so the
// executors stay pure + testable (no window.api import here). Derived from the
// shared Api type (single source of truth — the method shapes live only in
// shared/api.ts).
export type SuggestionApi = Pick<Api, "configUpdate" | "delegateStart" | "ctoFact" | "ctoTonightAct">;

// Execute one bound action. Confirmation (the config-change diff modal) is a
// UI concern the caller resolves BEFORE calling this — this is pure side-effect
// execution, reported `{ok, error}` for the toast. Non-runnable types fail
// closed (never a dead silent no-op).
export async function executeSuggestionOption({
  option,
  api,
}: {
  option: { label?: string; action?: { type?: string; payload?: Record<string, unknown> } };
  api: SuggestionApi;
}): Promise<{ ok: boolean; error?: string }> {
  const type = option?.action?.type as SuggestionActionType | undefined;
  const payload: Record<string, unknown> = option?.action?.payload ?? {};
  try {
    switch (type) {
      case "config-change": {
        const patch = (payload.patch ?? {}) as Record<string, unknown>;
        if (!patch || typeof patch !== "object") return { ok: false, error: "config-change needs a patch payload" };
        await api.configUpdate(patch);
        return { ok: true };
      }
      case "start-job": {
        const prompt = typeof payload.prompt === "string" && payload.prompt ? payload.prompt : "";
        const sessionID = typeof payload.sessionID === "string" ? payload.sessionID : "";
        const directory = typeof payload.directory === "string" ? payload.directory : "";
        if (!prompt || !sessionID || !directory) return { ok: false, error: "start-job needs prompt, sessionID and directory payload" };
        const input: DelegateStartInput = { prompt, sessionID, directory };
        if (payload.model && typeof payload.model === "object") {
          // Runtime-shaped coercion: the bound payload is untyped JSON, the
          // shared input type is not (model: {providerID?, modelID?} | null).
          const m = payload.model as { providerID?: unknown; modelID?: unknown };
          input.model = {
            ...(typeof m.providerID === "string" ? { providerID: m.providerID } : {}),
            ...(typeof m.modelID === "string" ? { modelID: m.modelID } : {}),
          };
        }
        await api.delegateStart(input);
        return { ok: true };
      }
      case "record-decision": {
        const statement = typeof payload.statement === "string" && payload.statement ? payload.statement : "";
        if (!statement) return { ok: false, error: "record-decision needs a statement payload" };
        const refs = Array.isArray(payload.refs) ? (payload.refs as string[]) : [];
        const r = await api.ctoFact({ kind: "decision", statement, refs });
        return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "record-decision failed" };
      }
      case "queue-tonight": {
        // BET-1419: queue the task for tonight (§10.4). The card's context
        // (cls/score) is captured at accept time so the overnight portfolio
        // scores it without re-asking the generator.
        const name = typeof payload.name === "string" && payload.name ? payload.name : option?.label ?? "";
        if (!name) return { ok: false, error: "queue-tonight needs a name payload" };
        const r = await api.ctoTonightAct({
          action: "add",
          task: {
            name,
            prompt: typeof payload.prompt === "string" && payload.prompt ? payload.prompt : name,
            project: typeof payload.project === "string" ? payload.project : null,
            value: typeof payload.value === "number" ? payload.value : undefined,
            confidence: typeof payload.confidence === "number" ? payload.confidence : undefined,
            predictedCost: typeof payload.cost === "number" ? payload.cost : undefined,
            refs: Array.isArray(payload.refs) ? (payload.refs as string[]) : [],
            cls: typeof payload.cls === "string" ? payload.cls : "queue-tonight",
          },
        });
        return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "queue-tonight failed" };
      }
      default:
        return { ok: false, error: `unsupported action type: ${String(type ?? "")}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

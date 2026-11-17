// Pure copy + formatting for the background work budget (spec 2026-11-17-background-work-budget.md
// §10, with §17.20/§17.21, and the follow-ups spec §2): the Settings card, the one-line status in the Knowledge card and the CTO
// pane, and the CTO thrifty banner all speak through these helpers, so the words never drift.

import { formatTokens } from "../shared/formatTokens.mjs";
import type {
  BackgroundWorkLevel,
  BudgetPaused,
  BudgetPlanStatus,
  BudgetStatus,
  BudgetWindow,
} from "../shared/api";

/** The most the API-key cap can be set to (the box validates the same range). */
export const BACKGROUND_CAP_MAX_USD = 100;

export const LEVEL_OPTIONS: ReadonlyArray<{ id: BackgroundWorkLevel; label: string }> = [
  { id: "off", label: "Off" },
  { id: "light", label: "Light" },
  { id: "normal", label: "Normal" },
];

export const levelLabel = (l: BackgroundWorkLevel): string => LEVEL_OPTIONS.find((o) => o.id === l)?.label ?? l;

/** Help text under the level control, with the §6.4 limits in plain words. */
export const LEVEL_HELP =
  "Uses spare plan quota only: up to 5% of a week and 10% of a 5-hour window on Normal (2% and 5% on Light). " +
  "Background work pauses while you're using a window heavily.";
export const LEVEL_LIMITS_HELP =
  "Shares are estimated from token counts, so cached context counts in full and the figure errs on the high side. " +
  "A window already in use when Manta first sees it starts counting from zero.";
export const CAP_HELP = "0 turns background work off on API keys.";
export const RUN_WHEN_BUSY_LABEL = "Keep running when my plan is busy";
export const RUN_WHEN_BUSY_HELP =
  "Background work still stays within its share (5% of a week on Normal), but no longer waits when your own usage is high.";
/** What the Knowledge card, the CTO pane and the Settings card call themselves in a paused sentence. */
export const DEFAULT_SUBJECT = "Background work";

// ---- the cap input ----------------------------------------------------------------------------

export type CapParse = { ok: true; value: number } | { ok: false; error: string };

/** Dollars, whole cents, 0 (none) up to BACKGROUND_CAP_MAX_USD. */
export function parseApiKeyCap(text: string): CapParse {
  const t = text.trim().replace(/^\$/, "");
  if (t === "") return { ok: false, error: "Enter a daily cap in dollars, for example 5.00." };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false, error: "Use a dollar amount with up to two decimals, for example 5.00." };
  const value = Number(t);
  if (!Number.isFinite(value)) return { ok: false, error: "Use a dollar amount with up to two decimals, for example 5.00." };
  if (value > BACKGROUND_CAP_MAX_USD) return { ok: false, error: `The cap can't be more than $${BACKGROUND_CAP_MAX_USD}.` };
  return { ok: true, value };
}

export const formatUsd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
/** "$5" for a whole number, else "$5.50". */
export const formatUsdShort = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? `$${r}` : `$${r.toFixed(2)}`;
};
/** The text the cap input shows for a stored value. */
export const capInputText = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** A percent of a window: whole numbers, "<1%" for a trace, "0%" for none. */
export function formatPct(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0%";
  if (v < 1) return "<1%";
  return `${Math.round(v)}%`;
}

// ---- times -------------------------------------------------------------------------------------

export type TimeFormat = { locale?: string; timeZone?: string };

function parts(ms: number, fmt: TimeFormat) {
  const get = (opts: Intl.DateTimeFormatOptions) => {
    const out: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat(fmt.locale ?? undefined, { ...opts, timeZone: fmt.timeZone }).formatToParts(ms)) out[p.type] = p.value;
    return out;
  };
  const clock = get({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = get({ weekday: "short", year: "numeric", month: "numeric", day: "numeric" });
  return { hh: clock.hour, mm: clock.minute, weekday: day.weekday, dayKey: `${day.year}-${day.month}-${day.day}` };
}

/**
 * A resume instant in the user's local time, ready to follow "resumes": "at midnight", "at 14:00" (today),
 * "Thu 09:00" (within a week) or "Mon Nov 24 09:00". Empty when unknown.
 */
export function formatResumes(ms: number | null | undefined, now: number = Date.now(), fmt: TimeFormat = {}): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const at = parts(ms, fmt);
  if (at.hh === "00" && at.mm === "00" && ms - now <= 24 * 3_600_000 + 60_000) return "at midnight";
  const today = parts(now, fmt);
  if (at.dayKey === today.dayKey) return `at ${at.hh}:${at.mm}`;
  if (ms - now < 6 * 24 * 3_600_000) return `${at.weekday} ${at.hh}:${at.mm}`;
  const date = new Intl.DateTimeFormat(fmt.locale ?? undefined, { month: "short", day: "numeric", timeZone: fmt.timeZone }).format(ms);
  return `${at.weekday} ${date} ${at.hh}:${at.mm}`;
}

// ---- windows and plans -------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A weekly-kind window: "weekly" or "weekly_scoped:*". Everything else is a short window. */
export const isWeeklyKind = (kind: string | undefined): boolean => typeof kind === "string" && (kind === "weekly" || kind.startsWith("weekly"));

/** Weekly by kind, or by length: a 7-day window an adapter reports as "session" is still a week (spec §6). */
export const isWeeklyWindow = (w: Pick<BudgetWindow, "kind" | "spanMs">): boolean =>
  isWeeklyKind(w.kind) || (typeof w.spanMs === "number" && w.spanMs >= 2 * DAY_MS);

const ADAPTER_NAMES: Record<string, string> = {
  claude: "Claude",
  anthropic: "Claude",
  codex: "ChatGPT",
  openai: "ChatGPT",
  kimi: "Kimi",
};

export function planName(plan: Pick<BudgetPlanStatus, "adapter" | "planLabel">): string {
  if (plan.planLabel) return plan.planLabel;
  const key = plan.adapter.toLowerCase();
  return ADAPTER_NAMES[key] ?? (key ? key[0].toUpperCase() + key.slice(1) : "Plan");
}

const nearSpan = (span: number, target: number): boolean => Math.abs(span - target) <= target * 0.1;

/** "week", "5-hour window", or "<label> window" from the window's length; the kind when the length is unknown. */
function windowNoun(w: Pick<BudgetWindow, "kind" | "label" | "spanMs">): string {
  const span = typeof w.spanMs === "number" && w.spanMs > 0 ? w.spanMs : null;
  if (span !== null) {
    if (nearSpan(span, 5 * HOUR_MS)) return "5-hour window";
    if (nearSpan(span, 7 * DAY_MS) && (w.kind === "weekly" || !isWeeklyKind(w.kind))) return "week";
    if (w.label) return `${w.label} window`;
    return span >= DAY_MS ? `${Math.round(span / DAY_MS)}-day window` : `${Math.max(1, Math.round(span / HOUR_MS))}-hour window`;
  }
  if (w.kind === "weekly") return "week";
  if (w.kind === "session") return "5-hour window";
  if (isWeeklyKind(w.kind)) return w.label ? w.label.toLowerCase() : "week";
  return w.label ? w.label.toLowerCase() : w.kind;
}

const findWindow = (plan: BudgetPlanStatus | null | undefined, key: string | undefined): BudgetWindow | undefined =>
  key && plan ? plan.windows.find((w) => w.key === key) : undefined;

/** "this week" / "this 5-hour window". */
const thisWindow = (w: Pick<BudgetWindow, "kind" | "label" | "spanMs"> | undefined): string => `this ${w ? windowNoun(w) : "week"}`;

/** "your Claude week" / "your 5-hour window" — the window as the user owns it. */
function ownWindow(w: BudgetWindow | undefined, plan: BudgetPlanStatus | null): string {
  const noun = w ? windowNoun(w) : "week";
  return noun === "week" ? `your ${plan ? `${planName(plan)} ` : ""}week` : `your ${noun}`;
}

/** "2½ days", "5 hours": how long a window has been running, to half a day (hours under a day). */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < HOUR_MS) return "under an hour";
  if (ms < DAY_MS) {
    const h = Math.round(ms / HOUR_MS);
    if (h < 24) return h === 1 ? "1 hour" : `${h} hours`;
  }
  const halves = Math.max(1, Math.round((ms / DAY_MS) * 2) / 2);
  const whole = Math.floor(halves);
  return halves === 1 ? "1 day" : `${whole}${halves % 1 ? "½" : ""} days`;
}

/** Background share lines of one plan: "Background work used 2% of your Claude week · 4% of this 5-hour window". */
export function planUsageText(plan: BudgetPlanStatus): string | null {
  const ws = [...plan.windows].sort((a, b) => Number(isWeeklyWindow(b)) - Number(isWeeklyWindow(a)));
  if (ws.length === 0) return null;
  const name = planName(plan);
  const bits = ws.map((w, i) => {
    const noun = windowNoun(w);
    const phrase = noun === "week" ? `your ${name} week` : isWeeklyWindow(w) ? `your ${name} ${noun}` : `this ${noun}`;
    return i === 0 ? `Background work used ${formatPct(w.bgPct)} of ${phrase}` : `${formatPct(w.bgPct)} of ${phrase}`;
  });
  return bits.join(" · ");
}

/** "$1.20 of $5.00 today · $18.40 this month". */
export function paygUsageText(status: Pick<BudgetStatus, "dailyCapUsd" | "payg">): string {
  return `${formatUsd(status.payg.usdToday)} of ${formatUsd(status.dailyCapUsd)} today · ${formatUsd(status.payg.usdMonth)} this month`;
}

/** "Claude usage unavailable — limited by the $5 daily cap until it returns". */
export const fallbackText = (plan: Pick<BudgetPlanStatus, "adapter" | "planLabel">, dailyCapUsd: number): string =>
  `${planName(plan)} usage unavailable — limited by the ${formatUsdShort(dailyCapUsd)} daily cap until it returns`;

// ---- paused reasons ----------------------------------------------------------------------------

export type CopyContext = {
  plan?: BudgetPlanStatus | null;
  dailyCapUsd: number;
  now?: number;
  fmt?: TimeFormat;
  /** Who is waiting: "Knowledge", "The CTO" or the default "Background work". */
  subject?: string;
  /** The subject reads as a plural ("Larger jobs are waiting"). */
  plural?: boolean;
};

function reasonValue(p: BudgetPaused, w: BudgetWindow | undefined, pick: "pct" | "projected" | "cap"): number | null {
  if (typeof p.value === "number" && Number.isFinite(p.value)) return p.value;
  if (!w) return null;
  const v = pick === "pct" ? w.pct : pick === "projected" ? w.projectedPct : w.cap;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The sentence for a paused continuous-work reason (spec 2026-11-17-background-budget-followups §2). */
export function pausedCopy(p: BudgetPaused, ctx: CopyContext): string {
  const now = ctx.now ?? Date.now();
  const fmt = ctx.fmt ?? {};
  const plan = ctx.plan ?? null;
  const w = findWindow(plan, p.windowKey);
  const s = ctx.subject ?? DEFAULT_SUBJECT;
  const pl = ctx.plural === true;
  const be = pl ? "are" : "is";
  const it = pl ? "they" : "it";
  const It = pl ? "They" : "It";
  const resume = pl ? "resume" : "resumes";
  const at = (ms: number) => formatResumes(ms, now, fmt);
  const noun = w ? windowNoun(w) : "week";
  const resetWord = noun === "week" ? "the week" : "that window";
  const thing = ownWindow(w, plan);
  // "It resumes Sat 08:00 when the week resets." — said only when the instant is known.
  const resetClause = (ms: number | null | undefined) => (finite(ms) ? ` ${It} ${resume} ${at(ms)} when ${resetWord} resets.` : "");
  switch (p.reason) {
    case "off":
      return "Background work is off for your plans.";
    case "level-cap": {
      const cap = reasonValue(p, w, "cap");
      return `${s} ${pl ? "have" : "has"} used ${pl ? "their" : "its"} share of ${thing}${cap != null ? ` (${formatPct(cap)})` : ""}.${resetClause(p.resumesAt)}`;
    }
    case "window-busy": {
      const pct = reasonValue(p, w, "pct");
      const using = plan ? planName(plan) : "your plan";
      return `${s} ${be} waiting while you're using ${using} heavily: ${thing} is ${pct != null ? `${formatPct(pct)} used` : "busy"}.${resetClause(p.resumesAt)}`;
    }
    case "projected-high": {
      const proj = reasonValue(p, w, "projected");
      const pace = proj == null ? `on pace to use too much of it` : proj > 100 ? `on pace for more than the whole ${noun}` : `on pace to end at ${formatPct(proj)}`;
      const start = w?.windowStart;
      const elapsed = finite(start) && now > start ? formatElapsed(now - start) : "";
      const used = w && finite(w.pct) ? `you've used ${formatPct(w.pct)} ${elapsed ? `in ${elapsed}` : "so far"}, ${pace}.` : `${thing} is ${pace}.`;
      const reset = w?.resetsAt ?? null;
      const early = finite(p.resumesAt) && (reset == null || p.resumesAt < reset - 60_000);
      let tail = "";
      if (early) {
        tail = ` ${It} ${resume} ${at(p.resumesAt!)} if your usage slows${finite(reset) ? `, or ${at(reset)} when ${resetWord} resets` : ""}.`;
      } else {
        tail = resetClause(reset ?? p.resumesAt);
      }
      return `${s} ${be} waiting so ${it} ${pl ? "don't" : "doesn't"} use up ${thing}: ${used}${tail}`;
    }
    case "exhausted": {
      const what = noun === "week" ? `${plan ? `${planName(plan)} ` : ""}week` : noun;
      const when = finite(p.resumesAt) ? at(p.resumesAt) : "when it resets";
      return `Your ${what} is used up. ${s} ${resume} ${when}.`;
    }
    case "usd-cap":
      return `${s} reached today's ${formatUsd(ctx.dailyCapUsd)} API-key limit.${finite(p.resumesAt) ? ` ${It} ${resume} ${at(p.resumesAt)}.` : ""}`;
    case "unavailable":
      return `${s} ${be} waiting: the budget couldn't be read. ${It} will retry.`;
    default:
      return `${s} ${be} paused.`;
  }
}

/** The §17.20 copy for larger jobs that have used their share. `paused` is the plain continuous refusal, if any. */
export function batchPausedCopy(p: BudgetPaused, ctx: CopyContext, paused?: BudgetPaused | null): string | null {
  if (paused && paused.reason === p.reason) return null; // already said
  if (p.reason === "level-cap") {
    const plan = ctx.plan ?? null;
    const w = findWindow(plan, p.windowKey);
    const share = typeof p.value === "number" ? ` (${formatPct(p.value)})` : "";
    return `Larger jobs paused — they've used their share of ${thisWindow(w)}${share}; capture continues.`;
  }
  if (p.reason === "usd-cap") {
    return "Larger jobs paused — they've used their share of today's API-key cap; capture continues.";
  }
  return pausedCopy(p, { ...ctx, subject: "Larger jobs", plural: true });
}

const WORK_LABELS: Record<string, string> = {
  "knowledge-corrections": "Weekly corrections pass",
  "knowledge-tidy": "Weekly tidy",
  "knowledge-trial": "Skill trial",
  "cto-overnight": "Overnight work",
  "cto-backfill": "History backfill",
};

export function workTypeLabel(workType: string): string {
  return WORK_LABELS[workType] ?? workType.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export const waitingBatchText = (workType: string): string => `${workTypeLabel(workType)} waiting for a quiet moment`;

// ---- status rows -------------------------------------------------------------------------------

export type StatusTone = "info" | "warn";
export type StatusRow = { id: string; tone: StatusTone; text: string };

/** Every row the Settings card lists, in order: per plan, then API keys, then waiting batch jobs. */
export function statusRows(status: BudgetStatus, now: number = Date.now(), fmt: TimeFormat = {}): StatusRow[] {
  const rows: StatusRow[] = [];
  const cap = status.dailyCapUsd;
  for (const plan of status.plans) {
    const ctx: CopyContext = { plan, dailyCapUsd: cap, now, fmt };
    const id = `plan-${plan.adapter}`;
    if (plan.fallback) {
      rows.push({ id: `${id}-fallback`, tone: "warn", text: fallbackText(plan, cap) });
    } else {
      const usage = planUsageText(plan);
      if (usage) rows.push({ id: `${id}-usage`, tone: "info", text: usage });
    }
    if (plan.paused) rows.push({ id: `${id}-paused`, tone: "warn", text: pausedCopy(plan.paused, ctx) });
    if (plan.batchPaused) {
      const t = batchPausedCopy(plan.batchPaused, ctx, plan.paused);
      if (t) rows.push({ id: `${id}-batch`, tone: "warn", text: t });
    }
  }
  const showPayg = status.payg.providers.length > 0 || status.plans.some((p) => p.fallback);
  if (showPayg) {
    const ctx: CopyContext = { dailyCapUsd: cap, now, fmt };
    if (status.payg.paused) rows.push({ id: "payg-paused", tone: "warn", text: pausedCopy(status.payg.paused, ctx) });
    if (status.payg.batchPaused) {
      const t = batchPausedCopy(status.payg.batchPaused, ctx, status.payg.paused);
      if (t) rows.push({ id: "payg-batch", tone: "warn", text: t });
    }
  }
  for (const w of status.waitingBatch) rows.push({ id: `waiting-${w.workType}`, tone: "info", text: waitingBatchText(w.workType) });
  return rows;
}

/**
 * The one-line status the Knowledge card and the CTO pane show: the first refusal in words (the subject is who is
 * waiting), else the usage in plan or dollar terms. Null when the status has nothing to say (no providers).
 */
export function summaryLine(status: BudgetStatus, subject: string = DEFAULT_SUBJECT, now: number = Date.now(), fmt: TimeFormat = {}): StatusRow | null {
  const cap = status.dailyCapUsd;
  for (const plan of status.plans) {
    if (plan.paused) return { id: `plan-${plan.adapter}-paused`, tone: "warn", text: pausedCopy(plan.paused, { plan, dailyCapUsd: cap, now, fmt, subject }) };
  }
  if (status.payg.paused) return { id: "payg-paused", tone: "warn", text: pausedCopy(status.payg.paused, { dailyCapUsd: cap, now, fmt, subject }) };
  for (const plan of status.plans) {
    if (plan.fallback) return { id: `plan-${plan.adapter}-fallback`, tone: "warn", text: fallbackText(plan, cap) };
  }
  const bits: string[] = [];
  for (const plan of status.plans) {
    const t = planUsageText(plan);
    if (t) bits.push(t);
  }
  if (status.payg.providers.length > 0) bits.push(`${formatUsd(status.payg.usdToday)} of ${formatUsd(cap)} today on API keys`);
  return bits.length > 0 ? { id: "usage", tone: "info", text: bits.join(" · ") } : null;
}

/** The refusal behind the CTO's thrifty mode, in words: a cap refusal when there is one, else the first refusal. */
export function thriftyReasonText(status: BudgetStatus | null, subject: string = DEFAULT_SUBJECT, now: number = Date.now(), fmt: TimeFormat = {}): string | null {
  if (!status) return null;
  const cap = status.dailyCapUsd;
  const candidates: { p: BudgetPaused; plan?: BudgetPlanStatus }[] = [];
  if (status.payg.paused) candidates.push({ p: status.payg.paused });
  for (const plan of status.plans) if (plan.paused) candidates.push({ p: plan.paused, plan });
  const pick = candidates.find((c) => c.p.reason === "usd-cap" || c.p.reason === "level-cap") ?? candidates[0];
  return pick ? pausedCopy(pick.p, { plan: pick.plan, dailyCapUsd: cap, now, fmt, subject }) : null;
}

const THRIFTY_GENERIC = "The CTO is limiting background work to stay inside its budget.";

/**
 * The thrifty banner's sentence. The budget's own words only when the CTO went thrifty because the budget refused a call
 * (`cap_hit`) AND that refusal still stands; a watchdog thrifty, an older box (no reason), an unreadable budget or a
 * cause that has cleared all get the generic line — a refusal that is not the cause must not be shown as the cause.
 */
export function thriftyBannerText(
  thriftyReason: string | null | undefined,
  status: BudgetStatus | null,
  subject: string = DEFAULT_SUBJECT,
  now: number = Date.now(),
  fmt: TimeFormat = {},
): string {
  if (thriftyReason !== "cap_hit") return THRIFTY_GENERIC;
  return thriftyReasonText(status, subject, now, fmt) ?? THRIFTY_GENERIC;
}

/** The work types of each subsystem (the server's WORK_CLASS keys, partitioned): not every one shares a name prefix. */
export const KNOWLEDGE_WORK_TYPES: readonly string[] = [
  "knowledge-capture",
  "curator-notes",
  "curator-rules",
  "curator-skills",
  "knowledge-corrections",
  "knowledge-tidy",
  "knowledge-trial",
];
export const CTO_WORK_TYPES: readonly string[] = ["cto-ambient", "cto-overnight", "cto-backfill"];

/** "Knowledge work today: 14 calls · 1.2M tokens" for the given work types (KNOWLEDGE_WORK_TYPES / CTO_WORK_TYPES). */
export function shareLine(status: BudgetStatus, workTypes: readonly string[], noun: string): string | null {
  const mine = status.byWork.filter((w) => workTypes.includes(w.workType));
  const calls = mine.reduce((n, w) => n + (Number(w.calls) || 0), 0);
  const tokens = mine.reduce((n, w) => n + (Number(w.tokens) || 0), 0);
  if (calls === 0 && tokens === 0) return null;
  return `${noun} today: ${calls} call${calls === 1 ? "" : "s"} · ${formatTokens(tokens)}`;
}

// ---- visibility --------------------------------------------------------------------------------

/** The level control shows only when a subscription plan exists. */
export const showLevelControl = (s: BudgetStatus): boolean => s.plans.length > 0;
/** The API-key cap shows when a pay-per-token provider exists, or when a plan fell back to the dollar cap. */
export const showCapControl = (s: BudgetStatus): boolean => s.payg.providers.length > 0 || s.plans.some((p) => p.fallback);

/** A reply that isn't a status (an older box, a transport with no answer). */
export function isBudgetStatus(v: unknown): v is BudgetStatus {
  const s = v as Partial<BudgetStatus> | null | undefined;
  return !!s && typeof s === "object" && Array.isArray(s.plans) && !!s.payg && typeof s.payg === "object" && Array.isArray(s.payg.providers);
}

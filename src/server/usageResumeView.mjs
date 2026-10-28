// usageResumeView.mjs — the "Resume after limit reset" screen computed on the
// box (WS09 SF-M14 / SF-M15). Ports usageResume.ts + the UsageResumeModal
// derivations: grouping, "new" badge, last-activity snippet, reset window, the
// warm/cold prompt-cache cost, header text, and the arm/disarm plan. Desktop and
// iOS render `usage-stopped:view` and write through `usage-stopped:apply`; the
// row markers / sidebar capsule keep reading `usage-stopped:list` (master D29).

import { formatTokens } from "../shared/formatTokens.mjs";
import { selectCacheTtlMs } from "../shared/streamInterpretation.mjs";

const TITLE = "Resume after limit reset";
const EMPTY_TEXT = "No conversations are stopped by a provider limit right now.";
const COLD_NOTE = {
  one: "One of these resets well past your prompt-cache window, so its history is re-read from scratch. The estimate is per conversation above.",
  many: "{n} of these reset well past your prompt-cache window, so their history is re-read from scratch. The estimate is per conversation above.",
};

/** Tail of the most recent assistant message's text, single-line-truncated to 90 chars; null when none. */
export function extractLastSnippet(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role !== "assistant") continue;
    const text = (m.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string" && p.text)
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (!text) continue;
    return text.length > 90 ? text.slice(0, 90).trimEnd() + "…" : text;
  }
  return null;
}

function windowFor(record, snapshots) {
  const snap = (snapshots ?? []).find((s) => s.provider === record.provider);
  if (!snap || !record.window) return undefined;
  return (snap.windows ?? []).find((w) => w.kind === record.window);
}

/** The reset instant a record waits on (undefined = the refusal named no window / no snapshot). */
export function resetAtFor(record, snapshots) {
  return windowFor(record, snapshots)?.resetsAt ?? undefined;
}

/** Cached tokens to re-read on resume: 0 when the reset falls inside the cache TTL; an unknown reset is cold. */
export function resumeCost(record, resetsAt, now, ttlMs) {
  if (resetsAt == null) return record.cachedTokens ?? 0;
  if (resetsAt - now <= ttlMs) return 0;
  return record.cachedTokens ?? 0;
}

const isNew = (record, lastLooked) => lastLooked == null || record.stoppedAt > lastLooked;

function windowLabel(record, snapshots) {
  if (!record.window) return "Limit";
  const win = windowFor(record, snapshots);
  if (win?.label) return win.label;
  return record.window.charAt(0).toUpperCase() + record.window.slice(1);
}

function groupByWorkspace(records) {
  const order = [];
  const byWs = new Map();
  for (const r of records) {
    const ws = r.workspace || "—";
    if (!byWs.has(ws)) {
      byWs.set(ws, []);
      order.push(ws);
    }
    byWs.get(ws).push(r);
  }
  return order.map((workspace) => ({
    workspace,
    rows: byWs.get(workspace).slice().sort((a, b) => b.stoppedAt - a.stoppedAt),
  }));
}

/** The full `usage-stopped:view` result. `stopped` is listStopped()'s `{records, lastLooked}` envelope. */
export function buildResumeView({ stopped, snapshots, cacheTtl, names, snippets, now }) {
  const records = Array.isArray(stopped?.records) ? stopped.records : [];
  const lastLooked = stopped?.lastLooked ?? null;
  const ttlMs = selectCacheTtlMs(cacheTtl);
  const armedCount = records.filter((r) => r.armed === true).length;
  const newCount = records.filter((r) => isNew(r, lastLooked)).length;
  const hasArmed = armedCount > 0;
  const header = hasArmed
    ? `${armedCount} armed · ${newCount} stopped since you last looked.`
    : `${records.length} conversation${records.length === 1 ? "" : "s"} ${
        records.length === 1 ? "was" : "were"
      } stopped by a provider limit. Pick which ones should carry on by themselves when quota returns.`;
  return {
    supported: true,
    title: TITLE,
    header,
    hasArmed,
    unarmedCount: records.length - armedCount,
    totalCount: records.length,
    emptyText: EMPTY_TEXT,
    groups: groupByWorkspace(records).map((g) => ({
      workspace: g.workspace,
      rows: g.rows.map((r) => {
        const resetsAt = resetAtFor(r, snapshots);
        const reReadTokens = resumeCost(r, resetsAt, now, ttlMs);
        const warm = reReadTokens === 0;
        return {
          conversation: r.conversation,
          name: names?.get?.(r.conversation) || r.conversation,
          armed: r.armed === true,
          isNew: isNew(r, lastLooked),
          snippet: snippets?.get?.(r.conversation) ?? null,
          provider: r.provider ?? null,
          model: r.model ?? null,
          window: { label: windowLabel(r, snapshots), resetsAt: resetsAt ?? null },
          cost: {
            warm,
            reReadTokens,
            label: warm ? "cache still warm · no extra cost" : `≈ ${formatTokens(reReadTokens)} re-read`,
          },
        };
      }),
    })),
    coldNote: COLD_NOTE,
  };
}

/**
 * Diff the selection against the CURRENT records: selected & not armed → arm;
 * armed & not selected → disarm. `canApply` is true whenever the plan has ANY
 * change (so unchecking the only armed row enables "Update").
 */
export function planApply({ records, selected }) {
  const pick = new Set(selected ?? []);
  const rows = Array.isArray(records) ? records : [];
  const arm = rows.filter((r) => pick.has(r.conversation) && r.armed !== true).map((r) => r.conversation);
  const disarm = rows.filter((r) => !pick.has(r.conversation) && r.armed === true).map((r) => r.conversation);
  const hasArmed = rows.some((r) => r.armed === true);
  const selectedCount = rows.filter((r) => pick.has(r.conversation)).length;
  return {
    arm,
    disarm,
    canApply: arm.length + disarm.length > 0,
    title: hasArmed ? "Update" : `Resume ${selectedCount} at reset`,
  };
}

const plural = (n) => `${n} conversation${n === 1 ? "" : "s"}`;

export function createUsageResumeView({
  listStopped,
  listSnapshots,
  configGet,
  listProjects,
  listMessages,
  arm,
  disarm,
  now = Date.now,
}) {
  async function names() {
    const out = new Map();
    try {
      for (const p of (await listProjects()) ?? []) {
        for (const w of p?.windows ?? []) if (w?.opencodeSessionId && w.name) out.set(w.opencodeSessionId, w.name);
      }
    } catch (e) {
      console.warn("[usage-stopped:view] could not read window names:", e);
    }
    return out;
  }

  async function snippetsFor(records) {
    const out = new Map();
    await Promise.all(
      records.map(async (r) => {
        try {
          out.set(r.conversation, extractLastSnippet(await listMessages(r.conversation, { limit: 5 })));
        } catch {
          out.set(r.conversation, null);
        }
      }),
    );
    return out;
  }

  async function view() {
    const stopped = await listStopped();
    const records = stopped?.records ?? [];
    let cacheTtl;
    try {
      cacheTtl = (await configGet())?.cacheTtl;
    } catch {
      cacheTtl = undefined;
    }
    const [nameMap, snippetMap] = await Promise.all([names(), snippetsFor(records)]);
    return buildResumeView({
      stopped,
      snapshots: listSnapshots?.() ?? [],
      cacheTtl,
      names: nameMap,
      snippets: snippetMap,
      now: now(),
    });
  }

  async function apply({ selected, dryRun } = {}) {
    const stopped = await listStopped();
    const records = stopped?.records ?? [];
    const plan = planApply({ records, selected: Array.isArray(selected) ? selected : [] });
    const base = { canApply: plan.canApply, title: plan.title, arm: plan.arm, disarm: plan.disarm };
    if (dryRun === true) return { ok: true, ...base };
    if (!plan.canApply) return { ok: true, ...base, applied: { armed: [], disarmed: [] }, failed: [], message: "Nothing to change." };

    const armedBefore = records.filter((r) => r.armed === true).length;
    const nameMap = await names();
    const nameOf = (c) => nameMap.get(c) || c;
    const applied = { armed: [], disarmed: [] };
    const failed = [];
    const steps = [
      ...plan.arm.map((conversation) => ({ conversation, run: arm, into: applied.armed })),
      ...plan.disarm.map((conversation) => ({ conversation, run: disarm, into: applied.disarmed })),
    ];
    for (const step of steps) {
      try {
        await step.run({ conversation: step.conversation });
        step.into.push(step.conversation);
      } catch (e) {
        failed.push({
          conversation: step.conversation,
          name: nameOf(step.conversation),
          message: `Couldn't update ${nameOf(step.conversation)} — ${e instanceof Error ? e.message : String(e)}. The ones after it weren't changed.`,
        });
        break;
      }
    }
    if (failed.length > 0) return { ok: false, ...base, applied, failed, message: failed[0].message };
    const armedNow = armedBefore + applied.armed.length - applied.disarmed.length;
    const message =
      armedNow > 0
        ? `Updated — ${plural(armedNow)} will carry on at reset.`
        : `Removed ${plural(applied.disarmed.length)} from resume.`;
    return { ok: true, ...base, applied, failed: [], message };
  }

  return { view, apply };
}

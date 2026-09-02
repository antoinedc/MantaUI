// §9.5 per-class calibration (BET-1518, spec v3 D22) — the estimator that
// replaced the v2 earned-trust ladder (ctoTrust.mjs is deleted).
//
//   calibration(class) = (successes + 1) / (outcomes + 2)
//
// — a Beta mean with a (1,1) prior over the class's LAST 30 outcomes. A fresh
// class starts at 0.5 (the prior's mean with no data). The gate multiplies a
// candidate's stated confidence by this and compares against τ (§9.3).
//
// Outcome source (§9.6 table, calibration column): verdicts on plan/suggestion
// subjects fold accept/edit → success; dismiss/correct/undo → failure; a
// never flag → failure (dominant); veto/open/expire → no calibration signal.
//
// Store row shape (`calibration.json`, created by BET-1521 for this module):
//   { classes: { <cls>: { successes, outcomes, recent: [{ ok, ts }] } } }
// `recent` (≤ CALIBRATION_WINDOW rows) is the source of truth;
// `successes`/`outcomes` are its derived counts — kept in the row so the
// Settings health table (ctoHealth.mjs) reads the documented shape without
// deriving anything. If the two ever disagree (hand edit), derive-from-window
// wins.
//
// Also hosts the act-and-report bookkeeping that used to live in the trust
// engine: an act must appear in the next digest (§9.2 invariant 1), so the
// announcement queue (recordAct → listAnnouncements → markAnnounced) survives
// the ladder. Tier announcements died with the ladder.

import { calibrationStore, verdictsStore, patchStore } from "./ctoStores.mjs";
import { appendLedgerBestEffort } from "./ctoStores.mjs";

export const CALIBRATION_WINDOW = 30;

// The Beta-mean estimator. Fresh class (no row): 0.5. Clamp guards a
// hand-edited store; the estimator itself stays (s+1)/(o+2) ∈ (0,1).
export function calibrationOf(successes, outcomes) {
  const s = Number.isFinite(successes) ? Math.max(0, successes) : 0;
  const o = Number.isFinite(outcomes) ? Math.max(0, outcomes) : 0;
  return (s + 1) / (o + 2);
}

// Read the class's calibration off a store payload. A missing/empty row →
// 0.5 (fresh class). A row whose window disagrees with its counts re-derives
// from the window (the counts are derived state, never authoritative).
export function calibrationFromPayload(payload, cls) {
  const row = payload?.classes?.[cls];
  if (!row) return 0.5;
  const win = Array.isArray(row.recent) ? row.recent : null;
  if (win && Array.isArray(row.recent)) {
    const outcomes = win.length;
    const successes = win.filter((e) => e?.ok === true).length;
    return calibrationOf(successes, outcomes);
  }
  return calibrationOf(row.successes, row.outcomes);
}

// §9.6 calibration column: one verdict → "success" | "failure" | null.
// A never flag dominates whatever the verdict said (it is a never-again
// judgment — a rejection of the class's judgment). veto/open/expire never
// enter calibration; veto is the overnight window's consent, not a gate
// verdict, and open/expire are non-judgments.
export function outcomeOfVerdict(verdict, never) {
  if (never === true) return "failure";
  switch (verdict) {
    case "accept":
    case "edit":
      return "success";
    case "dismiss":
    case "correct":
      return "failure";
    default:
      return null;
  }
}

// Pure window update: append the outcome, trim to the last-30 window, and
// re-derive the counts. `classes` may be absent (first fold ever).
export function applyOutcomeToClasses(classes, cls, ok, ts) {
  const base = classes && typeof classes === "object" ? classes : {};
  const row = base[cls] && typeof base[cls] === "object" ? base[cls] : {};
  const win = (Array.isArray(row.recent) ? row.recent : [])
    .concat([{ ok: ok === true, ts }])
    .slice(-CALIBRATION_WINDOW);
  const outcomes = win.length;
  const successes = win.filter((e) => e?.ok === true).length;
  return {
    ...base,
    [cls]: { successes, outcomes, recent: win },
  };
}

export function createCtoCalibration(deps = {}) {
  const {
    store = calibrationStore,
    verdicts = verdictsStore,
    ledger = null,
    plans = null, // plans.json — plan verdicts resolve their class from here when the entry lacks one
    now = () => Date.now(),
  } = deps;

  async function ledgerLog(entry) {
    if (!ledger) return;
    await appendLedgerBestEffort(ledger, now(), entry);
  }

  async function loadPayload() {
    try {
      return (await store.load()) || {};
    } catch {
      return {};
    }
  }

  // §9.5 calibration for one class. Never throws: an unreadable store is a
  // fresh class (0.5), never a gate failure.
  async function calibration(cls) {
    const payload = await loadPayload();
    return calibrationFromPayload(payload, String(cls ?? ""));
  }

  // The gate's τ-independent input lookup: {cls → calibration} for the given
  // classes, in one read. Unknown classes come back 0.5 (fresh).
  async function calibrationsFor(classList) {
    const payload = await loadPayload();
    const out = {};
    for (const cls of classList) out[cls] = calibrationFromPayload(payload, cls);
    return out;
  }

  // The rolling-window write path. Best-effort: a store failure loses one
  // outcome, never the caller.
  async function noteOutcome(cls, ok) {
    const key = String(cls ?? "");
    if (!key) return;
    try {
      await patchStore(store, (fresh) => ({
        classes: applyOutcomeToClasses(fresh?.classes, key, ok, now()),
      }));
    } catch {
      /* best-effort */
    }
  }

  // Resolve a plan verdict's class: the entry's own stamp wins; otherwise the
  // plan row in plans.json is the attribute source (the renderer's verdicts on
  // plan cards carry the card id, and the plan row carries the class).
  async function resolvePlanClass(entry) {
    const stamp = entry?.subject?.class;
    if (typeof stamp === "string" && stamp) return stamp;
    const planId = entry?.subject?.id;
    if (plans && typeof planId === "string" && planId) {
      try {
        const payload = await plans.load();
        for (const rec of Object.values(payload?.records ?? {})) {
          const hit = (rec?.plans ?? []).find((p) => p?.id === planId);
          if (hit?.class) return String(hit.class);
        }
      } catch {
        /* best-effort attribution */
      }
    }
    return null;
  }

  // The §9.5 verdict sink — the replacement for the trust ladder's counter
  // sink, same B3 registration contract (called with the fold's effects and
  // the raw ledger entry, best-effort, never breaks verdict recording).
  // Folds verdicts on suggestion AND plan subjects (both carry class —
  // suggestions from the suggest flow's ask/held cards, plans from the
  // gate's ask cards + the executor's act-and-report). Holds the ledger
  // row so §14.5 can audit the fold.
  async function noteVerdictEffects(effects, entry) {
    const subject = entry?.subject;
    const type = subject?.type;
    if (type !== "suggestion" && type !== "plan") return;
    const cls = type === "plan" ? await resolvePlanClass(entry) : (subject?.class ?? null);
    if (!cls) return;
    const outcome = outcomeOfVerdict(entry?.verdict, entry?.never === true);
    if (outcome === null) return;
    await noteOutcome(cls, outcome === "success");
    await ledgerLog({
      kind: "calibrate.fold",
      class: cls,
      outcome,
      subjectType: type,
      subjectId: subject?.id ?? null,
      verdict: entry?.verdict ?? null,
    });
  }

  // Direct executor outcome (§9.5: "verified execution outcomes re-estimate
  // the same Beta window"). The executor ticket calls this on each
  // execution outcome: {planId, class} + ok.
  async function notePlanOutcome({ planId = null, class: cls, ok } = {}) {
    const key = String(cls ?? "");
    if (!key) return { ok: false, error: "class required" };
    await noteOutcome(key, ok === true);
    await ledgerLog({ kind: "calibrate.outcome", class: key, planId, ok: ok === true });
    return { ok: true };
  }

  // ---- act-and-report bookkeeping (ex-trust engine) ----
  // recordAct writes the ledger row and queues the digest announcement
  // (§9.2 invariant 1: an act must appear in the next digest). The pending
  // queue lives IN the calibration store so it survives restarts and stays
  // under the same per-store mutex.
  async function recordAct({ cls = null, text = "", refs = [], action = null, score = null } = {}) {
    const ts = now();
    await ledgerLog({
      kind: "cto.act",
      class: cls,
      actionType: action?.type ?? null,
      text: typeof text === "string" ? text.slice(0, 200) : "",
      score: typeof score === "number" ? score : null,
    });
    try {
      await patchStore(store, (fresh) => {
        const pending = Array.isArray(fresh?.pendingAnnouncements) ? fresh.pendingAnnouncements : [];
        return {
          pendingAnnouncements: [
            ...pending,
            { id: `act-${ts}-${Math.floor(Math.random() * 1e6)}`, kind: "act", ts, cls, text: String(text ?? "") },
          ].slice(-50),
        };
      });
    } catch {
      /* the ledger row above already records the act */
    }
    return { ok: true };
  }

  // Digest seam (§14.2): pending act announcements, then mark them announced.
  async function listAnnouncements() {
    const payload = await loadPayload();
    return Array.isArray(payload?.pendingAnnouncements) ? payload.pendingAnnouncements : [];
  }

  async function markAnnounced(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (want.size === 0) return;
    try {
      await patchStore(store, (fresh) => ({
        pendingAnnouncements: (Array.isArray(fresh?.pendingAnnouncements) ? fresh.pendingAnnouncements : []).filter(
          (a) => !want.has(String(a?.id ?? "")),
        ),
      }));
    } catch {
      /* best-effort */
    }
  }

  async function getState() {
    const payload = await loadPayload();
    const classes = {};
    for (const [cls, row] of Object.entries(payload?.classes ?? {})) {
      const win = Array.isArray(row?.recent) ? row.recent : [];
      classes[cls] = {
        successes: win.filter((e) => e?.ok === true).length,
        outcomes: win.length,
        calibration: calibrationFromPayload(payload, cls),
      };
    }
    return { classes };
  }

  return {
    calibration,
    calibrationsFor,
    noteVerdictEffects,
    notePlanOutcome,
    recordAct,
    listAnnouncements,
    markAnnounced,
    getState,
  };
}

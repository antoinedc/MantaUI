// ===== Architect v2 Stage 1 — what a change card and the Tests tab say about a proposal's problem, size and trial =====
//
// Pure helpers (spec docs/superpowers/specs/2026-11-27-architect-v2.md §3.4): the rows of a trial (its cases joined to the
// Architect's verdicts), the words for a case's state and what it was expected to do, the instructions' size line, and how a
// shipped built-in update is labelled.

import type { AgentChange, AgentTrial, TrialCaseResult, TrialVerdict } from "../shared/types";

/** What a trial may do, in the words every surface that describes trials uses (§7). */
export const TRIAL_SAFETY_NOTE =
  "Runs in a private copy of the project, with no shell, no secrets, no publishing or sending, and file access limited to that copy.";

export type TrialCaseState = TrialCaseResult["state"];

/** "should do it" / "should decline". */
export function expectLabel(expect: TrialCaseResult["expect"]): string {
  return expect === "declines" ? "should decline" : "should do it";
}

export function caseStateLabel(state: TrialCaseState): string {
  switch (state) {
    case "queued":
      return "Waiting";
    case "running":
      return "Running";
    case "done":
      return "Finished";
    case "failed":
      return "Failed";
    case "timed-out":
      return "Timed out";
    case "aborted":
      return "Stopped";
  }
}

/** A case ended (its transcript can be read). */
export const caseEnded = (state: TrialCaseState | null): boolean => state === "done" || state === "failed" || state === "timed-out" || state === "aborted";

export interface TrialRow {
  name: string;
  /** null when the trial itself couldn't be read (an old record, or the trial is gone): only the verdict is known. */
  expect: TrialCaseResult["expect"] | null;
  state: TrialCaseState | null;
  verdict: { pass: boolean; quote: string; note: string } | null;
}

/** The trial's cases in their own order, each with the Architect's verdict when there is one; a verdict for a case the trial doesn't list (it is gone) comes last. */
export function trialRows(cases: ReadonlyArray<TrialCaseResult> | null | undefined, verdicts: ReadonlyArray<TrialVerdict> | null | undefined): TrialRow[] {
  const byCase = new Map<string, TrialVerdict>();
  for (const v of verdicts ?? []) if (v && typeof v.case === "string" && !byCase.has(v.case)) byCase.set(v.case, v);
  const rows: TrialRow[] = [];
  const seen = new Set<string>();
  for (const c of cases ?? []) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const v = byCase.get(c.name);
    rows.push({ name: c.name, expect: c.expect, state: c.state, verdict: v ? { pass: v.pass === true, quote: v.quote, note: v.note } : null });
  }
  for (const [name, v] of byCase) {
    if (seen.has(name)) continue;
    rows.push({ name, expect: null, state: null, verdict: { pass: v.pass === true, quote: v.quote, note: v.note } });
  }
  return rows;
}

/** The verdict a trial got from the proposal that used it: "passed" when every case passed, "failed" when one didn't, null when no proposal used it. */
export function trialVerdictOf(trial: Pick<AgentTrial, "id">, records: ReadonlyArray<Pick<AgentChange, "trial">> | null | undefined): "passed" | "failed" | null {
  const used = (records ?? []).find((r) => r.trial?.id === trial.id);
  if (!used?.trial) return null;
  return used.trial.verdicts.length > 0 && used.trial.verdicts.every((v) => v.pass === true) ? "passed" : "failed";
}

/** The verdicts of the proposal that used this trial (empty when none did). */
export function verdictsFor(trialId: string, records: ReadonlyArray<Pick<AgentChange, "trial">> | null | undefined): TrialVerdict[] {
  return (records ?? []).find((r) => r.trial?.id === trialId)?.trial?.verdicts ?? [];
}

/** "2 of 3 cases finished" / "3 cases" — a trial's one-line count. */
export function trialCountLine(cases: ReadonlyArray<Pick<TrialCaseResult, "state">>): string {
  const n = cases.length;
  const ended = cases.filter((c) => caseEnded(c.state)).length;
  const word = n === 1 ? "case" : "cases";
  return ended === n ? `${n} ${word}` : `${ended} of ${n} ${word} finished`;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/** "Instructions: 1,240 → 980 characters (−260)"; a new agent: "Instructions: 980 characters". null when the record doesn't say. */
export function sizeLine(change: Pick<AgentChange, "sizeBefore" | "sizeAfter">): string | null {
  const after = change.sizeAfter;
  if (typeof after !== "number" || !Number.isFinite(after)) return null;
  const before = change.sizeBefore;
  if (typeof before !== "number" || !Number.isFinite(before)) return `Instructions: ${fmt(after)} characters`;
  const d = after - before;
  const delta = d === 0 ? "no change" : d > 0 ? `+${fmt(d)}` : `−${fmt(-d)}`;
  return `Instructions: ${fmt(before)} → ${fmt(after)} characters (${delta})`;
}

/** A new shipped version of a built-in agent (Stage 0). */
export const isTemplateUpdate = (change: Pick<AgentChange, "origin">): boolean => change.origin?.kind === "template-update";

/** A built-in update that couldn't be merged with the user's edits and waits for a click (a write failure carries `error` instead). */
export const isTemplateConflict = (change: Pick<AgentChange, "origin" | "state" | "needsClick" | "error">): boolean =>
  isTemplateUpdate(change) && change.state === "pending" && change.needsClick && !change.error;

/** The date a trial ran, short: "27 Nov 2026, 14:05". */
export function trialDate(at: number): string {
  return new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

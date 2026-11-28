// ===== The profile's Settings tab — pure logic (docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §5) =====
//
// Which fields the user may edit, what each shows and sends, and the read-only lines. No DOM here.

import type { AgentInfo, AutonomyLevel } from "../../shared/types";

export type EditableField = "name" | "description" | "useWhen" | "notFor" | "model" | "isolation";

/** The box's limits (agents.mjs: NAME_MAX, DESCRIPTION_MAX, ROUTING_MAX). */
export const SETTINGS_MAX = { name: 40, description: 200, useWhen: 200, notFor: 200 } as const;

const ALL_FIELDS: ReadonlyArray<EditableField> = ["name", "description", "useWhen", "notFor", "model", "isolation"];

/** A specialist edits every field; the Architect only its model (the rest changes through Manta, always on a click); Manta nothing. */
export function editableFields(info: Pick<AgentInfo, "role">): ReadonlyArray<EditableField> {
  if (info.role === "lead") return [];
  if (info.role === "architect") return ["model"];
  return ALL_FIELDS;
}

export const lockedNote = (name: string): string =>
  `${name} is built into Manta, so its name, handle, wording and how it works change only through Manta: ask in any chat. Those changes always wait for your click.`;

/** What a field shows now: an empty routing line or Auto is "". */
export function fieldValue(info: AgentInfo, field: EditableField): string {
  switch (field) {
    case "name":
      return info.name;
    case "description":
      return info.description;
    case "useWhen":
      return info.useWhen ?? "";
    case "notFor":
      return info.notFor ?? "";
    case "model":
      return info.model ?? "";
    case "isolation":
      return info.isolation;
  }
}

/** Nothing to send: the trimmed draft is what the agent already has. */
export const isUnchanged = (info: AgentInfo, field: EditableField, draft: string): boolean => draft.trim() === fieldValue(info, field);

/** What goes to the box: trimmed text; an empty routing line or Auto is null (cleared). */
export function toWire(field: EditableField, draft: string): string | null {
  const t = draft.trim();
  if (t === "" && (field === "useWhen" || field === "notFor" || field === "model")) return null;
  return t;
}

/** The Model select: Auto first, then the approved models, plus the current one when it is no longer approved (so the control never lies). */
export function modelOptions(approved: ReadonlyArray<string>, current: string): Array<{ value: string; label: string }> {
  const values = [...new Set([...approved].sort())];
  if (current && !values.includes(current)) values.push(current);
  return [{ value: "", label: "Auto" }, ...values.map((v) => ({ value: v, label: v }))];
}

const ordinal = (n: number): string => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** "Runs monthly, on the 12th. Next: 12 Dec" — the refresh runs on a fixed day of the month; the user can't change it yet. */
export function refreshDayLine(day: number | null | undefined, now: number): string {
  if (day == null) return "";
  const t = new Date(now);
  const upcoming = t.getDate() < day ? new Date(t.getFullYear(), t.getMonth(), day) : new Date(t.getFullYear(), t.getMonth() + 1, day);
  const next = upcoming.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `Runs monthly, on the ${ordinal(day)}. Next: ${next}`;
}

/** The team-wide "learn from corrections" level (Settings → Sessions) in words. */
export function learningLine(level: AutonomyLevel | null | undefined): string {
  switch (level) {
    case "tell":
      return "Team setting: learns from your corrections and tells you";
    case "auto":
      return "Team setting: learns from your corrections";
    case "ask":
      return "Team setting: asks you before keeping a rule";
    case "never":
      return "Team setting: doesn't learn from your corrections";
    default:
      return "Team setting: see Settings";
  }
}

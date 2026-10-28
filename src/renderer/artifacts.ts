// The artifact list is derived on the box (`artifacts:list`, src/server/artifacts.mjs);
// the renderer only groups it by day in the device's own timezone. The wire type
// lives in src/shared/artifactsTypes.ts.
import type { ArtifactItem } from "../shared/artifactsTypes";

export type {
  ArtifactKind,
  ArtifactOrigin,
  PlanStatus,
} from "../shared/artifactsTypes";

export type Artifact = ArtifactItem;

// Locale-driven "older than yesterday" group label — "Mon, 3 Aug" / "Mon, Aug 3"
// depending on the OS locale. Module-level so the (expensive) Intl object is
// constructed once, not per group. Mirrors the RESET_*_FMT consts in
// chatUtils.ts (BET-966). Deliberately no year: the label is a within-recent-
// history grouping header, and adding a year is a behaviour change, not this task.
const GROUP_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

// Calendar-day index (days since epoch) in LOCAL time, DST-safe by offsetting
// the timestamp to UTC before dividing — makes "today/yesterday/older" and
// same-day grouping independent of the local offset.
function dayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function groupByDay(items: Artifact[], now: number): Array<{ label: string; items: Artifact[] }> {
  if (items.length === 0) return [];
  const today = dayIndex(now);
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const groups: Array<{ label: string; items: Artifact[] }> = [];
  let lastDay = Number.NaN;
  for (const item of sorted) {
    const idx = dayIndex(item.at);
    if (idx === lastDay) {
      groups[groups.length - 1].items.push(item);
    } else {
      groups.push({ label: groupLabel(idx, today, item.at), items: [item] });
      lastDay = idx;
    }
  }
  return groups;
}

function groupLabel(idx: number, today: number, atMs: number): string {
  if (idx === today) return "Today";
  if (idx === today - 1) return "Yesterday";
  return GROUP_DAY_FMT.format(atMs);
}

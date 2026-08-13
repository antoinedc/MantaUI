// Pure cron-for-instant helper shared across the server/renderer boundary.
//
// cronForInstant renders a 5-field cron expression ("M H D MO *") that fires
// ONCE at a given local-time instant (only minutes resolve to a specific
// value above cron's granularity; the DOW is "*" so the job fires on whatever
// weekday that date falls on). Used by the usage reset actions ("remind me /
// keep going at reset") to schedule a one-shot at `resetsAt + slack`.
//
// It lives here — NOT in src/server/schedule.mjs — because the RENDERER also
// needs it (to build the cron it hands to window.api.scheduleCreate), and
// schedule.mjs imports node builtins that must never reach the renderer
// bundle. schedule.mjs re-exports it, keeping one source of truth.
//
// Pure. Watch the month off-by-one: JS getMonth() is 0-11, cron months are
// 1-12, so a December job (getMonth() === 11) must render month "12".

export function cronForInstant(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getMinutes())} ${p(date.getHours())} ${p(date.getDate())} ${date.getMonth() + 1} *`;
}

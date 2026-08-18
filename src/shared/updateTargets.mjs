// updateTargets.mjs — ONE UpdateTarget list for the unified update banner and
// the Settings → About list (BET-1096, stage 2 of the unified-update epic).
//
// Stage 1 (BET-1095) produced the box-side CLI catalog + detector. Before
// this, the renderer assembled its update picture from two unrelated calls
// with two unrelated shapes (DesktopUpdateCheck / ServerUpdateCheck) and
// described each with its own bespoke function. That does not extend to six
// targets. This module replaces it with a SINGLE UpdateTarget[] in a fixed
// display order, so the same state always renders the same way — never sorted
// by discovery or completion order.

// Fixed labels and disruption values for the two non-CLI targets. The CLI ones
// come from the catalog and ride through `serverCheck.targets` unchanged.
const DESKTOP_FIXED = { label: "Manta UI", disruption: "app-restart" };
const SERVER_FIXED = { label: "The box", disruption: "reconnect" };

/**
 * Build the canonical UpdateTarget[] from the two update-check results.
 *
 * Returns the list in this FIXED display order: `desktop`, `server`,
 * `opencode`, then the remaining CLIs alphabetically by label. The order is a
 * property of the function, never of the input order, so the same state never
 * renders two different ways.
 *
 * Mapping rules, stated so there is nothing to decide:
 *  - desktop: `available` = `desktopCheck.available`; `ok` = `!desktopCheck.error`;
 *    `manual` = `desktopCheck.supported === false`. A dev build (no updater) is
 *    `ok:true, available:false, manual:true` — rendered as "not applicable",
 *    never "up to date".
 *  - server: `available` = `serverCheck.available`; `ok` = `serverCheck.ok !== false`.
 *  - CLIs: passed straight through from `serverCheck.targets`.
 *
 * @param {object} args
 * @param {object|null} [args.desktopCheck] the DesktopUpdateCheck result
 * @param {object|null} [args.serverCheck] the ServerUpdateCheck result
 * @param {string|null} [args.clientVersion] the running desktop version
 * @param {string|null} [args.serverVersion] the running box version
 * @returns {Array<object>} UpdateTarget[] in fixed display order
 */
export function buildUpdateTargets({
  desktopCheck = null,
  serverCheck = null,
  clientVersion = null,
  serverVersion = null,
} = {}) {
  const desktop = {
    id: "desktop",
    label: DESKTOP_FIXED.label,
    current: clientVersion ?? null,
    latest: desktopCheck?.version ?? null,
    available: desktopCheck?.available === true,
    ok: !desktopCheck?.error,
    manual: desktopCheck?.supported === false,
    disruption: DESKTOP_FIXED.disruption,
  };

  const server = {
    id: "server",
    label: SERVER_FIXED.label,
    current: serverVersion ?? null,
    latest: serverCheck?.version ?? null,
    available: serverCheck?.available === true,
    ok: serverCheck?.ok !== false,
    manual: false,
    disruption: SERVER_FIXED.disruption,
  };

  const clis = Array.isArray(serverCheck?.targets) ? serverCheck.targets : [];

  const opencode = clis.find((t) => t && t.id === "opencode");
  const rest = clis
    .filter((t) => t && t.id !== "opencode")
    .slice()
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return [desktop, server, ...(opencode ? [opencode] : []), ...rest];
}

/**
 * Summarize an update list into the banner + confirm copy inputs (stage 3).
 *
 * `count` is how many targets have an update we can actually apply; `names`
 * are those targets' labels in display order; `disruptions` is the deduped set
 * of their disruption values. `manual` targets never count — a "update by hand"
 * row must not read like something an "Update all" button is about to do.
 *
 * @param {Array<object>} targets UpdateTarget[]
 * @returns {{ count: number, names: string[], disruptions: string[] }}
 */
export function summarizeUpdates(targets) {
  const avail = (Array.isArray(targets) ? targets : []).filter(
    (t) => t && t.available && !t.manual,
  );
  const names = avail.map((t) => t.label);
  const disruptions = [...new Set(avail.map((t) => t.disruption).filter(Boolean))];
  return { count: names.length, names, disruptions };
}

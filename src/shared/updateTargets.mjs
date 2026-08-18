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
const DESKTOP_FIXED = { label: "Desktop app", disruption: "app-restart" };
const SERVER_FIXED = { label: "The server", disruption: "reconnect" };

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

/**
 * Decide what the ONE unified update banner says (stage 3, BET-1098).
 *
 * Pure: given the canonical `UpdateTarget[]` (fixed display order) plus two
 * aggregate flags, produce the banner copy — or `null` when there is nothing
 * to say. This is what collapses the five banner kinds (version-skew,
 * update-failed, server-update, plus the folded "behind" compat variant) into
 * one `updates` banner.
 *
 * Precedence is exactly this order:
 *   1. `failure` set        → danger, dismissible  ("update failed")
 *   2. `mandatory`          → accent, NON-dismissible ("must update to keep
 *                             working with this box" — the old version-skew)
 *   3. exactly 1 available   → `${label} has an update available`
 *   4. 2+ available          → `${n} updates available · ${names}`
 *   5. else                  → `null` (no banner)
 *
 * `available` means the update exists AND we can apply it; `manual` targets
 * never count (a "update by hand" row is not something an Update button does).
 * `names` are the available labels in the FIXED display order joined by ", ";
 * past three, take the first three and append ` +${n-3} more`.
 *
 * @param {Array<object>} targets UpdateTarget[] in fixed display order
 * @param {{ mandatory: boolean, failure: string | null }} opts
 * @returns {{ text: string, actionLabel: string, tone: "accent"|"danger",
 *            dismissible: boolean } | null}
 */
export function describeUpdateBanner(targets, { mandatory = false, failure = null } = {}) {
  if (failure != null && failure !== "") {
    return {
      text: `Update failed: ${failure}`,
      actionLabel: "Download manually",
      tone: "danger",
      dismissible: true,
    };
  }

  const avail = (Array.isArray(targets) ? targets : []).filter(
    (t) => t && t.available && !t.manual,
  );

  if (mandatory) {
    return {
      text: "Desktop app must be updated to keep working with this server",
      actionLabel: "Update",
      tone: "accent",
      dismissible: false,
    };
  }

  if (avail.length === 1) {
    return {
      text: `${avail[0].label} has an update available`,
      actionLabel: "Update",
      tone: "accent",
      dismissible: true,
    };
  }

  if (avail.length >= 2) {
    let names = avail
      .slice(0, 3)
      .map((t) => t.label)
      .join(", ");
    if (avail.length > 3) names += ` +${avail.length - 3} more`;
    return {
      text: `${avail.length} updates available · ${names}`,
      actionLabel: "Update all",
      tone: "accent",
      dismissible: true,
    };
  }

  return null;
}

/**
 * Plan a single "Update all" run over the canonical `UpdateTarget[]` (stage 3).
 *
 * `box` means ANY box-side target is updatable (server, opencode, or a CLI);
 * `desktopDownload` / `desktopInstall` are the desktop leg (runs last).
 * `needsConfirm` is true iff any available target's disruption is not "none"
 * — a CLI-only update (all disruptions "none") needs NO confirm and NO dialog.
 *
 * `confirmBody` is the ordered confirm sentences:
 *   1. any `ends-turns`                 → "Updating opencode restarts it, …"
 *   2. any `reconnect` and NO ends-turns → "The box will restart briefly …"
 *   3. any `app-restart`                 → "Manta UI will restart itself …"
 * Rule 2 is suppressed when rule 1 applies (an opencode restart already
 * implies the box restart — never print both).
 *
 * @param {Array<object>} targets UpdateTarget[]
 * @returns {{ desktopDownload: boolean, box: boolean, desktopInstall: boolean,
 *             needsConfirm: boolean, confirmBody: string[] }}
 */
export function planUpdateAll(targets) {
  const avail = (Array.isArray(targets) ? targets : []).filter(
    (t) => t && t.available && !t.manual,
  );
  const desktopDownload = avail.some((t) => t.id === "desktop");
  const box = avail.some((t) => t.id !== "desktop");
  const hasEndsTurns = avail.some((t) => t.disruption === "ends-turns");
  const hasReconnect = avail.some((t) => t.disruption === "reconnect");
  const hasAppRestart = avail.some((t) => t.disruption === "app-restart");

  const confirmBody = [];
  if (hasEndsTurns) {
    confirmBody.push(
      "Updating opencode restarts it, which ends every agent turn currently running. Any unsaved work in a running turn is lost.",
    );
  } else if (hasReconnect) {
    confirmBody.push("The server will restart briefly and reconnect on its own.");
  }
  if (hasAppRestart) {
    confirmBody.push("Desktop app will restart itself once the server is done.");
  }

  return {
    desktopDownload,
    box,
    desktopInstall: desktopDownload,
    needsConfirm: avail.some((t) => t.disruption !== "none"),
    confirmBody,
  };
}

/**
 * Decide a per-target update row's in-flight presentation (BET-1160).
 *
 * Pure, so Settings (and any future consumer) and the banner never disagree
 * about which row is busy / disabled / the one actually updating. Given the
 * target id and the shared in-flight snapshot (`updatingTargetId` from the
 * store, plus the aggregate `busy` that folds in the App-local box upgrade),
 * returns exactly one of:
 *
 *   - `{ kind: "updating" }` — THIS target is the one being updated (`id`
 *     equals `updatingTargetId`): its own button shows a spinner + "Updating…"
 *     and is disabled; no other row shows a spinner.
 *   - `{ kind: "busy" }`      — some OTHER update is in flight (`busy` is true
 *     via a different `updatingTargetId` or the box leg): this row's button is
 *     disabled, with no spinner of its own.
 *   - `{ kind: "idle" }`      — nothing in flight: the row keeps its normal
 *     action presentation.
 *
 * `id` is the row's target id; `updatingTargetId` is the store's in-flight
 * target (null = none); `busy` is the aggregate busy flag. A row with a
 * transient error is handled by the caller (it re-presents the button for
 * retry regardless of this result).
 *
 * @param {string} id the target id of the row being considered
 * @param {{ updatingTargetId: string|null, busy: boolean }} state
 * @returns {{ kind: "updating" } | { kind: "busy" } | { kind: "idle" }}
 */
export function rowUpdateState(id, { updatingTargetId = null, busy = false } = {}) {
  if (updatingTargetId != null && updatingTargetId === id) return { kind: "updating" };
  if (updatingTargetId != null || busy) return { kind: "busy" };
  return { kind: "idle" };
}

// settingsViews.mjs — box-derived Settings fields (WS11 D3, audit X6 / X9 / X3):
// the devices order + revocability, the GitHub row's secondary line, and the
// software-update rows. Pure; both clients render the result as given.

import { buildUpdateTargets, describeUpdateTarget } from "../shared/updateTargets.mjs";

/**
 * X6 — `GET /auth/devices` rows: this device first, then the most recently active,
 * then store order; every row gains `revocable`. The current device signs out
 * through "Remove server", and the primary row is the desktop's shared pairing —
 * neither is revocable from the list. A blank id is never revocable (with no
 * `device_id` the revoke route resets the whole identity).
 */
export function devicesView(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ac = a.row.current === true;
      const bc = b.row.current === true;
      if (ac !== bc) return ac ? -1 : 1;
      const l = typeof a.row.last_seen === "number" ? a.row.last_seen : -1;
      const r = typeof b.row.last_seen === "number" ? b.row.last_seen : -1;
      if (l !== r) return r - l;
      return a.index - b.index;
    })
    .map(({ row }) => ({
      ...row,
      revocable:
        row.current !== true && row.primary !== true && typeof row.device_id === "string" && row.device_id.trim() !== "",
    }));
}

/**
 * X9 — the secondary line on the Settings GitHub row: who is connected, where the
 * credential came from, and — when GitHub has rejected it — what to do.
 */
export function forgeCredentialSecondary(status) {
  if (status?.valid === false) {
    if (status.source === "cli") {
      return "GitHub rejected the gh CLI sign-in on your server. Run `gh auth login` there, or Disconnect.";
    }
    if (status.source === "env") {
      return "GitHub rejected the MANTA_GITHUB_TOKEN environment variable on your server. Replace it there, or Disconnect.";
    }
    return "GitHub rejected this sign-in. Disconnect, then connect again.";
  }
  const where =
    status?.source === "cli" ? "from the gh CLI on your server"
    : status?.source === "env" ? "from the MANTA_GITHUB_TOKEN env var"
    : status?.source === "stored" ? "signed in on this server"
    : "connected";
  return status?.login ? `@${status.login} · ${where}` : where;
}

/** "current → latest" for a row, omitting what is unknown. */
export function updateVersionText(t) {
  if (t.current && t.latest && t.current !== t.latest) return `${t.current} → ${t.latest}`;
  return t.current ?? t.latest ?? null;
}

/**
 * X3 — the box and every box-side CLI row of `server:update-check`. The desktop
 * (Electron) leg's data exists only in Electron, so it is not here.
 * @returns {{ targets: Array<{id, label, tone, text, hasUpdate, versionText}> }}
 */
export function updateTargetsView({ check, serverVersion = null }) {
  const targets = buildUpdateTargets({ serverCheck: check ?? null, serverVersion }).filter((t) => t.id !== "desktop");
  return {
    targets: targets.map((t) => {
      const row = describeUpdateTarget(t);
      return {
        id: t.id,
        label: t.label,
        tone: row.tone,
        text: row.text,
        hasUpdate: t.ok && t.available && !t.manual,
        versionText: updateVersionText(t),
      };
    }),
  };
}

/**
 * X6 — `DELETE /auth/revoke` query: a `device_id` that is PRESENT but blank is a
 * client bug and must be refused; an ABSENT one keeps its whole-identity-reset
 * meaning. Returns the present value (trimmed check only), or undefined.
 */
export function hasBlankDeviceId(query) {
  const present = query?.device_id ?? query?.deviceId;
  return present !== undefined && String(present).trim() === "";
}

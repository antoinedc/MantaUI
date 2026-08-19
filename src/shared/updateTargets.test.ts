import { describe, it, expect } from "vitest";
import type { UpdateTarget } from "./types";
import { describeUpdateTarget } from "../renderer/chatUtils";
import {
  buildUpdateTargets,
  summarizeUpdates,
  describeUpdateBanner,
  planUpdateAll,
  rowUpdateState,
  desktopUpdateBusy,
  isCliTarget,
} from "./updateTargets.mjs";

const cli = (
  id: UpdateTarget["id"],
  label: string,
  disruption: UpdateTarget["disruption"] = "none",
): UpdateTarget => ({
  id,
  label,
  current: null,
  latest: null,
  available: false,
  ok: true,
  manual: false,
  disruption,
});

describe("buildUpdateTargets", () => {
  it("always emits desktop + server in that fixed order, in front of the CLIs", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: false, version: "0.0.36" },
      serverCheck: { available: false },
      clientVersion: "0.0.36",
      serverVersion: "0.0.36",
    });
    expect(result.map((t) => t.id)).toEqual(["desktop", "server"]);
  });

  it("maps the desktop leg: available / ok / manual per the rules", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: true, version: "0.0.37" },
      serverCheck: { available: false },
    });
    const desktop = result[0];
    expect(desktop).toMatchObject({
      id: "desktop",
      label: "Manta Desktop",
      latest: "0.0.37",
      available: true,
      ok: true,
      manual: false,
      disruption: "app-restart",
    });
  });

  it("a dev build (supported:false) is ok but manual:true — never available", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: false, available: false, version: null },
      serverCheck: { available: false },
    });
    const desktop = result[0];
    expect(desktop.ok).toBe(true);
    expect(desktop.available).toBe(false);
    expect(desktop.manual).toBe(true);
    // A dev build is rendered as MUTED ("Update manually"), never "ok" — an
    // unanswerable check must not read as a clean bill of health.
    expect(describeUpdateTarget(desktop).tone).toBe("muted");
    expect(describeUpdateTarget(desktop).tone).not.toBe("ok");
  });

  it("a failed desktop check is ok:false", () => {
    const result = buildUpdateTargets({
      desktopCheck: {
        supported: true,
        available: false,
        version: null,
        error: "Couldn't check for updates.",
      },
      serverCheck: { available: false },
    });
    expect(result[0].ok).toBe(false);
  });

  it("maps the server leg: available and ok per the rules", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: false, version: "0.0.36" },
      serverCheck: { available: true, version: "0.0.37" },
      serverVersion: "0.0.36",
    });
    const server = result[1];
    expect(server).toMatchObject({
      id: "server",
      label: "Manta Server",
      current: "0.0.36",
      latest: "0.0.37",
      available: true,
      ok: true,
      manual: false,
      disruption: "reconnect",
    });
  });

  it("an absent server `ok` (older box) is treated as a successful check", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: false, version: "0.0.36" },
      serverCheck: { available: false },
    });
    expect(result[1].ok).toBe(true);
  });

  it("explicit server ok:false is propagated (check could not complete)", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: false, version: "0.0.36" },
      serverCheck: { available: false, ok: false },
    });
    expect(result[1].ok).toBe(false);
  });

  it("a serverCheck with no targets yields exactly desktop + server", () => {
    // An OLDER box predates the CLI probe and has no `targets` at all. The
    // unified list must degrade to exactly the two fixed targets, never crash.
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: false, version: "0.0.36" },
      serverCheck: { available: false },
      clientVersion: "0.0.36",
      serverVersion: "0.0.36",
    });
    expect(result.map((t) => t.id)).toEqual(["desktop", "server"]);
  });

  it("places opencode third and the remaining CLIs alphabetically by label", () => {
    const result = buildUpdateTargets({
      desktopCheck: { supported: true, available: false, version: "0.0.36" },
      serverCheck: {
        available: false,
        targets: [cli("kimi", "Kimi Code"), cli("opencode", "opencode"), cli("claude", "Claude Code"), cli("codex", "Codex")],
      },
    });
    // desktop, server, opencode, then Claude Code / Codex / Kimi Code by label.
    expect(result.map((t) => t.id)).toEqual([
      "desktop",
      "server",
      "opencode",
      "claude",
      "codex",
      "kimi",
    ]);
  });

  it("display order is stable regardless of input order", () => {
    // Shuffle both the CLI array and rely on the fixed legs always winning the
    // first two slots. The result must be identical every time.
    const orderFor = (targets: UpdateTarget[]) =>
      buildUpdateTargets({
        desktopCheck: { supported: true, available: false, version: "0.0.36" },
        serverCheck: { available: false, targets },
      }).map((t) => t.id);

    const a = [cli("codex", "Codex"), cli("opencode", "opencode"), cli("claude", "Claude Code")];
    const b = [cli("claude", "Claude Code"), cli("codex", "Codex"), cli("opencode", "opencode")];
    expect(orderFor(a)).toEqual(["desktop", "server", "opencode", "claude", "codex"]);
    expect(orderFor(b)).toEqual(["desktop", "server", "opencode", "claude", "codex"]);
  });
});

describe("summarizeUpdates", () => {
  const t = (
    id: UpdateTarget["id"],
    available: boolean,
    manual = false,
    disruption: UpdateTarget["disruption"] = "none",
  ): UpdateTarget => ({
    id,
    label: id,
    current: null,
    latest: null,
    available,
    ok: true,
    manual,
    disruption,
  });

  it("counts only available targets and returns their names in display order", () => {
    const summary = summarizeUpdates([
      t("desktop", false),
      t("server", true, false, "reconnect"),
      t("opencode", true, false, "ends-turns"),
    ]);
    expect(summary.count).toBe(2);
    expect(summary.names).toEqual(["server", "opencode"]);
    // Deduped set of disruption values.
    expect(summary.disruptions).toEqual(["reconnect", "ends-turns"]);
  });

  it("manual targets never count, even when available", () => {
    // A target that claims available but is manual must not be counted — an
    // "Update all" button must only ever cover things it will actually do.
    const summary = summarizeUpdates([
      t("desktop", true, true, "app-restart"),
      t("server", false),
    ]);
    expect(summary.count).toBe(0);
    expect(summary.names).toEqual([]);
  });

  it("dedupes disruption values", () => {
    const summary = summarizeUpdates([
      t("claude", true, false, "reconnect"),
      t("codex", true, false, "reconnect"),
    ]);
    expect(summary.disruptions).toEqual(["reconnect"]);
  });
});

describe("describeUpdateBanner", () => {
  const t = (
    id: UpdateTarget["id"],
    label: string,
    available = false,
    manual = false,
    disruption: UpdateTarget["disruption"] = "none",
  ): UpdateTarget => ({
    id,
    label,
    current: null,
    latest: null,
    available,
    ok: !manual,
    manual,
    disruption,
  });

  it("failure set → danger, dismissible, Download manually", () => {
    const banner = describeUpdateBanner([], { mandatory: false, failure: "checksum mismatch" });
    expect(banner).toEqual({
      text: "Update failed: checksum mismatch",
      actionLabel: "Download manually",
      tone: "danger",
      dismissible: true,
    });
  });

  it("failure outranks mandatory and every count", () => {
    const banner = describeUpdateBanner(
      [t("desktop", "Manta Desktop", true)],
      { mandatory: true, failure: "permission denied" },
    );
    expect(banner?.tone).toBe("danger");
    expect(banner?.text).toBe("Update failed: permission denied");
  });

  it("mandatory → accent, NON-dismissible, must-update copy", () => {
    const banner = describeUpdateBanner([], { mandatory: true, failure: null });
    expect(banner).toEqual({
      text: "Manta Desktop must be updated to keep working with this server",
      actionLabel: "Update",
      tone: "accent",
      dismissible: false,
    });
  });

  it("mandatory renders even with no targets available", () => {
    const banner = describeUpdateBanner([t("desktop", "Manta Desktop", false)], {
      mandatory: true,
      failure: null,
    });
    expect(banner?.tone).toBe("accent");
  });

  it("exactly one available → '<label> has an update available' for every target", () => {
    for (const label of ["Manta Desktop", "Manta Server", "opencode", "Claude Code", "Codex", "Kimi Code"]) {
      const banner = describeUpdateBanner([t("claude", label, true)], {
        mandatory: false,
        failure: null,
      });
      expect(banner).toEqual({
        text: `${label} has an update available`,
        actionLabel: "Update",
        tone: "accent",
        dismissible: true,
      });
    }
  });

  it("two available → 'N updates available · names' in display order", () => {
    const banner = describeUpdateBanner(
      [t("desktop", "Manta Desktop", true), t("server", "Manta Server", true, false, "reconnect")],
      { mandatory: false, failure: null },
    );
    expect(banner).toEqual({
      text: "2 updates available · Manta Desktop, Manta Server",
      actionLabel: "Update all",
      tone: "accent",
      dismissible: true,
    });
  });

  it("three available → all three names", () => {
    const banner = describeUpdateBanner(
      [
        t("desktop", "Manta Desktop", true),
        t("server", "Manta Server", true, false, "reconnect"),
        t("opencode", "opencode", true, false, "ends-turns"),
      ],
      { mandatory: false, failure: null },
    );
    expect(banner?.text).toBe("3 updates available · Manta Desktop, Manta Server, opencode");
  });

  it("past three names → keep first three and append '+N more'", () => {
    const banner = describeUpdateBanner(
      [
        t("desktop", "Manta Desktop", true),
        t("server", "Manta Server", true, false, "reconnect"),
        t("opencode", "opencode", true, false, "ends-turns"),
        t("claude", "Claude Code", true),
      ],
      { mandatory: false, failure: null },
    );
    expect(banner?.text).toBe("4 updates available · Manta Desktop, Manta Server, opencode +1 more");
  });

  it("zero available → null (no banner)", () => {
    const banner = describeUpdateBanner(
      [t("desktop", "Manta Desktop", false), t("server", "Manta Server", false)],
      { mandatory: false, failure: null },
    );
    expect(banner).toBeNull();
  });

  it("manual targets never count as available", () => {
    const banner = describeUpdateBanner(
      [t("desktop", "Manta Desktop", true, true), t("server", "Manta Server", false)],
      { mandatory: false, failure: null },
    );
    expect(banner).toBeNull();
  });
});

describe("planUpdateAll", () => {
  const t = (
    id: UpdateTarget["id"],
    available = false,
    manual = false,
    disruption: UpdateTarget["disruption"] = "none",
  ): UpdateTarget => ({
    id,
    label: id,
    current: null,
    latest: null,
    available,
    ok: !manual,
    manual,
    disruption,
  });

  it("desktop + box: both legs, needsConfirm on reconnect", () => {
    const plan = planUpdateAll([
      t("desktop", true, false, "app-restart"),
      t("server", true, false, "reconnect"),
    ]);
    expect(plan).toMatchObject({
      desktopDownload: true,
      desktopInstall: true,
      box: true,
      needsConfirm: true,
    });
    expect(plan.confirmBody).toEqual([
      "Manta Server will restart briefly and reconnect on its own.",
      "Manta Desktop will restart itself once Manta Server is done.",
    ]);
  });

  it("server-only: box leg, no desktop", () => {
    const plan = planUpdateAll([t("server", true, false, "reconnect")]);
    expect(plan.desktopDownload).toBe(false);
    expect(plan.desktopInstall).toBe(false);
    expect(plan.box).toBe(true);
    expect(plan.needsConfirm).toBe(true);
  });

  it("desktop+server: opencode ends-turns sentence replaces the reconnect sentence", () => {
    const plan = planUpdateAll([
      t("desktop", true, false, "app-restart"),
      t("server", true, false, "reconnect"),
      t("opencode", true, false, "ends-turns"),
    ]);
    // ends-turns suppresses reconnect (an opencode restart implies the box
    // restart), but app-restart still appears.
    expect(plan.confirmBody).toEqual([
      "Updating opencode restarts it, which ends every agent turn currently running. Any unsaved work in a running turn is lost.",
      "Manta Desktop will restart itself once Manta Server is done.",
    ]);
  });

  it("CLI-only (disruption none) → no confirm and no dialog", () => {
    const plan = planUpdateAll([t("claude", true, false, "none")]);
    expect(plan.box).toBe(true);
    expect(plan.desktopDownload).toBe(false);
    expect(plan.needsConfirm).toBe(false);
    expect(plan.confirmBody).toEqual([]);
  });

  it("desktop-only → box false, needsConfirm on app-restart", () => {
    const plan = planUpdateAll([t("desktop", true, false, "app-restart")]);
    expect(plan.desktopDownload).toBe(true);
    expect(plan.box).toBe(false);
    expect(plan.needsConfirm).toBe(true);
    expect(plan.confirmBody).toEqual(["Manta Desktop will restart itself once Manta Server is done."]);
  });

  it("manual targets never count toward any leg", () => {
    const plan = planUpdateAll([
      t("desktop", true, true, "app-restart"),
      t("server", true, true, "reconnect"),
    ]);
    expect(plan.desktopDownload).toBe(false);
    expect(plan.box).toBe(false);
    expect(plan.needsConfirm).toBe(false);
    expect(plan.confirmBody).toEqual([]);
  });

  it("app-restart alone does NOT suppress the reconnect sentence (no ends-turns)", () => {
    const plan = planUpdateAll([t("server", true, false, "reconnect")]);
    expect(plan.confirmBody).toEqual(["Manta Server will restart briefly and reconnect on its own."]);
  });
});

describe("rowUpdateState", () => {
  it("reports `updating` only for the exact target that is mid-update", () => {
    const state = { updatingTargetId: "server", busy: true };
    expect(rowUpdateState("server", state)).toEqual({ kind: "updating" });
    expect(rowUpdateState("desktop", state)).toEqual({ kind: "busy" });
    expect(rowUpdateState("opencode", state)).toEqual({ kind: "busy" });
  });

  it("reports `busy` when another update or the box leg is in flight", () => {
    expect(rowUpdateState("desktop", { updatingTargetId: "server", busy: true })).toEqual({ kind: "busy" });
    // busy can be true from the App-local box upgrade alone (updatingTargetId null).
    expect(rowUpdateState("desktop", { updatingTargetId: null, busy: true })).toEqual({ kind: "busy" });
  });

  it("reports `idle` when nothing is in flight", () => {
    expect(rowUpdateState("desktop", { updatingTargetId: null, busy: false })).toEqual({ kind: "idle" });
    expect(rowUpdateState("server", {})).toEqual({ kind: "idle" });
  });

  it("a DESKTOP run marks other rows disabled exactly as a CLI run does", () => {
    // BET-1195: the desktop leg reuses the same `updatingTargetId` the per-CLI
    // legs use, so a desktop run disables every other row just like a CLI run.
    const state = { updatingTargetId: "desktop", busy: true };
    expect(rowUpdateState("desktop", state)).toEqual({ kind: "updating" });
    expect(rowUpdateState("server", state)).toEqual({ kind: "busy" });
    expect(rowUpdateState("claude", state)).toEqual({ kind: "busy" });
  });
});

describe("desktopUpdateBusy", () => {
  const base = { updatingTargetId: "desktop", desktopDownloadPercent: null, desktopRestarting: false };

  it("returns null when no desktop update is in flight", () => {
    expect(desktopUpdateBusy({ ...base, updatingTargetId: null })).toBeNull();
    // A CLI run (updatingTargetId = the CLI id) is NOT a desktop run.
    expect(desktopUpdateBusy({ ...base, updatingTargetId: "claude" })).toBeNull();
    // Nothing at all.
    expect(desktopUpdateBusy({})).toBeNull();
  });

  it("desktop downloading with a percent → determinate progress + label", () => {
    const state = desktopUpdateBusy({ ...base, desktopDownloadPercent: 42 });
    expect(state).toEqual({
      busyLabel: "Downloading 42%",
      progress: { step: 42, total: 100, label: "Downloading update" },
    });
  });

  it("clamps out-of-range percents and rounds", () => {
    expect(desktopUpdateBusy({ ...base, desktopDownloadPercent: 99.6 })?.progress?.step).toBe(100);
    expect(desktopUpdateBusy({ ...base, desktopDownloadPercent: -3 })?.progress?.step).toBe(0);
    expect(desktopUpdateBusy({ ...base, desktopDownloadPercent: 42.4 })?.busyLabel).toBe("Downloading 42%");
  });

  it("desktop downloading with NO percent yet → indeterminate 'Downloading…'", () => {
    expect(desktopUpdateBusy({ ...base, desktopDownloadPercent: null })).toEqual({
      busyLabel: "Downloading…",
      progress: null,
    });
  });

  it("desktop restarting → indeterminate 'Restarting Manta Desktop…' with no percent", () => {
    const state = desktopUpdateBusy({ ...base, desktopRestarting: true, desktopDownloadPercent: 42 });
    expect(state).toEqual({ busyLabel: "Restarting Manta Desktop…", progress: null });
  });

  it("the restart beat answers even after the download leg cleared the id", () => {
    // finishUpdateAllOnce sets desktopRestarting AFTER runDesktopDownload clears
    // updatingTargetId — the beat must still present.
    const state = desktopUpdateBusy({ updatingTargetId: null, desktopDownloadPercent: null, desktopRestarting: true });
    expect(state?.busyLabel).toBe("Restarting Manta Desktop…");
  });
});

describe("isCliTarget", () => {
  // The two non-CLI targets must NEVER be treated as per-CLI rows — the whole
  // per-row feature keys off this tri-state identity, not the label.
  it("desktop and server are NOT cli targets", () => {
    expect(isCliTarget(cli("desktop", "Manta UI"))).toBe(false);
    expect(isCliTarget(cli("server", "The box"))).toBe(false);
  });

  it("every catalog CLI id IS a cli target", () => {
    expect(isCliTarget(cli("opencode", "opencode"))).toBe(true);
    expect(isCliTarget(cli("claude", "Claude Code"))).toBe(true);
    expect(isCliTarget(cli("codex", "Codex"))).toBe(true);
    expect(isCliTarget(cli("kimi", "Kimi Code"))).toBe(true);
  });

  it("null/undefined is never a cli target", () => {
    expect(isCliTarget(null)).toBe(false);
    expect(isCliTarget(undefined)).toBe(false);
  });
});

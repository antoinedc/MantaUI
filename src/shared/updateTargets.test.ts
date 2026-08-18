import { describe, it, expect } from "vitest";
import { buildUpdateTargets, summarizeUpdates } from "./updateTargets.mjs";

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
      label: "Manta UI",
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
      label: "The box",
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
    const cli = (id, label) => ({
      id,
      label,
      current: null,
      latest: null,
      available: false,
      ok: true,
      manual: false,
      disruption: "none",
    });
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
    const orderFor = (targets) =>
      buildUpdateTargets({
        desktopCheck: { supported: true, available: false, version: "0.0.36" },
        serverCheck: { available: false, targets },
      }).map((t) => t.id);

    const cli = (id, label) => ({
      id, label, current: null, latest: null, available: false, ok: true, manual: false, disruption: "none",
    });
    const a = [cli("codex", "Codex"), cli("opencode", "opencode"), cli("claude", "Claude Code")];
    const b = [cli("claude", "Claude Code"), cli("codex", "Codex"), cli("opencode", "opencode")];
    expect(orderFor(a)).toEqual(["desktop", "server", "opencode", "claude", "codex"]);
    expect(orderFor(b)).toEqual(["desktop", "server", "opencode", "claude", "codex"]);
  });
});

describe("summarizeUpdates", () => {
  const t = (id, available, manual = false, disruption = "none") => ({
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
      t("a", true, false, "reconnect"),
      t("b", true, false, "reconnect"),
    ]);
    expect(summary.disruptions).toEqual(["reconnect"]);
  });
});

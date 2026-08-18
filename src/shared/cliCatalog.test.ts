import { describe, it, expect } from "vitest";
import { CLI_CATALOG, resolveUpgradeCommand } from "./cliCatalog.mjs";

describe("CLI_CATALOG", () => {
  it("has the four expected CLIs with their manual URLs", () => {
    expect(CLI_CATALOG.map((c) => c.id)).toEqual([
      "opencode",
      "claude",
      "codex",
      "kimi",
    ]);
    for (const entry of CLI_CATALOG) {
      expect(entry.label).toBeTruthy();
      expect(entry.bin).toBeTruthy();
      expect(entry.upgrade).toBeInstanceOf(Array);
      expect(entry.manualUrl).toBeTruthy();
      expect(entry.disruption).toBeTruthy();
    }
  });

  it("marks opencode as the only non-npm, github-tracked CLI", () => {
    const opencode = CLI_CATALOG.find((c) => c.id === "opencode");
    expect(opencode.latest).toEqual({ kind: "github", repo: "anomalyco/opencode" });
    expect(opencode.npmPackage).toBeNull();
    expect(opencode.upgrade).toEqual(["opencode", "upgrade"]);
  });

  it("opencode is the only ends-turns-disruptive install", () => {
    expect(CLI_CATALOG.filter((c) => c.disruption === "ends-turns").map((c) => c.id)).toEqual([
      "opencode",
    ]);
  });
});

describe("resolveUpgradeCommand", () => {
  const npmCli = {
    id: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    upgrade: ["claude", "update"],
  };

  it("never interpolates into the pinned sh -c pipelines (returns them verbatim)", () => {
    for (const entry of CLI_CATALOG) {
      if (entry.upgrade[0] !== "sh") continue;
      // Re-resolving an arbitrary path outside npm/homebrew must hand back the
      // exact constant, byte-for-byte.
      const cmd = resolveUpgradeCommand(entry, "/usr/bin/" + entry.bin, null);
      expect(cmd).toEqual(entry.upgrade);
      expect(cmd.join(" ")).not.toContain("undefined");
      expect(cmd.join(" ")).not.toContain("[object");
    }
  });

  it("returns the vendor upgrade command when nothing special manages the binary", () => {
    expect(resolveUpgradeCommand(npmCli, "/usr/local/bin/claude", null)).toEqual([
      "claude",
      "update",
    ]);
  });

  it("branch 1 — npm root wins over the vendor installer", () => {
    // Even though claude has a vendor `["claude","update"]`, an npm-managed
    // binary must upgrade via npm so the vendor installer never shadows it.
    expect(
      resolveUpgradeCommand(npmCli, "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "/usr/local/lib/node_modules"),
    ).toEqual(["npm", "install", "-g", "@anthropic-ai/claude-code@latest"]);
  });

  it("branch 1 — npm root with a trailing slash still matches", () => {
    expect(
      resolveUpgradeCommand(npmCli, "/usr/local/lib/node_modules/@anthropic-ai/claude-code/x", "/usr/local/lib/node_modules/"),
    ).toEqual(["npm", "install", "-g", "@anthropic-ai/claude-code@latest"]);
  });

  it("branch 1 — requires an npmPackage; opencode never falls into npm", () => {
    const opencode = CLI_CATALOG.find((c) => c.id === "opencode");
    expect(
      resolveUpgradeCommand(opencode, "/usr/local/lib/node_modules/opencode", "/usr/local/lib/node_modules"),
    ).toEqual(["opencode", "upgrade"]);
  });

  it("branch 2 — refuses a brew-managed binary even when an upgrade exists", () => {
    for (const prefix of ["/opt/homebrew/bin/claude", "/usr/local/Cellar/claude/2.0.0/bin/claude", "/home/linuxbrew/linuxbrew/bin/claude"]) {
      expect(resolveUpgradeCommand(npmCli, prefix, null)).toBeNull();
      expect(resolveUpgradeCommand(npmCli, prefix, "/usr/local/lib/node_modules")).toBeNull();
    }
  });

  it("branch 2 — a sibling under /usr/local/bin (non-Cellar) is NOT brew and upgrades normally", () => {
    expect(resolveUpgradeCommand(npmCli, "/usr/local/bin/claude", null)).toEqual(["claude", "update"]);
  });

  it("branch 4 — null upgrade returns null (manual)", () => {
    expect(resolveUpgradeCommand({ id: "x", npmPackage: null, upgrade: null }, "/usr/bin/x", null)).toBeNull();
    expect(resolveUpgradeCommand(npmCli, null, null)).toBeNull();
    expect(resolveUpgradeCommand(null, "/usr/bin/x", null)).toBeNull();
  });
});

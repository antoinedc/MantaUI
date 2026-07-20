import { describe, it, expect } from "vitest";
import { migrateLegacyCapConfig } from "./configMigration.mjs";

describe("migrateLegacyCapConfig", () => {
  it("empty input → {}", () => {
    expect(migrateLegacyCapConfig({})).toEqual({});
    expect(migrateLegacyCapConfig(null)).toEqual({});
    expect(migrateLegacyCapConfig(undefined)).toEqual({});
  });

  it("only capExecutorEnabled=true → pluginsEnabled=true", () => {
    const r = migrateLegacyCapConfig({ capExecutorEnabled: true });
    expect(r.pluginsEnabled).toBe(true);
    expect("capExecutorEnabled" in r).toBe(false);
  });

  it("only capExecutorEnabled=false → pluginsEnabled stays absent", () => {
    // Off default — same as the spec (capExecutorEnabled was OFF by
    // default, pluginsEnabled is OFF by default; absence == OFF).
    const r = migrateLegacyCapConfig({ capExecutorEnabled: false });
    expect(r.pluginsEnabled).toBeUndefined();
    expect("capExecutorEnabled" in r).toBe(false);
  });

  it("all three legacy keys → pluginsEnabled set, the others dropped", () => {
    const r = migrateLegacyCapConfig({
      capExecutorEnabled: true,
      iosBuildRepoPath: "~/projects/better-ui",
      iosSimulatorName: "iPhone 15",
    });
    expect(r.pluginsEnabled).toBe(true);
    expect("capExecutorEnabled" in r).toBe(false);
    expect("iosBuildRepoPath" in r).toBe(false);
    expect("iosSimulatorName" in r).toBe(false);
  });

  it("new pluginsEnabled already set → legacy keys ignored", () => {
    const r = migrateLegacyCapConfig({
      pluginsEnabled: false,
      capExecutorEnabled: true,
    });
    expect(r.pluginsEnabled).toBe(false);
    expect("capExecutorEnabled" in r).toBe(false);
  });

  it("legacy value present AND pluginsEnabled set → new wins", () => {
    const r = migrateLegacyCapConfig({
      capExecutorEnabled: true,
      pluginsEnabled: false,
    });
    expect(r.pluginsEnabled).toBe(false);
    expect("capExecutorEnabled" in r).toBe(false);
  });

  it("preserves unrelated config fields", () => {
    const r = migrateLegacyCapConfig({
      capExecutorEnabled: true,
      autoRenameSessions: true,
      axiomToken: "xaat-foo",
    });
    expect(r.pluginsEnabled).toBe(true);
    expect(r.autoRenameSessions).toBe(true);
    expect(r.axiomToken).toBe("xaat-foo");
    expect("capExecutorEnabled" in r).toBe(false);
  });

  it("does not mutate the input", () => {
    const input = { capExecutorEnabled: true };
    const snapshot = JSON.stringify(input);
    migrateLegacyCapConfig(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

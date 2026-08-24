import { describe, it, expect } from "vitest";
import { migrateCacheTtlDefault, migrateLegacyCapConfig } from "./configMigration.mjs";

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
      shareAnalytics: false,
    });
    expect(r.pluginsEnabled).toBe(true);
    expect(r.autoRenameSessions).toBe(true);
    expect(r.shareAnalytics).toBe(false);
    expect("capExecutorEnabled" in r).toBe(false);
  });

  it("does not mutate the input", () => {
    const input = { capExecutorEnabled: true };
    const snapshot = JSON.stringify(input);
    migrateLegacyCapConfig(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("migrateCacheTtlDefault", () => {
  // "1h" was the shipped default and is provably wrong on a stock box:
  // opencode sends its cache breakpoints with no ttl, so Anthropic applies
  // its 5-minute default (measured: usage.cache_creation lands entirely in
  // ephemeral_5m_input_tokens). A persisted "1h" therefore has to be
  // corrected, or every existing box keeps under-warning.
  it("rewrites a persisted 1h to 5m and marks the correction", () => {
    const r = migrateCacheTtlDefault({ cacheTtl: "1h" });
    expect(r.cacheTtl).toBe("5m");
    expect(r.cacheTtlDefaultMigrated).toBe(true);
  });

  it("is one-time — a deliberate 1h re-pick survives", () => {
    const r = migrateCacheTtlDefault({ cacheTtl: "1h", cacheTtlDefaultMigrated: true });
    expect(r.cacheTtl).toBe("1h");
  });

  it("is idempotent (running it on its own output is a no-op)", () => {
    const once = migrateCacheTtlDefault({ cacheTtl: "1h" });
    expect(migrateCacheTtlDefault(once)).toEqual(once);
  });

  it("leaves an explicit 5m alone", () => {
    expect(migrateCacheTtlDefault({ cacheTtl: "5m" }).cacheTtl).toBe("5m");
  });

  it("leaves an absent cacheTtl absent (the schema default applies)", () => {
    const r = migrateCacheTtlDefault({ chatAutoAllow: true });
    expect("cacheTtl" in r).toBe(false);
    expect(r.chatAutoAllow).toBe(true);
  });

  it("null/non-object input → {}", () => {
    expect(migrateCacheTtlDefault(null)).toEqual({});
    expect(migrateCacheTtlDefault(undefined)).toEqual({});
    expect(migrateCacheTtlDefault("nope" as never)).toEqual({});
  });

  it("preserves unrelated config fields", () => {
    const r = migrateCacheTtlDefault({ cacheTtl: "1h", groqApiKey: "k", projects: [] });
    expect(r.groqApiKey).toBe("k");
    expect(r.projects).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = { cacheTtl: "1h" };
    const snapshot = JSON.stringify(input);
    migrateCacheTtlDefault(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

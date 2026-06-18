import { describe, it, expect } from "vitest";
import {
  SHARED_CONFIG_KEYS,
  patchTouchesSharedConfig,
  extractSharedConfig,
  mergeSharedConfig,
} from "./sharedConfig.mjs";

describe("patchTouchesSharedConfig", () => {
  it("true when a shareable field is present", () => {
    expect(patchTouchesSharedConfig({ groqApiKey: "sk-x" })).toBe(true);
    expect(patchTouchesSharedConfig({ chatAutoAllow: true })).toBe(true);
    expect(patchTouchesSharedConfig({ defaultModel: { providerID: "a", modelID: "b" } })).toBe(true);
  });
  it("false for device-local-only patches", () => {
    expect(patchTouchesSharedConfig({ host: "box" })).toBe(false);
    expect(patchTouchesSharedConfig({ projects: [] })).toBe(false);
    expect(patchTouchesSharedConfig({ opencodePort: 14096 })).toBe(false);
    expect(patchTouchesSharedConfig({ skillRegistryUrls: ["x"] })).toBe(false);
  });
  it("true if a patch mixes shared and local fields", () => {
    expect(patchTouchesSharedConfig({ host: "box", cacheTtl: "5m" })).toBe(true);
  });
  it("false for empty / null / non-object", () => {
    expect(patchTouchesSharedConfig({})).toBe(false);
    expect(patchTouchesSharedConfig(null as never)).toBe(false);
    expect(patchTouchesSharedConfig(undefined as never)).toBe(false);
  });
  it("only counts OWN enumerable keys, not falsy values", () => {
    // A field explicitly set to a falsy value still counts (it's a real edit:
    // clearing the Groq key to "").
    expect(patchTouchesSharedConfig({ groqApiKey: "" })).toBe(true);
    expect(patchTouchesSharedConfig({ chatAutoAllow: false })).toBe(true);
  });
});

describe("extractSharedConfig", () => {
  it("keeps only shareable fields + timestamp, drops device-local", () => {
    const snap = extractSharedConfig({
      host: "box",
      user: "dev",
      projects: [{ tmuxSession: "p", defaultCwd: "~" }],
      opencodePort: 14096,
      groqApiKey: "sk-x",
      voiceCommandModel: "llama",
      chatAutoAllow: true,
      configUpdatedAt: 1000,
    } as never);
    expect(snap).toEqual({
      groqApiKey: "sk-x",
      voiceCommandModel: "llama",
      chatAutoAllow: true,
      configUpdatedAt: 1000,
    });
    expect("host" in snap).toBe(false);
    expect("projects" in snap).toBe(false);
  });
  it("omits absent fields rather than emitting undefined", () => {
    const snap = extractSharedConfig({ host: "box" } as never);
    expect(snap).toEqual({});
  });
  it("handles null / non-object input", () => {
    expect(extractSharedConfig(null as never)).toEqual({});
  });
});

describe("mergeSharedConfig (last-write-wins)", () => {
  const base = {
    host: "box",
    projects: [],
    groqApiKey: "old",
    configUpdatedAt: 100,
  } as never;

  it("applies a strictly-newer incoming snapshot", () => {
    const { config, changed } = mergeSharedConfig(base, {
      groqApiKey: "new",
      configUpdatedAt: 200,
    });
    expect(changed).toBe(true);
    expect(config.groqApiKey).toBe("new");
    expect(config.configUpdatedAt).toBe(200);
    // device-local fields untouched
    expect(config.host).toBe("box");
  });

  it("ignores an older snapshot (local wins)", () => {
    const { config, changed } = mergeSharedConfig(base, {
      groqApiKey: "stale",
      configUpdatedAt: 50,
    });
    expect(changed).toBe(false);
    expect(config.groqApiKey).toBe("old");
    expect(config.configUpdatedAt).toBe(100);
  });

  it("treats an equal timestamp as already converged (no-op)", () => {
    const { config, changed } = mergeSharedConfig(base, {
      groqApiKey: "different",
      configUpdatedAt: 100,
    });
    expect(changed).toBe(false);
    expect(config.groqApiKey).toBe("old");
  });

  it("propagates a cleared field as a delete when incoming is newer", () => {
    const { config, changed } = mergeSharedConfig(base, {
      // groqApiKey absent → was cleared on the other device
      configUpdatedAt: 200,
    });
    expect(changed).toBe(true);
    expect("groqApiKey" in config).toBe(false);
    expect(config.configUpdatedAt).toBe(200);
  });

  it("does not leak device-local incoming fields into local config", () => {
    const { config } = mergeSharedConfig(base, {
      groqApiKey: "new",
      // a malicious/stray host should be ignored — not a shared key
      host: "evil",
      configUpdatedAt: 200,
    } as never);
    expect(config.host).toBe("box");
  });

  it("advances the clock even when values already matched (changed=false)", () => {
    const local = { groqApiKey: "same", configUpdatedAt: 100 } as never;
    const { config, changed } = mergeSharedConfig(local, {
      groqApiKey: "same",
      configUpdatedAt: 300,
    });
    expect(changed).toBe(false);
    expect(config.configUpdatedAt).toBe(300);
  });

  it("deep-compares defaultModel objects", () => {
    const local = {
      defaultModel: { providerID: "anthropic", modelID: "opus" },
      configUpdatedAt: 100,
    } as never;
    // identical value, newer ts → no field change, clock advances
    const r1 = mergeSharedConfig(local, {
      defaultModel: { providerID: "anthropic", modelID: "opus" },
      configUpdatedAt: 200,
    });
    expect(r1.changed).toBe(false);
    // different modelID → change
    const r2 = mergeSharedConfig(local, {
      defaultModel: { providerID: "anthropic", modelID: "sonnet" },
      configUpdatedAt: 200,
    });
    expect(r2.changed).toBe(true);
    expect(r2.config.defaultModel).toEqual({ providerID: "anthropic", modelID: "sonnet" });
  });

  it("treats missing local timestamp as 0 (any timestamped incoming wins)", () => {
    const local = { groqApiKey: "old" } as never; // no configUpdatedAt
    const { config, changed } = mergeSharedConfig(local, {
      groqApiKey: "new",
      configUpdatedAt: 1,
    });
    expect(changed).toBe(true);
    expect(config.groqApiKey).toBe("new");
  });

  it("no-op on null/undefined incoming", () => {
    expect(mergeSharedConfig(base, null).changed).toBe(false);
    expect(mergeSharedConfig(base, undefined).changed).toBe(false);
  });

  it("SHARED_CONFIG_KEYS is the documented set", () => {
    expect(SHARED_CONFIG_KEYS).toEqual([
      "groqApiKey",
      "voiceTranscriptionModel",
      "voiceCommandModel",
      "defaultModel",
      "chatAutoAllow",
      "autoRenameSessions",
      "cacheTtl",
    ]);
  });
});

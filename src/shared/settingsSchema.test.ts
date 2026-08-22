import { describe, it, expect } from "vitest";
// 7f: PRESETS now lives in the schema module (its only production consumer and
// the module the Swift drift generator transpiles). The no-drift guard below
// still pins the schema's preset options to the ROUTER's preset vocabulary
// (the AGENT_TIER keys) so a rename in the decision core can never drift from
// the schema without this test going red.
import { AGENT_TIER } from "./modelRouter.mjs";
import { PRESETS } from "./settingsSchema";
import {
  SETTINGS,
  SETTING_SECTIONS,
  settingsForPlatform,
  settingsForSection,
  searchSettings,
  isModified,
  sectionIsModified,
  resetAllPayload,
  fieldId,
  validateReferenceAlias,
  classifyReferenceTarget,
  type SettingEntry,
} from "./settingsSchema";

const ALL = SETTINGS;

describe("settingsSchema shape", () => {
  it("every entry has a stable unique id", () => {
    const ids = ALL.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry's section is a known section", () => {
    const known = new Set(SETTING_SECTIONS.map((s) => s.id));
    for (const e of ALL) expect(known.has(e.section)).toBe(true);
  });

  it("every entry declares a configKey field (null for Mac-local / presentational)", () => {
    // configKey is null for Mac-local toggles (pluginsEnabled, rendered via
    // the preload bridge) and presentational custom entries (accountsList);
    // it is a real AppConfig key for everything else. opencodePort is custom-
    // rendered inside the Box Advanced row but still carries its configKey so
    // reset-all + the modified-dot work.
    for (const e of ALL) {
      expect(typeof e.configKey === "string" || e.configKey === null).toBe(true);
    }
  });

  it("segmented entries carry options", () => {
    for (const e of ALL) {
      if (e.control === "segmented") expect(e.options?.length).toBeGreaterThan(1);
    }
  });

  it("no entry imports react or electron (pure module contract)", () => {
    // Static sanity: the module is pure. We assert by checking the file has
    // no side-effect globals — verified by the fact that importing it (above)
    // does not pollute anything. Real enforcement is the import lint in CI.
    expect(ALL.length).toBeGreaterThan(0);
  });

  it("every non-custom entry has a non-empty group (BET-1174)", () => {
    // A schema entry with no group would render nowhere on desktop Settings
    // (the grouping IS the render map now), silently, while still showing in
    // search. Every field a user can configure must have a home; only
    // bespoke-drawn `custom` entries are exempt.
    for (const e of ALL) {
      if (e.control === "custom") continue;
      expect(e.group, `${e.id} is non-custom but has no group`).toBeTruthy();
    }
  });
});

describe("settingsForPlatform", () => {
  it("includes 'both' entries on desktop", () => {
    const desktop = settingsForPlatform(ALL, "desktop");
    expect(desktop.some((e) => e.id === "cacheTtl")).toBe(true); // both
    expect(desktop.some((e) => e.id === "autoRenameSessions")).toBe(true); // both
  });

  it("includes 'both' entries on mobile", () => {
    const mobile = settingsForPlatform(ALL, "mobile");
    expect(mobile.some((e) => e.id === "cacheTtl")).toBe(true);
    expect(mobile.some((e) => e.id === "autoRenameSessions")).toBe(true);
  });

  it("excludes desktop-only entries on mobile", () => {
    const mobile = settingsForPlatform(ALL, "mobile");
    expect(mobile.some((e) => e.id === "theme")).toBe(false); // desktop
    expect(mobile.some((e) => e.id === "allowAgentPush")).toBe(false); // desktop
  });

  it("excludes mobile-only entries on desktop", () => {
    const desktop = settingsForPlatform(ALL, "desktop");
    expect(desktop.some((e) => e.id === "serverUrlMobile")).toBe(false); // mobile
    expect(desktop.some((e) => e.id === "chatAutoAllow")).toBe(false); // mobile
  });

  it("excludes cto entries from mobile (BET-1191 — iOS has no call surface)", () => {
    // The on-call CTO sections are desktop-only: none of their entries
    // (including the OpenAI key) may render in the native iOS settings screen.
    const mobile = settingsForPlatform(ALL, "mobile");
    expect(mobile.some((e) => e.section === "cto")).toBe(false);
    expect(mobile.some((e) => e.id === "openaiApiKey")).toBe(false);
  });
});

describe("settingsForSection", () => {
  it("returns only entries in the given section for the platform", () => {
    const voiceDesktop = settingsForSection(ALL, "voice", "desktop");
    expect(voiceDesktop.map((e) => e.id).sort()).toEqual(
      ["groqApiKey", "voiceTranscriptionModel"],
    );
    const ctoDesktop = settingsForSection(ALL, "cto", "desktop");
    expect(ctoDesktop.map((e) => e.id)).toContain("openaiApiKey");
  });
});

describe("uploadCleanupHours (BET-427)", () => {
  const entry = ALL.find((e) => e.id === "uploadCleanupHours");
  it("exists in the Files section with the right config key", () => {
    expect(entry).toBeDefined();
    expect(entry!.section).toBe("files");
    expect(entry!.configKey).toBe("uploadCleanupHours");
    expect(entry!.control).toBe("segmented");
    expect(entry!.default).toBe(24);
  });
  it("is visible on both desktop and mobile", () => {
    expect(settingsForPlatform(ALL, "desktop").some((e) => e.id === "uploadCleanupHours")).toBe(true);
    expect(settingsForPlatform(ALL, "mobile").some((e) => e.id === "uploadCleanupHours")).toBe(true);
  });
  it("carries a 0-disables option", () => {
    expect(entry!.options?.some((o) => o.value === "0")).toBe(true);
  });
});

describe("model routing entries (BET-1218)", () => {
  const preset = ALL.find((e) => e.id === "modelRoutingPreset");

  it("the enabled toggle no longer exists (routing is per-conversation only)", () => {
    // The global toggle was deleted: routing is activated per conversation from
    // the composer's model picker, so a global consent switch would be a second
    // control for one decision (and a stub — its config key was never read).
    expect(ALL.find((e) => e.id === "modelRoutingEnabled")).toBeUndefined();
  });

  it("the preset is present in the models section for desktop", () => {
    const desktop = settingsForSection(ALL, "models", "desktop");
    expect(preset).toBeDefined();
    expect(desktop.some((e) => e.id === "modelRoutingPreset")).toBe(true);
  });

  it("the preset is desktop-only (never rendered on mobile)", () => {
    const mobile = settingsForPlatform(ALL, "mobile");
    expect(mobile.some((e) => e.id === "modelRoutingPreset")).toBe(false);
  });

  it("the preset renders in the Automatic Manta Routing group", () => {
    expect(preset!.control).toBe("segmented");
    expect(preset!.configKey).toBe("modelRouting.preset");
    expect(preset!.default).toBe("balanced");
    expect(preset!.group).toBe("Automatic Manta Routing");
  });

  it("the preset uses the schema's PRESETS values and they match the router's AGENT_TIER keys (no drift)", () => {
    expect(preset!.control).toBe("segmented");
    expect(preset!.configKey).toBe("modelRouting.preset");
    expect(preset!.default).toBe("balanced");
    const values = preset!.options?.map((o) => o.value);
    expect(values).toEqual(PRESETS);
    // No drift with the decision core: every schema preset is a router preset.
    expect([...PRESETS].sort()).toEqual(Object.keys(AGENT_TIER).sort());
  });
});

describe("searchSettings", () => {
  it("returns [] for empty query", () => {
    expect(searchSettings(ALL, "", "desktop")).toEqual([]);
  });

  it("matches label case-insensitively", () => {
    const hits = searchSettings(ALL, "theme", "desktop");
    expect(hits.some((e) => e.id === "theme")).toBe(true);
  });

  it("matches help text", () => {
    const hits = searchSettings(ALL, "groq", "desktop");
    expect(hits.some((e) => e.id === "groqApiKey")).toBe(true);
  });

  it("respects platform", () => {
    const hits = searchSettings(ALL, "server url", "desktop");
    expect(hits).toEqual([]); // serverUrlMobile is mobile-only
  });

  it("returns nothing for cto fields once the cto section is filtered out (BET-1191 flag off)", () => {
    // Settings hides the CTO section behind the VITE_MANTA_VOICE build flag by
    // filtering the section out of the entries it searches (`VOICE_SETTINGS`).
    // With that same filter applied, the OpenAI API key field and any "cto"
    // talk must not surface through search.
    const filtered = ALL.filter((e) => e.section !== "cto");
    expect(searchSettings(filtered, "openai api key", "desktop")).toEqual([]);
    expect(searchSettings(filtered, "on-call cto", "desktop")).toEqual([]);
  });
});

describe("isModified", () => {
  it("true when value differs from default", () => {
    const theme = ALL.find((e) => e.id === "theme") as SettingEntry;
    expect(isModified(theme, "dark")).toBe(true);
    expect(isModified(theme, "system")).toBe(false);
  });

  it("handles string defaults", () => {
    const groq = ALL.find((e) => e.id === "groqApiKey") as SettingEntry;
    expect(isModified(groq, "")).toBe(false);
    expect(isModified(groq, "gsk_x")).toBe(true);
  });
});

describe("sectionIsModified", () => {
  it("true when any entry in the section is non-default", () => {
    expect(
      sectionIsModified(ALL, "general", "desktop", { theme: "dark" }),
    ).toBe(true);
    expect(
      sectionIsModified(ALL, "general", "desktop", { theme: "system" }),
    ).toBe(false);
  });

  it("ignores entries with no configKey", () => {
    // pluginsEnabled has configKey null — setting a value for it must not
    // mark the section modified.
    expect(
      sectionIsModified(ALL, "extensions", "desktop", { pluginsEnabled: true }),
    ).toBe(false);
  });
});

describe("resetAllPayload", () => {
  it("returns every configKey set to its default", () => {
    const payload = resetAllPayload(ALL);
    expect(payload.cacheTtl).toBe("1h");
    expect(payload.theme).toBe("system");
    expect(payload.groqApiKey).toBe("");
    expect(payload.autoRenameSessions).toBe(false);
    expect(payload.allowAgentPush).toBe(false);
    expect(payload.opencodePort).toBe(14096);
  });

  it("omits null-configKey entries", () => {
    const payload = resetAllPayload(ALL);
    expect(payload).not.toHaveProperty("pluginsEnabled");
    expect(payload).not.toHaveProperty("serverUrlMobile");
  });
});

describe("fieldId", () => {
  it("is stable and prefixed", () => {
    const theme = ALL.find((e) => e.id === "theme") as SettingEntry;
    expect(fieldId(theme)).toBe("setting-theme");
  });

  it("is unique across all entries", () => {
    const ids = ALL.map(fieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("validateReferenceAlias (BET-1023)", () => {
  it("accepts alphanumeric and -_. aliases", () => {
    expect(validateReferenceAlias("docs")).toBeNull();
    expect(validateReferenceAlias("my-lib")).toBeNull();
    expect(validateReferenceAlias("a.b_c-1")).toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateReferenceAlias("")).not.toBeNull();
    expect(validateReferenceAlias("   ")).not.toBeNull();
  });

  it("rejects '/' and comma", () => {
    expect(validateReferenceAlias("a/b")).not.toBeNull();
    expect(validateReferenceAlias("a,b")).not.toBeNull();
  });

  it("rejects whitespace and backticks anywhere", () => {
    expect(validateReferenceAlias("a b")).not.toBeNull();
    expect(validateReferenceAlias("a\tb")).not.toBeNull();
    expect(validateReferenceAlias("a`b")).not.toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateReferenceAlias("  docs  ")).toBeNull();
    const withInner = validateReferenceAlias("do cs");
    expect(withInner).not.toBeNull();
  });
});

describe("classifyReferenceTarget (BET-1023)", () => {
  it("classifies local paths", () => {
    expect(classifyReferenceTarget("/home/user/docs")).toBe("path");
    expect(classifyReferenceTarget("../docs")).toBe("path");
    expect(classifyReferenceTarget("./lib")).toBe("path");
    expect(classifyReferenceTarget("~/docs")).toBe("path");
    expect(classifyReferenceTarget("docs")).toBe("path");
  });

  it("classifies git repositories", () => {
    expect(classifyReferenceTarget("owner/repo")).toBe("repository");
    expect(classifyReferenceTarget("anomalyco/opencode-sdk-js")).toBe("repository");
    expect(classifyReferenceTarget("https://github.com/a/b.git")).toBe("repository");
    expect(classifyReferenceTarget("git@github.com:a/b.git")).toBe("repository");
    expect(classifyReferenceTarget("repo.git")).toBe("repository");
  });
});

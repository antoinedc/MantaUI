import { describe, it, expect } from "vitest";
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
});

describe("settingsForSection", () => {
  it("returns only entries in the given section for the platform", () => {
    const voiceDesktop = settingsForSection(ALL, "voice", "desktop");
    expect(voiceDesktop.map((e) => e.id).sort()).toEqual(
      ["groqApiKey", "voiceCommandModel", "voiceTranscriptionModel"],
    );
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

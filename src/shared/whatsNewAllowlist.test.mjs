import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WHATS_NEW_ICONS,
  WHATS_NEW_DEFAULT_ICON,
  WHATS_NEW_SETTINGS_SECTIONS,
  isWhatsNewAction,
  normalizeWhatsNewIcon,
} from "./whatsNewAllowlist.mjs";

// settingsSchema.ts is TypeScript, so read its text and pull the section ids
// out of the SETTING_SECTIONS array literal.
function schemaSectionIds() {
  const src = readFileSync(new URL("./settingsSchema.ts", import.meta.url), "utf8");
  const m = src.match(/export const SETTING_SECTIONS[^=]*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(m, "could not find SETTING_SECTIONS in settingsSchema.ts");
  const ids = [...m[1].matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(ids.length > 0, "no section ids parsed from SETTING_SECTIONS");
  return ids;
}

test("WHATS_NEW_SETTINGS_SECTIONS equals SETTING_SECTIONS minus cto", () => {
  assert.deepEqual([...WHATS_NEW_SETTINGS_SECTIONS], schemaSectionIds().filter((id) => id !== "cto"));
});

test("the default icon is in the icon list", () => {
  assert.ok(WHATS_NEW_ICONS.includes(WHATS_NEW_DEFAULT_ICON));
  assert.equal(WHATS_NEW_ICONS.length, 15);
});

test("isWhatsNewAction: routines and settings:<section> only", () => {
  assert.equal(isWhatsNewAction("routines"), true);
  for (const id of WHATS_NEW_SETTINGS_SECTIONS) assert.equal(isWhatsNewAction(`settings:${id}`), true);
  for (const bad of ["settings:cto", "settings:", "settings", "settings:nope", "Routines", "routines ", "", null, undefined, 3, {}]) {
    assert.equal(isWhatsNewAction(bad), false, String(bad));
  }
});

test("normalizeWhatsNewIcon keeps allowed names and defaults the rest", () => {
  assert.equal(normalizeWhatsNewIcon("repeat"), "repeat");
  assert.equal(normalizeWhatsNewIcon("rocket"), "sparkles");
  assert.equal(normalizeWhatsNewIcon(undefined), "sparkles");
  assert.equal(normalizeWhatsNewIcon(5), "sparkles");
});

test("the exported lists are frozen", () => {
  assert.ok(Object.isFrozen(WHATS_NEW_ICONS));
  assert.ok(Object.isFrozen(WHATS_NEW_SETTINGS_SECTIONS));
});

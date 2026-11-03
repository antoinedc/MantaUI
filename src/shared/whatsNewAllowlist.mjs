// The closed vocabularies a CHANGELOG highlights block may use. The server
// validates against them (src/server/changelog.mjs) and the desktop checks them
// again against what its own build can open, so a card never carries a dead link.
// Spec: docs/superpowers/specs/2026-11-03-whats-new-modal.md

export const WHATS_NEW_ICONS = Object.freeze([
  "sparkles",
  "repeat",
  "arrow-left-right",
  "refresh-cw",
  "zap",
  "message-square",
  "terminal",
  "folder",
  "settings",
  "shield",
  "bell",
  "mic",
  "gauge",
  "git-branch",
  "calendar-clock",
]);

export const WHATS_NEW_DEFAULT_ICON = "sparkles";

// SETTING_SECTIONS in settingsSchema.ts minus "cto" (build-gated). A test pins
// this list to that one so a section added or removed there fails loudly here.
export const WHATS_NEW_SETTINGS_SECTIONS = Object.freeze([
  "general",
  "box",
  "accounts",
  "models",
  "sessions",
  "files",
  "extensions",
  "secrets",
  "voice",
]);

export function isWhatsNewAction(value) {
  if (typeof value !== "string") return false;
  if (value === "routines") return true;
  if (!value.startsWith("settings:")) return false;
  return WHATS_NEW_SETTINGS_SECTIONS.includes(value.slice("settings:".length));
}

export function normalizeWhatsNewIcon(value) {
  return typeof value === "string" && WHATS_NEW_ICONS.includes(value) ? value : WHATS_NEW_DEFAULT_ICON;
}

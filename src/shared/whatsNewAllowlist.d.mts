// Hand-written type declarations for whatsNewAllowlist.mjs (the renderer's
// tsconfig has no allowJs, so it needs these). Keep in sync with it.

export const WHATS_NEW_ICONS: readonly string[];
export const WHATS_NEW_DEFAULT_ICON: "sparkles";
export const WHATS_NEW_SETTINGS_SECTIONS: readonly string[];
export function isWhatsNewAction(value: unknown): boolean;
export function normalizeWhatsNewIcon(value: unknown): string;

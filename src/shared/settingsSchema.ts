// BET-419 §B / BET-420 — one settings schema, shared by desktop Settings.tsx
// and mobile MobileSettings.tsx. Pure module: NO imports from `react` or
// `electron`. Both surfaces render their simple fields from this schema;
// complex cards (ModelsCard, the merged Accounts list, plugins, skill-
// registries list, launcher flags, pairing, box status) stay as per-section
// custom content rendered alongside the schema-driven fields.
//
// BET-420 restructured the six flat tabs into eight sections clustered as
// three ideas:
//
//   General                    ← ungrouped, at the top (about THIS app)
//   ── SETUP ──
//   Box                        ← the thing you paired with
//   Accounts                   ← ways to reach a model (subs + endpoints)
//   Models                     ← which model, cache TTL
//   ── AGENT ──
//   Sessions                   ← per-session behaviour
//   Files                      ← agent ↔ laptop file flow
//   Extensions                 ← plugins, skill registries, AI-CLI flags
//   Voice                      ← Groq STT
//
// Four things fall out of this schema (all implemented in BET-419):
//   1. Search (label + help) across every section.
//   2. "Modified" dot on a section containing a non-default value.
//   3. Reset all settings (danger zone, General).
//   4. `htmlFor`/`id` wiring on every field (a11y).

export type SettingControl =
  | "toggle"
  | "text"
  | "password"
  | "path"
  | "segmented"
  | "custom";

export type SettingPlatform = "both" | "desktop" | "mobile";

export type SettingSectionId =
  | "general"
  | "box"
  | "accounts"
  | "models"
  | "sessions"
  | "files"
  | "extensions"
  | "voice";

export type SettingSection = {
  id: SettingSectionId;
  label: string;
  /** Optional cluster divider rendered above this entry in the nav. */
  group?: "SETUP" | "AGENT";
};

export type SettingEntry = {
  /** Stable id used as the field's DOM id suffix and React key. */
  id: string;
  section: SettingSectionId;
  label: string;
  /** Longer help copy shown under the control. Empty string = none. */
  help: string;
  control: SettingControl;
  /** AppConfig key this entry reads/writes via configUpdate. null for
   *  `custom` entries (rendered by the surface itself). */
  configKey: string | null;
  platform: SettingPlatform;
  /** Default value (the "unmodified" baseline for the Modified dot + Reset). */
  default: unknown;
  /** For `segmented`: the ordered option list. */
  options?: { value: string; label: string }[];
  /** For `password`/credentials: commit on blur, not per keystroke. */
  commitOnBlur?: boolean;
  /** Placeholder for text/path/password. */
  placeholder?: string;
};

// General sits above the clusters because it is about this app, not the box
// or the agent. The `group` markers drive the cluster dividers in the nav.
export const SETTING_SECTIONS: SettingSection[] = [
  { id: "general", label: "General" },
  { id: "box", label: "Box", group: "SETUP" },
  { id: "accounts", label: "Accounts", group: "SETUP" },
  { id: "models", label: "Models", group: "SETUP" },
  { id: "sessions", label: "Sessions", group: "AGENT" },
  { id: "files", label: "Files", group: "AGENT" },
  { id: "extensions", label: "Extensions", group: "AGENT" },
  { id: "voice", label: "Voice", group: "AGENT" },
];

// The schema. `custom` entries are placeholders so search/section listing
// stays consistent — the surface renders their real component in place.
export const SETTINGS: SettingEntry[] = [
  // ----- general (about this app) -----
  {
    id: "theme",
    section: "general",
    label: "Theme",
    help: "System follows your OS appearance and re-themes live.",
    control: "segmented",
    configKey: "theme",
    platform: "desktop",
    default: "system",
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },

  // ----- box (the paired box) -----
  {
    id: "serverUrlMobile",
    section: "box",
    label: "Server URL",
    help: "Leave blank to use the page's own origin (default). Override only if your Manta server is on a different host.",
    control: "text",
    configKey: null, // mobile-local (localStorage), not a server config key
    platform: "mobile",
    default: "",
    placeholder: "https://manta.example.com",
  },
  {
    id: "opencodePort",
    section: "box",
    label: "opencode port",
    help: "Local port forwarded to the box's opencode serve instance. Defaults to 14096 to avoid colliding with a local opencode on 4096.",
    control: "custom", // rendered inside the Box "Advanced" row (desktop)
    configKey: "opencodePort",
    platform: "desktop",
    default: 14096,
  },

  // ----- accounts (subscriptions + custom endpoints — one list) -----
  {
    id: "accountsList",
    section: "accounts",
    label: "Accounts",
    help: "Sign in with a subscription you already pay for, or add your own OpenAI-compatible endpoint. Both are just a way to reach a model.",
    control: "custom",
    configKey: null,
    platform: "both",
    default: null,
  },

  // ----- models (default/main/sub table + cache TTL) -----
  {
    id: "cacheTtl",
    section: "models",
    label: "Prompt cache TTL",
    help: "How long Anthropic keeps a session's prompt cache warm. Must match opencode's cache_control.ttl — Manta only uses this to predict when a chat has gone stale.",
    control: "segmented",
    configKey: "cacheTtl",
    platform: "both",
    default: "1h",
    options: [
      { value: "5m", label: "5 minutes" },
      { value: "1h", label: "1 hour" },
    ],
  },

  // ----- sessions (per-session behaviour) -----
  {
    id: "autoRenameSessions",
    section: "sessions",
    label: "Auto-rename sessions",
    help: "Every few turns, ask the model for a 1-2 word title and rename the chat window to match the current work. Overwrites the window name, including names you set by hand.",
    control: "toggle",
    configKey: "autoRenameSessions",
    platform: "both",
    default: false,
  },
  {
    id: "worktreePerSession",
    section: "sessions",
    label: "Create git worktree for new sessions",
    help: "When creating a new chat session in a project that's a git repo, automatically branch a sibling worktree and start the session on its own branch. Has no effect on non-git projects.",
    control: "toggle",
    configKey: "worktreePerSession",
    platform: "desktop",
    default: false,
  },
  {
    id: "worktreeCleanOnClose",
    section: "sessions",
    label: "Remove worktree when a session is closed",
    help: "Deletes the session's git worktree on close. Prompts before discarding uncommitted changes.",
    control: "toggle",
    configKey: "worktreeCleanOnClose",
    platform: "desktop",
    default: false,
  },
  {
    id: "chatAutoAllow",
    section: "sessions",
    label: "Auto-allow tool permissions",
    help: "Auto-reply \"always\" to every permission request — equivalent to opencode's --dangerously-skip-permissions. Question tool requests still require an explicit answer.",
    control: "toggle",
    configKey: "chatAutoAllow",
    platform: "mobile",
    default: false,
  },

  // ----- files (agent ↔ laptop file flow) -----
  {
    id: "allowAgentPush",
    section: "files",
    label: "Auto-save files the AI sends",
    help: "When the AI drops a file in ~/.manta-outbox on the remote, save it to your downloads folder without asking. Off = a toast asks before each file is saved.",
    control: "toggle",
    configKey: "allowAgentPush",
    platform: "desktop",
    default: false,
  },
  {
    id: "downloadsDir",
    section: "files",
    label: "Downloads directory",
    help: "Destination for AI-sent files. Absolute path; leave empty for your OS Downloads folder.",
    control: "path",
    configKey: "downloadsDir",
    platform: "desktop",
    default: "",
    placeholder: "~/Downloads (default)",
  },

  // ----- extensions (plugins, skill registries, AI-CLI flags) -----
  {
    id: "pluginsEnabled",
    section: "extensions",
    label: "Run plugins on this machine",
    help: "Lets the AI trigger the plugins below — each is a YAML file on this machine; the AI can also create and edit them when this is on. Takes effect after restarting Manta.",
    control: "toggle",
    configKey: null, // Mac-local (preload bridge), not a server config key
    platform: "desktop",
    default: false,
  },

  // ----- voice (Groq STT) -----
  {
    id: "groqApiKey",
    section: "voice",
    label: "Groq API key",
    help: "Enables push-to-talk dictation in the chat composer. Leave blank to disable voice.",
    control: "password",
    configKey: "groqApiKey",
    platform: "both",
    default: "",
    commitOnBlur: true,
    placeholder: "gsk_… (leave blank to disable)",
  },
  {
    id: "voiceTranscriptionModel",
    section: "voice",
    label: "Transcription model",
    help: "",
    control: "text",
    configKey: "voiceTranscriptionModel",
    platform: "both",
    default: "",
    placeholder: "whisper-large-v3-turbo",
  },
  {
    id: "voiceCommandModel",
    section: "voice",
    label: "Command classifier model",
    help: "",
    control: "text",
    configKey: "voiceCommandModel",
    platform: "both",
    default: "",
    placeholder: "llama-3.1-8b-instant",
  },
];

// ----- pure helpers -----

/** Entries visible on a given platform (both + that platform). */
export function settingsForPlatform(
  entries: SettingEntry[],
  platform: "desktop" | "mobile",
): SettingEntry[] {
  return entries.filter(
    (e) => e.platform === "both" || e.platform === platform,
  );
}

/** Entries in a given section for a given platform. */
export function settingsForSection(
  entries: SettingEntry[],
  section: SettingSectionId,
  platform: "desktop" | "mobile",
): SettingEntry[] {
  return settingsForPlatform(entries, platform).filter(
    (e) => e.section === section,
  );
}

/** Case-insensitive search over label + help. Returns matching entries. */
export function searchSettings(
  entries: SettingEntry[],
  query: string,
  platform: "desktop" | "mobile",
): SettingEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return settingsForPlatform(entries, platform).filter((e) => {
    const hay = `${e.label}\n${e.help}`.toLowerCase();
    return hay.includes(q);
  });
}

/** True when the entry's current value differs from its default. */
export function isModified(entry: SettingEntry, value: unknown): boolean {
  return value !== entry.default;
}

/** True when any entry in the section (for the platform) is non-default. */
export function sectionIsModified(
  entries: SettingEntry[],
  section: SettingSectionId,
  platform: "desktop" | "mobile",
  values: Record<string, unknown>,
): boolean {
  return settingsForSection(entries, section, platform).some(
    (e) => e.configKey != null && isModified(e, values[e.configKey] ?? e.default),
  );
}

/** Build the "reset all" payload: every schema entry with a configKey set
 *  back to its default. Entries with configKey null (Mac-local / localStorage)
 *  are handled by the surface, not here. */
export function resetAllPayload(
  entries: SettingEntry[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    if (e.configKey == null) continue;
    out[e.configKey] = e.default;
  }
  return out;
}

/** Stable DOM id for a field (used by htmlFor / id wiring). */
export function fieldId(entry: SettingEntry): string {
  return `setting-${entry.id}`;
}

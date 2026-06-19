// Hand-written type declarations for sharedConfig.mjs. The implementation is
// plain JS so the mobile server imports it natively; main imports through
// bundler resolution. Keep in sync with src/shared/sharedConfig.mjs.

import type { AppConfig } from "./types.js";

// The device-independent subset of AppConfig that syncs across devices, plus
// the LWW timestamp.
export type SharedConfigKey =
  | "groqApiKey"
  | "voiceTranscriptionModel"
  | "voiceCommandModel"
  | "defaultModel"
  | "chatAutoAllow"
  | "autoRenameSessions"
  | "cacheTtl";

export type SharedConfigSnapshot = Partial<Pick<AppConfig, SharedConfigKey>> & {
  configUpdatedAt?: number;
};

export const SHARED_CONFIG_KEYS: SharedConfigKey[];

export function patchTouchesSharedConfig(patch: Partial<AppConfig>): boolean;

export function extractSharedConfig(cfg: Partial<AppConfig>): SharedConfigSnapshot;

export function mergeSharedConfig(
  local: AppConfig,
  incoming: SharedConfigSnapshot | null | undefined,
): { config: AppConfig; changed: boolean };

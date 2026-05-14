import { app } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AppConfig } from "../shared/types.js";

const DEFAULT_CONFIG: AppConfig = {
  host: "",
  projects: [],
  uploadCleanupHours: 1,
};

function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

export function loadConfig(): AppConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig> & {
      sessions?: unknown;
    };
    // Migration: drop the old `sessions` field if present.
    delete parsed.sessions;
    // Migration: old project shape used { id, name, defaultCwd }. Coerce to
    // { tmuxSession, defaultCwd } using the old name as the tmux session name.
    if (parsed.projects) {
      parsed.projects = parsed.projects.map((p: any) => {
        if (p.tmuxSession) return p;
        return { tmuxSession: p.name ?? "untitled", defaultCwd: p.defaultCwd ?? "~" };
      });
    }
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

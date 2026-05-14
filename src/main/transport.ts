import { spawn as cpSpawn } from "node:child_process";
import type { AppConfig, TransportInfo } from "../shared/types.js";

// Cached detection. Cleared if host changes (probed lazily).
let cache: { host: string; moshLocal: boolean; moshRemote: boolean } | null = null;

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = cpSpawn("which", [bin], { stdio: ["ignore", "pipe", "pipe"] });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function remoteHas(config: AppConfig, bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!config.host) return resolve(false);
    const args: string[] = [];
    if (config.identityFile) args.push("-i", config.identityFile);
    const target = config.user ? `${config.user}@${config.host}` : config.host;
    args.push("-o", "ConnectTimeout=4", "-o", "BatchMode=yes", target, `command -v ${bin} >/dev/null 2>&1`);
    const p = cpSpawn("ssh", args, { stdio: ["ignore", "ignore", "ignore"] });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

export async function detect(config: AppConfig): Promise<{ moshLocal: boolean; moshRemote: boolean }> {
  if (cache && cache.host === config.host) {
    return { moshLocal: cache.moshLocal, moshRemote: cache.moshRemote };
  }
  const [moshLocal, moshRemote] = await Promise.all([
    which("mosh"),
    remoteHas(config, "mosh-server"),
  ]);
  cache = { host: config.host, moshLocal, moshRemote };
  return { moshLocal, moshRemote };
}

export function invalidate(): void {
  cache = null;
}

export async function info(config: AppConfig): Promise<TransportInfo> {
  const preference = config.transport ?? "auto";
  const { moshLocal, moshRemote } = await detect(config);
  let effective: "mosh" | "ssh";
  if (preference === "mosh") effective = "mosh";
  else if (preference === "ssh") effective = "ssh";
  else effective = moshLocal && moshRemote ? "mosh" : "ssh";
  return { effective, preference, moshLocal, moshRemote };
}

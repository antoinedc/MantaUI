// iosBuild.ts — the ONLY iOS-specific file in the MantaUI plugin system.
//
// Implements the `ios.build` capability (BET-183 / BET-185 stage 2). Compiles
// the MantaUI iOS app on the connected Mac and (by default) launches it in the
// iOS Simulator. Lives under src/main/handlers/ so capExecutor's HANDLERS map
// dispatches to it — adding capability #2 = new file under handlers/ + new
// HANDLERS entry, NO core changes.
//
// The generic plumbing (queue, SSE, catch-up, auth, batched logs, timeouts)
// lives in src/main/capExecutor.ts and src/server/capabilities.mjs. This
// handler ONLY knows how to take an `input.action` / `input.pull` and turn it
// into xcodebuild output. Node builtins only.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// The plugin-seam context this handler receives from capExecutor. Matches the
// spec EXACTLY — `secret()` is intentionally absent (see doc string on
// ctx below; v1 capability #1 needs no secrets).
// ---------------------------------------------------------------------------

export type CapCtx = {
  input: unknown;
  config: AppConfig;
  log(line: string): void;
  // spawn helper — argv array, never a shell string. PATH is pre-patched by
  // capExecutor so Homebrew/nvm binaries are visible to this GUI app.
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; quiet?: boolean },
  ): Promise<{ code: number; stdout: string }>;
  signal: AbortSignal;
};

export type CapHandler = (ctx: CapCtx) => Promise<{ result?: unknown }>;

// Bundle id used for `simctl launch`. Mirrors the AGENTS.md §"App Store Connect
// facts" canonical value — keep in sync if the bundle id ever moves.
const BUNDLE_ID = "com.antoinedc.mantaui";

// Pinned derived-data dir. Hardcoded per spec — sharing one DerivedData dir
// across parallel xcodebuilds would corrupt it. The Mac executor SERIALIZES
// jobs (capExecutor is one-at-a-time), so a single pinned path is safe and
// makes subsequent builds incremental.
function derivedDataDir(): string {
  return join(homedir(), "Library", "Caches", "MantaUI", "DerivedData");
}

function derivedAppPath(): string {
  return join(
    derivedDataDir(),
    "Build",
    "Products",
    "Debug-iphonesimulator",
    "App.app",
  );
}

// Expand a leading "~" against os.homedir(). Only used for the user-supplied
// repo path — keeps the server-side path resolution out of main/.
function expandTilde(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// ---------------------------------------------------------------------------
// `pickSimulator` — pure function implementing the spec's exact algorithm.
// Exported + tested because every test in the spec (`preferred found / not
// found`, `Booted preferred`, `highest-runtime iPhone fallback`, `no devices`,
// `isAvailable:false excluded`) lives here.
//
// Input shape: real `xcrun simctl list devices available --json` output,
// which looks like:
//
//   { "devices": {
//       "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
//         { udid, name, state, isAvailable, ... }
//       ],
//       "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [ ... ]
//   }}
// ---------------------------------------------------------------------------

export type SimDevice = {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
};

export type SimPickResult =
  | { ok: true; udid: string; name: string }
  | { ok: false; error: string };

export function pickSimulator(
  devicesJson: { devices?: Record<string, SimDevice[] | undefined> } | null | undefined,
  preferredName?: string,
): SimPickResult {
  const devices = devicesJson?.devices ?? {};
  // Flatten runtime keys containing "SimRuntime.iOS", dropping unavailable.
  const all: Array<{ runtime: string; device: SimDevice }> = [];
  for (const [runtime, list] of Object.entries(devices)) {
    if (!runtime.includes("SimRuntime.iOS")) continue;
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (d?.isAvailable === false) continue;
      all.push({ runtime, device: d });
    }
  }

  const candidates = preferredName
    ? all.filter((c) => c.device.name === preferredName)
    : all;

  if (preferredName && candidates.length === 0) {
    const names = Array.from(
      new Set(all.map((c) => c.device.name).filter(Boolean)),
    ).sort();
    return {
      ok: false,
      error: `simulator "${preferredName}" not found; available: ${names.join(", ") || "(none)"}`,
    };
  }

  if (candidates.length === 0) {
    return { ok: false, error: "no iOS simulators available — install one in Xcode" };
  }

  // 1. Booted preferred (or first booted if no preferred).
  const booted = candidates.find((c) => c.device.state === "Booted");
  if (booted) {
    return {
      ok: true,
      udid: booted.device.udid ?? "",
      name: booted.device.name ?? "",
    };
  }

  // 2. Highest iOS runtime version, first device whose name starts with "iPhone".
  const sorted = [...candidates].sort((a, b) => {
    const va = parseRuntimeVersion(a.runtime);
    const vb = parseRuntimeVersion(b.runtime);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const ai = va[i] ?? 0;
      const bi = vb[i] ?? 0;
      if (ai !== bi) return bi - ai;
    }
    return 0;
  });
  const iphone = sorted.find((c) => (c.device.name ?? "").startsWith("iPhone"));
  if (iphone) {
    return {
      ok: true,
      udid: iphone.device.udid ?? "",
      name: iphone.device.name ?? "",
    };
  }

  // 3. First candidate.
  const first = candidates[0];
  return {
    ok: true,
    udid: first.device.udid ?? "",
    name: first.device.name ?? "",
  };
}

// Parse `iOS-17-5` → [17, 5] from a runtime key like
// `com.apple.CoreSimulator.SimRuntime.iOS-17-5`. Returns [0] when the key has
// no `iOS-<digits>` tail.
function parseRuntimeVersion(runtime: string): number[] {
  const tail = runtime.split("SimRuntime.iOS-").pop() ?? "";
  const parts = tail.split("-").filter((s) => /^\d+$/.test(s));
  return parts.map((p) => Number.parseInt(p, 10));
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

type IosBuildInput = {
  action?: "build-and-launch" | "test" | "compile-only";
  pull?: boolean;
};

export const iosBuildHandler: CapHandler = async (ctx) => {
  const input = (ctx.input ?? {}) as IosBuildInput;
  const action = input.action ?? "build-and-launch";

  // Step 0 — precheck. Failures here propagate with the PATH hint baked in
  // by capExecutor's exec helper.
  await ctx.exec("xcodebuild", ["-version"]);
  await ctx.exec("npm", ["--version"]);

  // Step 1 — repo path. Default ~/projects/better-ui; expand a leading "~"
  // against os.homedir() locally (no server import).
  const repo = expandTilde(
    (ctx.config.iosBuildRepoPath ?? "").trim() || "~/projects/better-ui",
  );

  // Step 2 — optional pull. Pulls main only (--ff-only); the tool description
  // carries the warning that this builds the Mac clone on main, not the
  // session's branch.
  if (input.pull) {
    await ctx.exec("git", ["-C", repo, "pull", "--ff-only", "origin", "main"]);
  }

  // Step 3 — web bundle + cap sync. The mobile/www bundle must exist before
  // the Capacitor build (see AGENTS.md §"MOBILE CHANGES REACH DEVICES…").
  await ctx.exec("npm", ["run", "build:mobile"], { cwd: repo });
  await ctx.exec("npx", ["cap", "sync", "ios"], { cwd: repo });

  // Step 4 — simulator resolution. Run quietly — JSON output would pollute
  // the user-visible log.
  const simList = await ctx.exec(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { quiet: true },
  );
  let parsed: { devices?: Record<string, SimDevice[] | undefined> };
  try {
    parsed = JSON.parse(simList.stdout) as typeof parsed;
  } catch (e) {
    throw new Error(`failed to parse simctl list JSON: ${(e as Error).message}`);
  }
  const picked = pickSimulator(parsed, ctx.config.iosSimulatorName);
  if (!picked.ok) throw new Error(picked.error);
  const { udid, name: simName } = picked;

  // Step 5 — build (or test, or compile-only). Simulator SDK = no signing.
  const derivedData = derivedDataDir();
  const appPath = derivedAppPath();
  const xcodeArg =
    action === "test" ? "test" : "build";
  const buildRes = await ctx.exec(
    "xcodebuild",
    [
      "-workspace",
      join(repo, "mobile/ios/App/App.xcworkspace"),
      "-scheme",
      "App",
      "-sdk",
      "iphonesimulator",
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${udid}`,
      "-derivedDataPath",
      derivedData,
      xcodeArg,
    ],
    { cwd: repo },
  );
  if (buildRes.code !== 0) {
    throw new Error(`xcodebuild ${xcodeArg}: exit ${buildRes.code}`);
  }

  // Verify the pinned .app actually landed where we expect — `xcodebuild`
  // exit 0 can still miss the expected output if the workspace path was
  // wrong, etc.
  if (!existsSync(appPath)) {
    throw new Error(`build succeeded but App.app not found at ${appPath}`);
  }

  // Step 6 — boot + launch (default only).
  if (action === "build-and-launch") {
    // "already booted" is non-zero; that's fine.
    await ctx.exec("xcrun", ["simctl", "boot", udid]).catch(() => {});
    // Open the Simulator app so the user sees a window. Non-zero needs a
    // real GUI session; surface it.
    const openSim = await ctx.exec("open", ["-a", "Simulator"]);
    if (openSim.code !== 0) {
      throw new Error(`open -a Simulator: exit ${openSim.code}`);
    }
    const install = await ctx.exec("xcrun", [
      "simctl",
      "install",
      udid,
      appPath,
    ]);
    if (install.code !== 0) {
      throw new Error(`simctl install: exit ${install.code}`);
    }
    const launch = await ctx.exec("xcrun", [
      "simctl",
      "launch",
      udid,
      BUNDLE_ID,
    ]);
    if (launch.code !== 0) {
      throw new Error(`simctl launch: exit ${launch.code}`);
    }
    return { result: { appPath, simUdid: udid, simName, launched: true } };
  }

  if (action === "test") {
    return { result: { tested: true, simUdid: udid, simName } };
  }

  // compile-only
  return { result: { appPath, simUdid: udid, simName, launched: false } };
};

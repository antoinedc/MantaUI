#!/usr/bin/env node
// upgrade-clis.mjs — the whole "upgrade every installed AI CLI" loop (BET-1097,
// stage 2 of the unified-update epic).
//
// `scripts/self-update.sh` calls this exactly once, in place of the old
// `upgrade_opencode()`. It reads the stage-1 catalog + detector directly
// (src/shared/cliCatalog.mjs + src/server/cliUpdates.mjs), so there is exactly
// ONE place that knows how to find and upgrade a CLI — bash never re-implements
// any of it.
//
// For each INSTALLED CLI with a RESOLVED upgrade command it:
//   * prints `MANTA_PROGRESS <step>/<total> Updating <label>` before running it
//     (the SAME step number every time — the refined label updates the bar text
//     without advancing it),
//   * reads the version, runs the upgrade command, reads the version again,
//   * a CLI whose version string changed is a CHANGED CLI.
//
// Rules:
//   * Non-fatal throughout — an offline box, a missing CLI, a refused upgrade
//     or a vendor endpoint that 500s logs a warning and moves on. A CLI must
//     never abort a box update.
//   * Per-CLI timeout 10 minutes.
//   * `manual` CLIs (no resolvable upgrade command — e.g. a Homebrew-managed
//     binary) are skipped silently.
//   * On exit it ALWAYS writes the state file (`CLIS_CHANGED=` +
//     `OPENCODE_CHANGED=`), even on failure (empty values), so bash never reads
//     a stale one.
//
// Usage:
//   node scripts/upgrade-clis.mjs \
//     --progress-step=2 --progress-total=7 --state-file=<path>

import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { CLI_CATALOG } from "../src/shared/cliCatalog.mjs";
import { detectClis, readVersion, resolveBinary } from "../src/server/cliUpdates.mjs";

const PER_CLI_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const out = { progressStep: "2", progressTotal: "7", stateFile: null };
  for (const arg of argv) {
    if (arg.startsWith("--progress-step=")) out.progressStep = arg.slice("--progress-step=".length);
    else if (arg.startsWith("--progress-total=")) out.progressTotal = arg.slice("--progress-total=".length);
    else if (arg.startsWith("--state-file=")) out.stateFile = arg.slice("--state-file=".length);
  }
  return out;
}

function warn(message) {
  process.stderr.write(`⚠ upgrade-clis: ${message}\n`);
}

// Run one upgrade command array (`["opencode","upgrade"]`, `["npm","install","-g",…]`,
// or a `["sh","-c",…]` pipeline). Streams child stdout/stderr through so the
// self-update log shows what the vendor installer did. Resolves on exit 0,
// rejects otherwise. Per-CLI timeout is enforced by spawn's `timeout`.
function runUpgrade(argv) {
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = nodeSpawn(cmd, args, { stdio: "inherit", timeout: PER_CLI_TIMEOUT_MS });
    } catch (e) {
      reject(e);
      return;
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function writeStateFile(file, cliIds, opencodeChanged) {
  const body = `CLIS_CHANGED=${cliIds.join(",")}\nOPENCODE_CHANGED=${opencodeChanged}\n`;
  try {
    writeFileSync(file, body, "utf8");
  } catch (e) {
    warn(`cannot write state file ${file}: ${e.message}`);
  }
}

async function main() {
  const { progressStep, progressTotal, stateFile } = parseArgs(process.argv.slice(2));
  const changed = [];
  let opencodeChanged = 0;

  try {
    const results = await detectClis();
    for (const r of results) {
      // A CLI with no resolved upgrade command (`manual`) is skipped silently —
      // it has no safe upgrade path and must not disturb the run.
      if (!Array.isArray(r.upgrade) || r.upgrade.length === 0) continue;

      // Same step every time, refined label — the bar must not jump per CLI.
      process.stdout.write(`MANTA_PROGRESS ${progressStep}/${progressTotal} Updating ${r.label}\n`);

      const before = r.current ?? null;
      try {
        await runUpgrade(r.upgrade);
      } catch (e) {
        warn(`${r.label}: upgrade failed (${e.message}) — continuing`);
        continue;
      }

      // Re-read the version to see whether the upgrade actually changed it.
      const entry = CLI_CATALOG.find((c) => c.id === r.id);
      let after = null;
      if (entry?.bin) {
        const absPath = await resolveBinary(entry.bin, { access: fsAccess, env: process.env });
        if (absPath) after = await readVersion(absPath, { spawn: nodeSpawn });
      }

      if (after && after !== before) {
        changed.push(r.id);
        if (r.id === "opencode") opencodeChanged = 1;
        process.stdout.write(`✓ upgrade-clis: ${r.label} upgraded: ${before ?? "unknown"} → ${after}\n`);
      } else {
        const shown = after ?? before ?? "unknown";
        process.stdout.write(`✓ upgrade-clis: ${r.label} already current (${shown})\n`);
      }
    }
  } catch (e) {
    warn(`unexpected error: ${e.message} — continuing`);
  } finally {
    // Always write the state file, even on failure, so bash never reads a stale
    // one from a previous run.
    if (stateFile) writeStateFile(stateFile, changed, opencodeChanged);
  }
}

main();

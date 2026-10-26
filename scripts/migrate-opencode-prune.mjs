#!/usr/bin/env node
// migrate-opencode-prune.mjs — turn on opencode's tool-output pruning
// (`compaction.prune: true`) on every box, once.
//
// opencode defaults pruning OFF. Pruning drops old tool outputs from the
// context, the cheapest way to keep a long session lean, so Manta wants it ON
// by default — without ever overriding a user who chose a value.
//
// Called from `upgradeV2Prepare.mjs prepare` (run by both self-update.sh, from the NEW
// payload and before any opencode restart, and install.sh). Idempotent and NEVER fatal:
// every failure is a one-line warning and exit 0, so an update/install carries on.
//
// Rules:
//   * Writes `compaction.prune: true` ONLY when `compaction.prune` is absent. Any
//     explicit value (true, false, null, …) is the user's and is left alone.
//   * The opencode config is edited surgically with jsonc-parser — comments and
//     formatting elsewhere are preserved byte-for-byte.
//   * The marker `migrations.pruneDefault` (ISO timestamp) in ~/.manta/config.json
//     makes this run once. It is also written when the key was already present, so
//     a later user change is never overridden. It is NOT written when the config is
//     missing or unparseable (nothing was decided; try again next time).
//
// Usage: node scripts/migrate-opencode-prune.mjs [--config=<opencode.jsonc>] [--state-file=<config.json>]
// (defaults: opencodeConfigPath() and statePath("config.json"); MANTA_STATE_HOME
// redirects the latter.)

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";
import { opencodeConfigPath } from "../src/server/providers.mjs";
import { statePath } from "../src/shared/paths.mjs";
import { writeJsonAtomic } from "../src/server/jsonStore.mjs";

const FORMAT = { insertSpaces: true, tabSize: 2 };
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Decide what the migration does. Pure.
 *
 * @param {{ configText: string | null, markerPresent: boolean }} input
 *   configText: the opencode config file's text, or null when the file is missing.
 * @returns {{ text: string, writeConfig: boolean, writeMarker: boolean, reason: string, warning?: string }}
 *   `text` is the (possibly edited) config text; `writeConfig` says whether to
 *   persist it; `writeMarker` whether to record the one-time marker.
 */
export function planPruneMigration({ configText, markerPresent }) {
  const text = typeof configText === "string" ? configText : "";
  if (markerPresent) {
    return { text, writeConfig: false, writeMarker: false, reason: "already-migrated" };
  }
  if (configText === null || configText === undefined) {
    return { text: "", writeConfig: false, writeMarker: false, reason: "config-missing" };
  }

  const base = text.trim() === "" ? "{}\n" : text;
  const errors = [];
  const cfg = parse(base, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(cfg)) {
    return {
      text,
      writeConfig: false,
      writeMarker: false,
      reason: "config-unparseable",
      warning: "opencode config is unparseable — leaving it untouched",
    };
  }

  // An explicit prune value — or a `compaction` that isn't an object, which we
  // can't add a key to — is the user's choice: leave it, but record the marker.
  if (cfg.compaction !== undefined && (!isPlainObject(cfg.compaction) || cfg.compaction.prune !== undefined)) {
    return { text, writeConfig: false, writeMarker: true, reason: "already-set" };
  }

  const path = cfg.compaction === undefined ? ["compaction"] : ["compaction", "prune"];
  const value = cfg.compaction === undefined ? { prune: true } : true;
  let out = applyEdits(base, modify(base, path, value, { formattingOptions: FORMAT }));
  if (!out.endsWith("\n")) out += "\n";
  return { text: out, writeConfig: true, writeMarker: true, reason: "enabled" };
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function modeOf(path, fallback) {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return fallback;
  }
}

/**
 * Run the migration against real files. Never throws: returns
 * `{ outcome, warning? }` where outcome is one of
 * "enabled" | "already-set" | "already-migrated" | "config-missing" |
 * "config-unparseable" | "state-unparseable" | "error".
 */
export async function migratePrune({ configPath, stateFile, now = () => new Date() } = {}) {
  const cfgPath = configPath ?? opencodeConfigPath();
  const statePathResolved = stateFile ?? statePath("config.json");
  try {
    // State config first: a marker means we are done without touching opencode's file.
    let state = {};
    const stateText = await readTextOrNull(statePathResolved);
    if (stateText !== null && stateText.trim() !== "") {
      const errors = [];
      const parsed = parse(stateText, errors);
      if (errors.length > 0 || !isPlainObject(parsed)) {
        return { outcome: "state-unparseable", warning: `${statePathResolved} is unparseable — skipping the prune default` };
      }
      state = parsed;
    }
    if (state.migrations !== undefined && !isPlainObject(state.migrations)) {
      return { outcome: "state-unparseable", warning: `${statePathResolved} has a non-object "migrations" — skipping the prune default` };
    }
    const markerPresent = state.migrations?.pruneDefault !== undefined;

    const configText = markerPresent ? null : await readTextOrNull(cfgPath);
    const plan = planPruneMigration({ configText: markerPresent ? "" : configText, markerPresent });
    if (plan.writeConfig) {
      await writeJsonAtomic(cfgPath, plan.text, { mode: await modeOf(cfgPath, 0o644) });
    }
    if (plan.writeMarker) {
      const next = { ...state, migrations: { ...(state.migrations ?? {}), pruneDefault: now().toISOString() } };
      await writeJsonAtomic(statePathResolved, `${JSON.stringify(next, null, 2)}\n`, {
        mode: await modeOf(statePathResolved, 0o600),
      });
    }
    return { outcome: plan.reason, ...(plan.warning ? { warning: plan.warning } : {}) };
  } catch (e) {
    return { outcome: "error", warning: `prune default migration failed: ${e?.message ?? e}` };
  }
}

function argValue(argv, name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(argv) {
  const { outcome, warning } = await migratePrune({
    configPath: argValue(argv, "config"),
    stateFile: argValue(argv, "state-file"),
  });
  if (warning) process.stderr.write(`⚠ migrate-opencode-prune: ${warning}\n`);
  else if (outcome === "enabled") process.stdout.write("✓ migrate-opencode-prune: enabled compaction.prune\n");
  else process.stdout.write(`▸ migrate-opencode-prune: nothing to do (${outcome})\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`⚠ migrate-opencode-prune: ${e?.message ?? e}\n`);
      process.exit(0);
    },
  );
}

#!/usr/bin/env node
// scripts/gen-swift-settings.mjs
// Reads src/shared/settingsSchema.ts — the single source of truth for the
// settings inventory, a pure, tested, platform-tagged registry — and writes
// generated/swift/SettingsSchema.swift, the generated Swift schema file the
// native iOS settings screen renders from. Deterministic: same input in,
// byte-identical output out. No timestamp, version, or hostname is emitted.
//
// This mirrors how design tokens are generated (scripts/gen-swift-tokens.mjs,
// which reads src/renderer/tokens.css): the TypeScript schema is read at build
// time and a static Swift counterpart is committed, with a `--check` gate so a
// drift between the schema and the committed Swift file fails CI rather than
// surfacing at runtime on a device.
//
// Usage:
//   node scripts/gen-swift-settings.mjs        write (regenerate if different)
//   node scripts/gen-swift-settings.mjs --check regenerate in memory and fail
//                                              (exit 1) if the committed file drifts
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { unifiedDiff } from "./gen-swift-tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, "../src/shared/settingsSchema.ts");
const SWIFT_PATH = resolve(here, "../generated/swift/SettingsSchema.swift");

const require = createRequire(import.meta.url);

/// Load a pure TypeScript module (settingsSchema.ts) synchronously by
/// transpiling it to CommonJS and evaluating it in an isolated module scope.
/// The schema is a dependency-free module (no imports), so a data-URL / eval
/// load is safe here — there are no relative imports to resolve.
function loadSchemaModule(tsSource) {
  const { outputText } = ts.transpileModule(tsSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: "settingsSchema.ts",
  });
  const moduleObject = { exports: {} };
  // NOTE: `new Function` is the only safe way to run the transpiled CJS in a
  // synchronous, isolated scope here; the input is repo-owned, versioned
  // source, not user input.
  const fn = new Function("module", "exports", "require", outputText);
  fn(moduleObject, moduleObject.exports, require);
  return moduleObject.exports;
}

// ---- value emission ---------------------------------------------------------

function swiftControl(control) {
  return `SettingControl.${control}`;
}

function emitDefault(entry) {
  const d = entry.default;
  switch (typeof d) {
    case "string":
      return `defaultString: ${JSON.stringify(d)},\n            defaultBool: nil,\n            defaultNumber: nil,`;
    case "boolean":
      return `defaultString: nil,\n            defaultBool: ${d},\n            defaultNumber: nil,`;
    case "number":
      return `defaultString: nil,\n            defaultBool: nil,\n            defaultNumber: ${d},`;
    case "undefined":
    case "object":
      if (d === null || d === undefined) {
        return `defaultString: nil,\n            defaultBool: nil,\n            defaultNumber: nil,`;
      }
      throw new Error(
        `entry '${entry.id}' has a non-primitive default (${JSON.stringify(d)}) that the Swift generator cannot emit`,
      );
    default:
      throw new Error(
        `entry '${entry.id}' has an unsupported default type '${typeof d}'`,
      );
  }
}

function emitEntry(entry) {
  const lines = [];
  lines.push(`        SettingEntry(`);
  lines.push(`            id: ${JSON.stringify(entry.id)},`);
  lines.push(`            section: ${JSON.stringify(entry.section)},`);
  lines.push(`            label: ${JSON.stringify(entry.label)},`);
  lines.push(`            help: ${JSON.stringify(entry.help ?? "")},`);
  lines.push(`            control: ${swiftControl(entry.control)},`);
  lines.push(`            configKey: ${entry.configKey == null ? "nil" : JSON.stringify(entry.configKey)},`);
  lines.push(`            ${emitDefault(entry)}`);
  const options = entry.options;
  const optionsText = options && options.length
    ? "[" + options.map((o) => `SettingOption(value: ${JSON.stringify(o.value)}, label: ${JSON.stringify(o.label)})`).join(", ") + "]"
    : "nil";
  lines.push(`            options: ${optionsText},`);
  lines.push(`            commitOnBlur: ${entry.commitOnBlur === true},`);
  lines.push(`            placeholder: ${entry.placeholder == null ? "nil" : JSON.stringify(entry.placeholder)},`);
  lines.push(`        ),`);
  return lines.join("\n");
}

/// Build the generated Swift source for a given schema module (`SETTINGS` and
/// `SETTING_SECTIONS` plus the `settingsForPlatform` helper).
export function generateFromModule(mod) {
  const platform = "mobile";
  const entries = mod.settingsForPlatform(mod.SETTINGS, platform);
  const allSections = mod.SETTING_SECTIONS;
  // Only sections that have at least one mobile-visible entry are emitted,
  // mirroring the TS "mobile skips sections with no mobile entries" rule.
  const sections = allSections.filter((s) =>
    entries.some((e) => e.section === s.id),
  );

  const entryLines = entries.map(emitEntry);
  const sectionLines = sections.map((s) => `        SettingSection(id: ${JSON.stringify(s.id)}, label: ${JSON.stringify(s.label)}, group: ${s.group == null ? "nil" : JSON.stringify(s.group)}),`);

  return `// GENERATED FILE — do not edit by hand.
// Generated by scripts/gen-swift-settings.mjs from src/shared/settingsSchema.ts
// (the single source of truth for the settings inventory). Re-run the
// generator (node scripts/gen-swift-settings.mjs) to regenerate.

import Foundation

enum SettingControl: String {
    case toggle
    case text
    case password
    case path
    case segmented
    case custom
}

struct SettingOption: Equatable {
    let value: String
    let label: String
}

/// A single setting rendered by the mobile settings screen, mirroring a
/// platform-tagged entry from the shared \`settingsSchema.ts\` registry. The
/// app never hand-writes a settings list — it renders \`SettingsSchema.entries\`
/// and new settings surface automatically when the generator is re-run.
struct SettingEntry: Identifiable, Equatable {
    let id: String
    let section: String
    let label: String
    let help: String
    let control: SettingControl
    /// AppConfig key read/written via \`config:get\`/\`config:update\`. nil =
    /// a device-local setting (no server config key; persisted on-device).
    let configKey: String?
    let defaultString: String?
    let defaultBool: Bool?
    let defaultNumber: Double?
    let options: [SettingOption]?
    let commitOnBlur: Bool
    let placeholder: String?

    var isDeviceLocal: Bool { configKey == nil }
}

struct SettingSection: Identifiable, Equatable {
    let id: String
    let label: String
    let group: String?
}

/// The generated, mobile-visible settings inventory, derived from
/// \`settingsForPlatform(SETTINGS, "mobile")\` in src/shared/settingsSchema.ts.
enum SettingsSchema {
    static let sections: [SettingSection] = [
${sectionLines.join("\n")}
    ]

    static let entries: [SettingEntry] = [
${entryLines.join("\n")}
    ]

    static func entries(in sectionID: String) -> [SettingEntry] {
        entries.filter { $0.section == sectionID }
    }

    /// Case-insensitive search over label + help (mirrors \`searchSettings\`).
    static func search(_ query: String) -> [SettingEntry] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return entries.filter {
            ("\\($0.label)\\n\\($0.help)").lowercased().contains(q)
        }
    }
}
`;
}

export function generate(schemaSource) {
  const mod = loadSchemaModule(schemaSource);
  return generateFromModule(mod);
}

export function run({
  schemaPath = SCHEMA_PATH,
  swiftPath = SWIFT_PATH,
  readFile = (p) => readFileSync(p, "utf8"),
  writeFile = (p, data) => writeFileSync(p, data),
  load = loadSchemaModule,
  diff = unifiedDiff,
  check = false,
  log = (s) => console.log(s),
} = {}) {
  const tsSource = readFile(schemaPath);
  const out = generateFromModule(load(tsSource));

  let existing = null;
  try {
    existing = readFile(swiftPath);
  } catch {
    existing = null;
  }

  if (existing === out) {
    if (check) log("Swift settings schema is up to date.");
    return 0;
  }

  if (check) {
    log(swiftPath);
    log(diff(existing ?? "", out, swiftPath, "<generated>"));
    log("");
    log(
      "Swift settings schema is out of date. To fix: run `npm run gen:swift-settings` " +
        "(no --check) and commit the result.",
    );
    return 1;
  }

  mkdirSync(dirname(swiftPath), { recursive: true });
  writeFile(swiftPath, out);
  log(`wrote ${swiftPath} (${out.split("\n").length - 1} lines)`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  process.exitCode = run({ check });
}

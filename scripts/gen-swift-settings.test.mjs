import { test } from "node:test";
import assert from "node:assert/strict";
import { generate, generateFromModule, run } from "./gen-swift-settings.mjs";

// A minimal, dependency-free settingsSchema.ts source. The real
// `src/shared/settingsSchema.ts` is never touched by these tests; the harness
// routes schema reads between the injected source and the generated file.
const SAMPLE_SCHEMA = `
export type SettingSectionId = "general" | "box" | "accounts" | "models" | "sessions" | "files" | "extensions" | "voice";
export const SETTING_SECTIONS = [
  { id: "general", label: "General" },
  { id: "box", label: "Box", group: "SETUP" },
  { id: "models", label: "Models", group: "SETUP" },
  { id: "sessions", label: "Sessions", group: "AGENT" },
  { id: "files", label: "Files", group: "AGENT" },
  { id: "voice", label: "Voice", group: "AGENT" },
];
export const SETTINGS = [
  { id: "autoRenameSessions", section: "sessions", label: "Auto-rename", help: "Renames.", control: "toggle", configKey: "autoRenameSessions", platform: "both", default: false },
  { id: "serverUrlMobile", section: "box", label: "Server URL", help: "Override.", control: "text", configKey: null, platform: "mobile", default: "", placeholder: "https://manta.example.com" },
  { id: "uploadCleanupHours", section: "files", label: "Upload cleanup", help: "Hours.", control: "segmented", configKey: "uploadCleanupHours", platform: "both", default: 24, options: [{ value: "24", label: "24 hours" }, { value: "0", label: "Never" }] },
  { id: "groqApiKey", section: "voice", label: "Groq key", help: "Voice.", control: "password", configKey: "groqApiKey", platform: "both", default: "", commitOnBlur: true, placeholder: "gsk_…" },
  { id: "worktreePerSession", section: "sessions", label: "Worktree", help: "Desktop only.", control: "toggle", configKey: "worktreePerSession", platform: "desktop", default: false },
];
export function settingsForPlatform(entries, platform) {
  return entries.filter((e) => e.platform === "both" || e.platform === platform);
}
`;

// A schema whose default value is an unsupported type — generation must fail
// loudly rather than emit broken Swift.
const BAD_DEFAULT_SCHEMA = `
export const SETTING_SECTIONS = [ { id: "general", label: "General" } ];
export const SETTINGS = [
  { id: "x", section: "general", label: "X", help: "", control: "toggle", configKey: "x", platform: "both", default: { nested: true } },
];
export function settingsForPlatform(entries, platform) {
  return entries.filter((e) => e.platform === "both" || e.platform === platform);
}
`;

// A minimal mobile-visible-only module for the generate()/generateFromModule()
// determinism tests — reuse the SAMPLE_SCHEMA so output is canonically built.
const SAMPLE_OUT = generate(SAMPLE_SCHEMA);

function harness({ committed, writeSpy = () => {} }) {
  const writes = [];
  const readFile = (p) => {
    if (p.endsWith("settingsSchema.ts")) return SAMPLE_SCHEMA;
    if (committed instanceof Error) throw committed;
    return committed;
  };
  const writeFile = (p, data) => {
    writes.push({ p, data });
    writeSpy(p, data);
  };
  const logs = [];
  const log = (s) => logs.push(s);
  return { run: (opts) => run({ readFile, writeFile, log, ...opts }), writes, logs };
}

test("generated schema contains only mobile-visible entries in schema order", () => {
  assert.ok(SAMPLE_OUT.includes('id: "autoRenameSessions"'));
  assert.ok(SAMPLE_OUT.includes('id: "serverUrlMobile"'));
  assert.ok(SAMPLE_OUT.includes('id: "uploadCleanupHours"'));
  assert.ok(SAMPLE_OUT.includes('id: "groqApiKey"'));
  // Desktop-only entry is excluded.
  assert.ok(!SAMPLE_OUT.includes('id: "worktreePerSession"'));
});

test("section list omits sections with no mobile-visible entries", () => {
  // 'files' has uploadCleanupHours (both) → present; 'general'/'extensions'
  // have no mobile entries → absent from the sample.
  assert.ok(SAMPLE_OUT.includes('id: "files"'));
  assert.ok(!SAMPLE_OUT.includes('id: "general"'));
  assert.ok(!SAMPLE_OUT.includes('id: "extensions"'));
});

test("typed defaults, options, commitOnBlur, placeholder and configKey are emitted", () => {
  assert.ok(SAMPLE_OUT.includes('defaultBool: false'));
  assert.ok(SAMPLE_OUT.includes('defaultNumber: 24'));
  assert.ok(SAMPLE_OUT.includes('configKey: nil'));
  assert.ok(SAMPLE_OUT.includes('commitOnBlur: true'));
  assert.ok(SAMPLE_OUT.includes('commitOnBlur: false'));
  assert.ok(SAMPLE_OUT.includes('placeholder: "gsk_…"'));
});

test("an unsupported (non-primitive) default fails loudly", () => {
  assert.throws(() => generate(BAD_DEFAULT_SCHEMA), /non-primitive default/);
});

test("--check: identical input exits 0 and writes nothing", () => {
  const h = harness({ committed: SAMPLE_OUT });
  const code = h.run({ check: true });
  assert.equal(code, 0);
  assert.equal(h.writes.length, 0);
});

test("--check: differing input exits 1 and writes nothing", () => {
  const h = harness({ committed: "// stale\n" });
  const code = h.run({ check: true });
  assert.equal(code, 1);
  assert.equal(h.writes.length, 0);
  assert.ok(
    h.logs.some((l) => l.includes("out of date")),
    "failure message includes the remedy",
  );
});

test("normal mode writes when different, not when identical", () => {
  const h = harness({ committed: "// stale\n" });
  assert.equal(h.run({ check: false }), 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data, SAMPLE_OUT);

  const same = harness({ committed: SAMPLE_OUT });
  assert.equal(same.run({ check: false }), 0);
  assert.equal(same.writes.length, 0);
});

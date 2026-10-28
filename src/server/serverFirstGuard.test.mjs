// serverFirstGuard.test.mjs — WS11 guardrail (D23/D24): logic the box now owns
// must not reappear as a client declaration. Each WS11 sub-step appends the
// symbols it deletes to DELETED; a failure names the rule and the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Scope name → { dir, ext regexp, recursive, skipTests }. */
const SCOPES = {
  renderer: { dir: "src/renderer", ext: /\.(ts|tsx)$/, recursive: true },
  swift: { dir: "mobile/native/MantaUI", ext: /\.swift$/, recursive: false },
  swiftTests: { dir: "mobile/native/MantaUITests", ext: /\.swift$/, recursive: false },
  server: { dir: "src/server", ext: /\.mjs$/, recursive: false },
};

/**
 * `{ scopes, regex, why }` — a line matching `regex` in a non-test file of one of
 * the scopes fails the build. `regex` is the DECLARATION (or, for a deleted
 * accessor, any use).
 */
export const DELETED = [
  // D1 — one capability reader per client.
  { scopes: ["swift", "swiftTests"], regex: /\bboxCapabilities\(\)/, why: "D1: iOS reads capabilities through BoxCapabilitiesStore (MantaAPIClient.boxCapabilities() is deleted)" },
  { scopes: ["swift", "swiftTests"], regex: /\bChatCardCapabilities\b/, why: "D1: ChatCardCapabilities is replaced by BoxCapabilitiesStore" },
  { scopes: ["swift", "swiftTests"], regex: /\bArtifactsCapability\b/, why: "D1: the wave-B artifacts classifier is folded into BoxCapabilities.isUnknownChannel" },
  { scopes: ["swift", "swiftTests"], regex: /\bModelsCapability\.isUnsupported\b|static func isUnsupported\(/, why: "D1: the wave-B models classifier is folded into BoxCapabilities.isUnknownChannel" },
  { scopes: ["renderer"], regex: /src\/renderer\/boxCapabilities|from ["']\.\.?\/boxCapabilities["']/, why: "D1: useBoxCapability (hooks/useBoxCapabilities.ts) is THE desktop accessor — no second module" },
  // D2 — the stale-cache instant and the context percentage come from the box.
  { scopes: ["renderer"], regex: /\b(computeStaleCache|computeContextBreakdown|resolveContextLimit|selectLastAssistantCompletion)\(/, why: "D2: the box sends `cache.staleAt` and a `context` measured against the selected model — no client recompute" },
  { scopes: ["swift", "swiftTests"], regex: /static func recompute\(_ ctx: StreamContextPayload|UsageMeters\.recompute\(/, why: "D2: iOS shows the box's context payload as sent (UsageMeters.recompute is deleted)" },
  // D3 — box-derived Settings fields.
  { scopes: ["renderer"], regex: /\b(forgeCredentialSecondary|resolveLauncherFlags|updateLauncherFlag|describeGateDetails|describeDiskShortfall|formatEtaSeconds)\b/, why: "D3: the box words these (forge:status.secondary, launchers:list value, /api/upgrade view) — no client copy" },
  { scopes: ["renderer"], regex: /export function describeUpdateTarget\b/, why: "D3: ONE describeUpdateTarget, in src/shared/updateTargets.mjs" },
  { scopes: ["swift", "swiftTests"], regex: /\bisRevocableID\(|static func (canRevoke|sorted)\(_ devices|enum ExtensionsLaunchers\b.*|UpdateTargets\.(build|describe|hasUpdate|versionText)\(/, why: "D3: iOS renders the box's devices view / update view / launcher values as sent" },
  // D4 — Accounts words and row states are the box's.
  { scopes: ["renderer"], regex: /export function (accountsErrorMessage|formatEndpointStateLine|formatNoHealthyEndpointCopy|formatRetryMinutes|formatAgeAt|describeAccountState|usagePace)\b|\bENDPOINT_STATE_BADNESS\b|\bworstEndpointFor\b/, why: "D4: the box words accounts errors, endpoint lines, the no-healthy banner and each row's state (accounts:row-states)" },
  { scopes: ["swift", "swiftTests"], regex: /\benum EndpointHealth\b|\benum ProviderHealthFormat\b|static func (moveNoticeText|reasonText|normalizedLabel|reason\(forCode)|\bstruct SeatMoveNoticeInput\b|static func (describe|control)\(status:/, why: "D4: iOS shows the box's words (error message, endpoint stateLine, move text/line, row states)" },
];

function* walk(dir, recursive) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (recursive && name !== "node_modules") yield* walk(p, recursive);
    } else {
      yield p;
    }
  }
}

const isTestFile = (p) => /\.(test|spec)\.[a-z]+$/.test(p) || /Tests?\.swift$/.test(p) || p.includes("/fixtures/");

/** Pure: every violation of `rules` in `files` ([{path, text}]). */
export function findViolations(rules, files, scopeOf) {
  const out = [];
  for (const { path, text } of files) {
    for (const rule of rules) {
      if (!rule.scopes.includes(scopeOf(path))) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (rule.regex.test(line)) out.push({ path, line: i + 1, why: rule.why });
      });
    }
  }
  return out;
}

function loadFiles() {
  const files = [];
  for (const [scope, { dir, ext, recursive }] of Object.entries(SCOPES)) {
    for (const p of walk(join(ROOT, dir), recursive)) {
      if (!ext.test(p)) continue;
      const rel = relative(ROOT, p);
      // Swift test files are scanned (a deleted symbol must not survive there either);
      // other test files may name a deleted symbol to assert it is gone.
      if (scope !== "swiftTests" && isTestFile(rel)) continue;
      files.push({ path: rel, scope, text: readFileSync(p, "utf8") });
    }
  }
  return files;
}

test("no deleted client logic reappears (WS11 guard table)", () => {
  const files = loadFiles();
  const scopeByPath = new Map(files.map((f) => [f.path, f.scope]));
  const violations = findViolations(DELETED, files, (p) => scopeByPath.get(p));
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.path}:${v.line} — ${v.why}`).join("\n"),
  );
});

test("the guard fails on a synthetic file that re-adds a deleted symbol (self-test)", () => {
  const files = [{ path: "mobile/native/MantaUI/Fake.swift", scope: "swift", text: "final class ChatCardCapabilities {}\nlet ok = 1\n" }];
  const v = findViolations(DELETED, files, () => "swift");
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
  assert.match(v[0].why, /BoxCapabilitiesStore/);
});

test("every rule names scopes that exist and a reason", () => {
  for (const r of DELETED) {
    assert.ok(r.why && r.regex instanceof RegExp);
    for (const s of r.scopes) assert.ok(SCOPES[s], s);
  }
});

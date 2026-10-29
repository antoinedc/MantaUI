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
  // D5 (naming) — session names, scratch hints and the proposed root are the box's.
  { scopes: ["renderer"], regex: /\b(uniqueSessionName|deriveProjectName|slugifyProjectName)\(|const proposedWorkspaceRoot = useMemo/, why: "D5: the box names sessions (nameHint → tmux-safe, unique, allocated under a lock), previews them (sessions:propose-name) and proposes the root (forge:probe.proposedRoot)" },
  { scopes: ["swift", "swiftTests"], regex: /static func (slugify|uniqueProjectName|tmuxSafe|unique)\(|\benum SessionScratchHint\b|\benum SessionWorkspaceRoot\b|static func validated\(/, why: "D5: iOS sends a hint and shows the box's name/preview/root; rename validity is the box's" },
  // D5 (clone) — clone errors, list errors and the destination are the box's.
  { scopes: ["renderer"], regex: /export function (cloneErrorKind|repoListErrorMessage)\b|const destFor = /, why: "D5: forge:clone-status words a failed clone, forge:repos words a failed listing, forge:clone-start joins the destination" },
  { scopes: ["swift", "swiftTests"], regex: /\benum CloneErrorKind\b|\benum RepoListError\b|static func dest\(root:/, why: "D5: iOS shows the box's clone/list wording and never joins the clone destination" },
  // D6 — the close flow (confirm copy, worktree orchestration, notices) is the box's.
  { scopes: ["renderer"], regex: /\b(describeSessionClose|describeProjectClose|killWorktreeDirtyAndClose)\b|const (killWindow|killProject) = /, why: "D6: sessions:close-preview words the confirm and sessions:close runs worktree removal → kill → metadata on the box" },
  { scopes: ["swift", "swiftTests"], regex: /\benum (SessionCloseCopy|SessionCloseCounts|SessionCloseDecision|SessionCloseOutcome|SessionCloseStep)\b|func readCleanOnClose|\.gitRemoveWorktree\(|struct SessionWorktreeRemoval\b/, why: "D6: iOS shows the box's close preview/result; it never orchestrates worktree removal or composes the notices" },
  // D7 — job nesting and the per-window rollup (running beneath, subagents) are the box's.
  { scopes: ["renderer"], regex: /\b(computeJobNesting|sessionsWithActiveWork|shouldResyncWindowsForJobs|setSessionParent|sessionParents|setChatSubagents|countRunningSubagents)\b/, why: "D7: windows[].job + the windowStatus frame carry nesting and the busy/subagent rollup; no client walks the parent graph" },
  { scopes: ["swift", "swiftTests"], regex: /\b(SessionJobNesting|SessionSubagentCount|DelegateNesting)\b|\bdelegateJobs\b|func applyJobs/, why: "D7: iOS reads windows[].job and the windowStatus frame; it never nests jobs or counts subagents itself" },
  // D4–D5 review — sign-in failure sentences are the box's (status replies carry `message`).
  { scopes: ["renderer"], regex: /\bfunction (seatFailureMessage|resignFailureMessage)\b/, why: "D4 review: accounts:seat-status / resign-status carry the sentence (message); no client words a sign-in failure" },
  { scopes: ["swift", "swiftTests"], regex: /\bfunc (seatFailureMessage|resignFailureMessage|resignTimedOut)\b/, why: "D4 review: the sign-in failure sentences are the box's; iOS shows `message`" },
  // D6–D7 review — every delete goes through sessions:close (bound to the confirmed window).
  { scopes: ["renderer"], regex: /\bopencodeDeleteSession\b(?!Raw)/, why: "D6 review: the in-chat Delete is the box's close flow (sessions:close with expect), not a bare opencode:delete-session" },
  { scopes: ["swift", "swiftTests"], regex: /\bfunc deleteSession\(sessionId\b|\.deleteSession\(sessionId\b/, why: "D6 review: the in-chat Delete is the box's close flow (sessions:close with expect)" },
  { scopes: ["renderer"], regex: /\breplaceWindowStatus\b/, why: "D7 review: a read only FILLS the window-status map (fillWindowStatus); replacing wholesale could overwrite a newer frame" },
  // D8 — turn footers and truncation are the box's (`message.view`).
  { scopes: ["renderer"], regex: /\b(computeTurnInfo|describeTruncation|classifyFinish)\b/, why: "D8: message.view.turn / view.truncation carry the footer and the truncation words; the renderer derives none of it" },
  { scopes: ["swift", "swiftTests"], regex: /\benum TranscriptTruncation\b|TranscriptTruncation\.(classify|describe|kind)\b|\bTranscriptTurns\.info\b|\bstruct TranscriptTurnInfo\b/, why: "D8: iOS reads message.view and the live frame's hint; it never classifies a finish or words a truncation" },
  // D9 — canonical inline media are the box's (`message.view.media`, `part.view.media`).
  { scopes: ["renderer"], regex: /\b(filePartToMediaEntry|isMediaMime)\b/, why: "D9: part.view.media marks an image/video file part; the renderer does not sniff mimes" },
  { scopes: ["swift", "swiftTests"], regex: /\bTranscriptMediaParse\b|TranscriptMediaMime\.forPath|\bcanonicalEntries\b/, why: "D9: iOS maps message.view.media; it never parses media_begin / media_show tool output" },
  // D10 — the plan card's data is the box's (`question.plan`).
  { scopes: ["renderer"], regex: /\b(isPlanExitQuestion|extractPlanData|planRefsFromPart)\b/, why: "D10: question.plan carries the plan card's data; the renderer matches no tool part and parses no plan" },
  { scopes: ["swift", "swiftTests"], regex: /\benum PlanDerivation\b|\bstruct PlanData\b|PlanDerivation\./, why: "D10: iOS shows question.plan; it never derives a plan from the transcript" },
  { scopes: ["server"], regex: /function isPlanExitQuestion\b/, except: /questionsDecorator\.mjs$/, why: "D10: ONE plan-question predicate, exported from questionsDecorator.mjs (push imports it)" },
  // D1–D3 review additions.
  { scopes: ["swift"], regex: /\.apiVersion\(\)/, except: /(BoxCapabilitiesStore|MantaAPIClient)\.swift$/, why: "D1 review #3: iOS reads capabilities through the ONE BoxCapabilitiesStore — no second reader" },
  { scopes: ["swift", "swiftTests"], regex: /\benum ExtensionsForge\b|\bUpgradePresentation\.(details|currentStep|fraction|etaText|diskText|sentence|bytes)\b/, why: "D3: the Settings forge secondary line and the upgrade wording are the box's" },
  { scopes: ["renderer"], regex: /\b(NO_ROLLBACK_STEPS|CHECK_AGAIN_STEPS)\b|export function (currentStep|stepFraction|diskSentence)\b/, why: "D3: the upgrade gate's current step, fraction, disk sentence and Retry/Roll back rules are the box's" },
  // D11 — tool activity wording + runs.
  { scopes: ["renderer"], regex: /\b(describeActivity|describeToolPart|describePatchPart|summarizeToolGroup|groupTone|normalizeToolStatus|humanizeToolName)\b|export type (Activity|ActivityKind|GroupSummary)\b|\bfunction (hostOf|clip)\b/, why: "D11: part.view.activity / message.view.runs / the toolRuns frame carry every tool call's wording and every run's summary, tone and membership; the renderer lays out the box's runs and derives none of it" },
  { scopes: ["swift", "swiftTests"], regex: /ToolActivity\.(describe|describeTool|describePatch|summarize|target|clip|hostOf|basename|humanizeToolName|userMessageDraws)\b|^struct (Activity|GroupSummary)\b|\bdelegateJobName\b|\bdelegateNameMax\b|\bfunc (mergingLive|plural)\b|\bmergingLive\(|\bLiveActivityMerge\b|\bliveTailRowID\b|\bstatic func livePart\(from (tool|subagent)\b|\bToolRun\.appending\b|\.appending\(\[|\bstatic func (describeTool|describePatch|summarize|basename|hostOf|clip|humanizeToolName|userMessageDraws)\(|\bstatic func describe\(_ part\b|\bstatic func target\(of\b|\bhumanizeToolName\b/, why: "D11: part.view.activity / message.view.runs / the toolRuns frame carry every call's wording and every run's summary and membership; iOS lays out the box's runs and derives none of it (and the live tail is the box's ordered ledger, not a merge of tool frames)" },
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
      if (rule.except?.test(path)) continue;
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

test("the D11 Swift rule also catches an unqualified re-declaration of a deleted symbol (self-test)", () => {
  const rule = DELETED.filter((r) => r.scopes.includes("swift") && /D11/.test(r.why));
  assert.equal(rule.length, 1);
  const flagged = (text) =>
    findViolations(rule, [{ path: "mobile/native/MantaUI/Fake.swift", scope: "swift", text }], () => "swift").length;
  for (const decl of [
    "    static func clip(_ s: String, _ max: Int) -> String {",
    "    static func hostOf(_ url: String) -> String {",
    "    static func humanizeToolName(_ name: String) -> String {",
    "    static func summarize(_ parts: [OpencodePart]) -> String {",
    "    static func target(of part: OpencodePart) -> String {",
    "    static func userMessageDraws(_ m: OpencodeMessage) -> Bool {",
    "    static func describe(_ part: OpencodePart) -> Activity {",
    "    private static func describeTool(_ part: OpencodePart) -> Activity {",
    "    let n = humanizeToolName(raw)",
  ]) {
    assert.equal(flagged(decl), 1, decl);
  }
  // Names that merely resemble the deleted ones are not flagged.
  for (const ok of [
    "    private static func truncatedLine(_ s: String, _ max: Int) -> String {",
    "    static func describeDesktopUpdate(_ r: DesktopUpdateResult) -> Row {",
    "    static func summary(forSegment id: String?) -> Run {",
    "    static func targetFor(_ id: String) -> String {",
    "    func clipboardText() -> String {",
    "    private static func describe(_ error: Error) -> String {",
  ]) {
    assert.equal(flagged(ok), 0, ok);
  }
});

test("every rule names scopes that exist and a reason", () => {
  for (const r of DELETED) {
    assert.ok(r.why && r.regex instanceof RegExp);
    for (const s of r.scopes) assert.ok(SCOPES[s], s);
  }
});

// The desktop's demo box runs the REAL transcript view (one source of truth, no client copy), so its whole import closure is
// bundled into the renderer: it must stay browser-safe. A Node-only import (media.mjs → node:fs, outbox → os) breaks the
// production build; this fails first, naming the file.
test("src/server/transcriptView.mjs imports nothing Node-only, directly or transitively (the demo renderer bundles it)", () => {
  const seen = new Set();
  const offenders = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+"([^"]+)"/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) {
        offenders.push(`${relative(ROOT, file)} imports "${spec}"`);
        continue;
      }
      const base = join(file, "..", spec);
      const target = [base, `${base}.mjs`, `${base}.ts`].find((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (target) walk(target);
    }
  };
  walk(join(ROOT, "src/server/transcriptView.mjs"));
  assert.deepEqual(offenders, []);
  for (const f of seen) assert.match(relative(ROOT, f), /^src\/(shared\/|server\/(transcriptView|transcriptRuns)\.mjs$)/, `unexpected module in the demo bundle: ${f}`);
});

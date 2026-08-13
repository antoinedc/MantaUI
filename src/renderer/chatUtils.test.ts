import { describe, it, expect, vi } from "vitest";
import {
  createEntryMotionState,
  updateEntryMotion,
  markReconciledFromOptimistic,
  isOptimisticUserId,
  computeTurnInfo,
  computeLiveTurn,
  formatTokens,
  formatBytes,
  expiryLabel,
  formatDuration,
  formatClockTime,
  ctxStageColor,
  cssVar,
  filterCommands,
  dedupeAgainstBuiltins,
  formatModelContextSize,
  formatHiddenTodosSummary,
  summarizeTodoProgress,
  todoStatusOf,
  buildQuestionAnswers,
  canSubmitQuestion,
  commandPrefixKey,
  detectCommandFromText,
  MIN_COMMAND_PREFIX_LEN,
  formatAge,
  shouldAbortForQueuedDrain,
  isToolStepBoundary,
  isDrainAbortError,
  isUnknownChannelError,
  describeCron,
  nextCronRun,
  describeNextRun,
  resolveToolOutput,
  trimOutputEdges,
  reconcileOptimisticUser,
  shouldForceReconnect,
  shouldReconnectOnAppStateChange,
  runWithConcurrency,
  chooseUpdateSkewVariant,
  isTransientUpdateNetworkError,
  arrowUpNavigatesHistory,
  arrowDownNavigatesHistory,
  parseDeviceCode,
  deviceCodeFallback,
  formatRemaining,
  slugifyProviderId,
  customProviderDraftError,
  connectPhaseLabel,
  isPollExpired,
  describeSubscriptionStatus,
  arrangeCards,
  terminalShortcut,
  authErrorAdvice,
  AUTH_PROVIDER_LABELS,
  terminalMountKey,
  registerMountedTerminal,
  isJobRow,
  formatJobSummary,
  isBackgroundJobCompletionTurn,
  windowPinId,
  parsePinId,
  resolvePin,
  fuzzySessionScore,
  computeJobNesting,
  shouldResyncWindowsForJobs,
  globCovers,
  isApprovalCoveredByAlways,
  shortModelName,
  isFastModelId,
  parseModelRef,
  baseModelId,
  fastModelId,
  hideFastSiblingGroups,
  resolveFastToggle,
  filterModelGroups,
  moveMenuHighlight,
  MAX_PREVIEW_BYTES,
  resolvePreviewType,
  isWithinPreviewSize,
  formatPreviewFooter,
  countPreviewLines,
  previewLanguage,
  previewOriginWord,
  decodeDataUri,
  fetchTranscriptWithRetry,
  selectUsageSnapshot,
  usageDialState,
  formatWindowReset,
  formatUpdatedAgo,
  usageStale,
  pruneVisitedSessions,
  selectStatusItems,
  checksChipDescriptor,
  countsForChecks,
  branchChipLabel,
  shouldOfferForgeConnect,
  failuresToAgentPrompt,
  zeroStateMode,
  initialRepoSelection,
  describeRepoRow,
  planHighlightRanges,
  type StatusItem,
  type RepoRow,
} from "./chatUtils";

import type { OpencodeModel, UsageSnapshot } from "../shared/types";



// ===== formatTokens =====

// ===== terminalMountKey =====

describe("terminalMountKey", () => {
  it("is stable for the same inputs", () => {
    expect(terminalMountKey("proj", 0, "terminal")).toBe(
      terminalMountKey("proj", 0, "terminal"),
    );
  });

  it("different window indexes in the same session produce different keys", () => {
    expect(terminalMountKey("proj", 0, "terminal")).not.toBe(
      terminalMountKey("proj", 1, "terminal"),
    );
  });

  it("a session name containing `:` does not collide with a different session/index pair", () => {
    // Without the NUL separator, a `:` in the session name would let two
    // distinct (session, index, modeId) tuples produce the same string.
    // Pin the separator behaviour: tmux session names may contain `:`,
    // so the key must not be parseable on `:`. Two tuples that would
    // collide under a `:` separator must produce distinct keys here.
    const colonInSession = terminalMountKey("proj:0", 1, "terminal");
    const parsedAcrossColon = terminalMountKey("proj", 0, "1:terminal");
    expect(colonInSession).not.toBe(parsedAcrossColon);
    // The key is opaque (NUL-separated) by design — splitting on NUL must
    // yield exactly the input triple for the colon-in-session case.
    expect(colonInSession.split("\u0000")).toEqual(["proj:0", "1", "terminal"]);
  });

  it("different modeIds for the same window produce different keys", () => {
    expect(terminalMountKey("proj", 0, "terminal")).not.toBe(
      terminalMountKey("proj", 0, "claude"),
    );
  });
});

// ===== registerMountedTerminal =====

describe("registerMountedTerminal", () => {
  it("is a no-op for chat mode (no PTY is needed)", () => {
    const visited = new Map();
    registerMountedTerminal(visited, "proj", 0, "chat", "/tmp", "sid");
    expect(visited.size).toBe(0);
  });

  it("records a terminal mount with tmuxTarget for adopted windows", () => {
    const visited = new Map();
    registerMountedTerminal(visited, "proj", 0, "terminal", "/tmp", null);
    const entry = visited.get(terminalMountKey("proj", 0, "terminal"));
    expect(entry).toEqual({
      tmuxSession: "proj",
      windowIndex: 0,
      modeId: "terminal",
      cwd: "/tmp",
      tmuxTarget: "proj:0",
    });
  });

  it("records a terminal mount WITHOUT tmuxTarget for manta-created windows", () => {
    const visited = new Map();
    registerMountedTerminal(visited, "proj", 0, "terminal", "/tmp", "sid-abc");
    const entry = visited.get(terminalMountKey("proj", 0, "terminal"));
    expect(entry).toEqual({
      tmuxSession: "proj",
      windowIndex: 0,
      modeId: "terminal",
      cwd: "/tmp",
    });
    expect(entry?.tmuxTarget).toBeUndefined();
  });

  it("strips the tui: prefix from launcher modes", () => {
    const visited = new Map();
    registerMountedTerminal(visited, "proj", 0, "tui:claude", "/tmp", "sid");
    const entry = visited.get(terminalMountKey("proj", 0, "claude"));
    expect(entry?.modeId).toBe("claude");
    expect(entry?.tmuxTarget).toBeUndefined();
  });
});

describe("formatTokens", () => {
  it("shows raw count below 1k", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(1)).toBe("1 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
  });

  it("shows one-decimal k between 1k and 100k", () => {
    expect(formatTokens(1000)).toBe("1k tokens");
    expect(formatTokens(1500)).toBe("1.5k tokens");
    expect(formatTokens(12_400)).toBe("12.4k tokens");
    expect(formatTokens(99_999)).toBe("100k tokens"); // rounds up
  });

  it("drops decimal when it would be .0", () => {
    expect(formatTokens(5_000)).toBe("5k tokens");
    expect(formatTokens(10_000)).toBe("10k tokens");
  });

  it("shows rounded-xs k at 100k and above", () => {
    expect(formatTokens(100_000)).toBe("100k tokens");
    expect(formatTokens(123_456)).toBe("123k tokens");
    expect(formatTokens(200_000)).toBe("200k tokens");
  });
});

// ===== formatBytes =====

describe("formatBytes", () => {
  it("returns empty string for 0 / unknown / negative", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-5)).toBe("");
    expect(formatBytes(NaN)).toBe("");
  });

  it("formats raw bytes under 1 KiB", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats KB with one decimal under 10, rounded-xs above", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
  });

  it("scales up through MB / GB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });
});

// ===== expiryLabel =====

describe("expiryLabel", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;

  it("returns empty for null / non-finite / NaN expiry", () => {
    expect(expiryLabel(null, NOW)).toBe("");
    expect(expiryLabel(undefined, NOW)).toBe("");
    expect(expiryLabel(NaN, NOW)).toBe("");
  });

  it("returns empty when already expired", () => {
    expect(expiryLabel(NOW, NOW)).toBe("");
    expect(expiryLabel(NOW - 1000, NOW)).toBe("");
  });

  it("floors to whole hours, never below 1h", () => {
    expect(expiryLabel(NOW + 23 * HOUR, NOW)).toBe("23h");
    expect(expiryLabel(NOW + 2 * HOUR, NOW)).toBe("2h");
    expect(expiryLabel(NOW + 30 * 60 * 1000, NOW)).toBe("1h");
    expect(expiryLabel(NOW + 100 * 1000, NOW)).toBe("1h");
  });

  it("floors a fractional remaining hour to the whole hour", () => {
    expect(expiryLabel(NOW + (23 * HOUR + 30 * 60 * 1000), NOW)).toBe("23h");
  });
});

// ===== formatDuration =====

describe("formatDuration", () => {
  it("returns <1s for anything under 1000ms", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("returns seconds for sub-minute durations", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(5_500)).toBe("6s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("returns minutes and seconds (no spaces)", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(104_000)).toBe("1m44s");
  });

  it("returns hours, minutes, and seconds (no spaces)", () => {
    expect(formatDuration(3_600_000)).toBe("1h0m0s");
    expect(formatDuration(3_661_000)).toBe("1h1m1s");
    expect(formatDuration(7_384_000)).toBe("2h3m4s");
  });
});

// ===== formatClockTime =====

describe("formatClockTime", () => {
  it("returns empty string for null/undefined/non-finite", () => {
    expect(formatClockTime(null)).toBe("");
    expect(formatClockTime(undefined)).toBe("");
    expect(formatClockTime(NaN)).toBe("");
    expect(formatClockTime(Infinity)).toBe("");
  });

  it("formats epoch ms as zero-padded 24h HH:MM (local time)", () => {
    // Build a known local time so the test is timezone-independent.
    const d = new Date(2026, 0, 2, 9, 5, 0); // 09:05 local
    expect(formatClockTime(d.getTime())).toBe("09:05");
    const d2 = new Date(2026, 0, 2, 23, 59, 0); // 23:59 local
    expect(formatClockTime(d2.getTime())).toBe("23:59");
    const d3 = new Date(2026, 0, 2, 0, 0, 0); // 00:00 local
    expect(formatClockTime(d3.getTime())).toBe("00:00");
  });
});

// ===== ctxStageColor =====

describe("ctxStageColor", () => {
  it("returns ok below 50%", () => {
    expect(ctxStageColor(0)).toBe(cssVar("--ok"));
    expect(ctxStageColor(49)).toBe(cssVar("--ok"));
  });

  it("returns warn from 50% to 74%", () => {
    expect(ctxStageColor(50)).toBe(cssVar("--warn"));
    expect(ctxStageColor(74)).toBe(cssVar("--warn"));
  });

  it("returns warn from 75% to 89%", () => {
    expect(ctxStageColor(75)).toBe(cssVar("--warn"));
    expect(ctxStageColor(89)).toBe(cssVar("--warn"));
  });

  it("returns danger from 90% and above", () => {
    expect(ctxStageColor(90)).toBe(cssVar("--danger"));
    expect(ctxStageColor(100)).toBe(cssVar("--danger"));
  });
});

// ===== formatModelContextSize =====
describe("formatModelContextSize", () => {
  it("formats a context limit as a rounded 'Nk' string below 1M", () => {
    expect(formatModelContextSize(200_000)).toBe("200k");
    expect(formatModelContextSize(999_000)).toBe("999k");
    expect(formatModelContextSize(1_500)).toBe("2k");
  });

  it("switches to 'NM' (millions) at or above 1_000_000, stripping a trailing .0", () => {
    expect(formatModelContextSize(1_000_000)).toBe("1M");
    expect(formatModelContextSize(1_500_000)).toBe("1.5M");
    expect(formatModelContextSize(2_000_000)).toBe("2M");
    expect(formatModelContextSize(1_200_000)).toBe("1.2M");
  });

  it("returns null for missing/non-positive/non-finite values", () => {
    expect(formatModelContextSize(null)).toBeNull();
    expect(formatModelContextSize(undefined)).toBeNull();
    expect(formatModelContextSize(0)).toBeNull();
    expect(formatModelContextSize(-1)).toBeNull();
    expect(formatModelContextSize(Infinity)).toBeNull();
    expect(formatModelContextSize(NaN)).toBeNull();
  });
});

// ===== filterModelGroups =====

function model(id: string, providerID: string): OpencodeModel {
  return {
    id,
    providerID,
    name: id,
    limit: { context: 200_000 },
  };
}

const FILTER_GROUPS: Array<[string, OpencodeModel[]]> = [
  ["anthropic", [model("claude-opus-4", "anthropic"), model("claude-sonnet-4", "anthropic")]],
  ["deepseek", [model("deepseek-chat", "deepseek")]],
  ["groq", [model("llama-3.3-70b", "groq")]],
];

describe("filterModelGroups", () => {
  it("returns the groups unchanged for an empty / whitespace query", () => {
    expect(filterModelGroups(FILTER_GROUPS, "")).toEqual(FILTER_GROUPS);
    expect(filterModelGroups(FILTER_GROUPS, "   ")).toEqual(FILTER_GROUPS);
  });

  it("matches on the model name, case-insensitively", () => {
    const out = filterModelGroups(FILTER_GROUPS, "CLAUDE-OPUS");
    expect(out).toEqual([["anthropic", [model("claude-opus-4", "anthropic")]]]);
  });

  it("matches on the provider id", () => {
    const out = filterModelGroups(FILTER_GROUPS, "deepseek");
    expect(out).toEqual([["deepseek", [model("deepseek-chat", "deepseek")]]]);
  });

  it("elides a group whose models all filter out", () => {
    const out = filterModelGroups(FILTER_GROUPS, "llama");
    expect(out).toEqual([["groq", [model("llama-3.3-70b", "groq")]]]);
  });

  it("returns no groups when nothing matches", () => {
    expect(filterModelGroups(FILTER_GROUPS, "zzz")).toEqual([]);
  });
});

// ===== moveMenuHighlight =====

describe("moveMenuHighlight", () => {
  it("returns -1 for an empty option list", () => {
    expect(moveMenuHighlight(0, 1, 0)).toBe(-1);
    expect(moveMenuHighlight(-1, 1, 0)).toBe(-1);
  });

  it("wraps from the bottom back to the top", () => {
    expect(moveMenuHighlight(2, 1, 3)).toBe(0);
  });

  it("wraps from the top back to the bottom", () => {
    expect(moveMenuHighlight(0, -1, 3)).toBe(2);
  });

  it("steps within the list", () => {
    expect(moveMenuHighlight(1, 1, 3)).toBe(2);
    expect(moveMenuHighlight(1, -1, 3)).toBe(0);
  });

  it("starts at the top from a cold index going down, bottom going up", () => {
    expect(moveMenuHighlight(-1, 1, 3)).toBe(0);
    expect(moveMenuHighlight(-1, -1, 3)).toBe(2);
  });
});

// ===== computeContextBreakdown =====


// ===== findFlushBoundary =====


// ===== mergeBufferedDeltas =====


// ===== selectCacheTtlMs =====


// ===== selectLastAssistantCompletion =====


// ===== computeStaleCache =====


// ===== formatAge =====

describe("formatAge", () => {
  it("collapses sub-minute elapsed to 'now'", () => {
    expect(formatAge(0)).toBe("now");
    expect(formatAge(59_000)).toBe("now");
  });

  it("floors to minutes below an hour", () => {
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(59 * 60_000)).toBe("59m");
  });

  it("floors to hours below a day", () => {
    expect(formatAge(60 * 60_000)).toBe("1h");
    expect(formatAge(23 * 3_600_000)).toBe("23h");
  });

  it("floors to days at/above 24h", () => {
    expect(formatAge(24 * 3_600_000)).toBe("1d");
  });

  it("treats negative/NaN input as 'now'", () => {
    expect(formatAge(-1000)).toBe("now");
    expect(formatAge(NaN)).toBe("now");
  });
});

// ===== classifyCacheAge =====


// ===== classifyFinish =====


// ===== describeTruncation =====


// ===== filterCommands =====

const COMMANDS = [
  { name: "clear", description: "Clear chat" },
  { name: "fork", description: "Fork session" },
  { name: "compact", description: "Compact context" },
  { name: "help", description: "Show help" },
];

describe("filterCommands", () => {
  it("returns all commands when query is empty", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(4);
  });

  it("filters by substring match (case-insensitive)", () => {
    expect(filterCommands(COMMANDS, "c")).toEqual([
      { name: "clear", description: "Clear chat" },
      { name: "compact", description: "Compact context" },
    ]);
    expect(filterCommands(COMMANDS, "C")).toEqual([
      { name: "clear", description: "Clear chat" },
      { name: "compact", description: "Compact context" },
    ]);
  });

  it("returns empty array when no match", () => {
    expect(filterCommands(COMMANDS, "zzz")).toEqual([]);
  });

  it("matches full name", () => {
    expect(filterCommands(COMMANDS, "fork")).toEqual([
      { name: "fork", description: "Fork session" },
    ]);
  });
});

// ===== dedupeAgainstBuiltins =====

describe("dedupeAgainstBuiltins", () => {
  const builtins = new Set(["clear", "help", "fork", "compact"]);

  it("removes commands whose names are in the builtin set", () => {
    const opencode = [
      { name: "clear", description: "Opencode clear" },
      { name: "init", description: "Init project" },
      { name: "help", description: "Opencode help" },
      { name: "update-claudemd", description: "Update docs" },
    ];
    const result = dedupeAgainstBuiltins(opencode, builtins);
    expect(result).toEqual([
      { name: "init", description: "Init project" },
      { name: "update-claudemd", description: "Update docs" },
    ]);
  });

  it("returns all commands when none collide", () => {
    const opencode = [
      { name: "deploy", description: "Deploy" },
      { name: "refactor", description: "Refactor" },
    ];
    expect(dedupeAgainstBuiltins(opencode, builtins)).toHaveLength(2);
  });

  it("returns empty array when all commands collide", () => {
    const opencode = [{ name: "clear" }, { name: "help" }];
    expect(dedupeAgainstBuiltins(opencode, builtins)).toEqual([]);
  });
});

// ===== isTerminalTodo / allTodosTerminal =====



// ===== selectActiveTodos =====


// ===== selectVisibleTodos / formatHiddenTodosSummary =====


describe("formatHiddenTodosSummary", () => {
  it("returns null when nothing is hidden", () => {
    expect(formatHiddenTodosSummary(0, 0)).toBeNull();
  });

  it("formats pending-only", () => {
    expect(formatHiddenTodosSummary(5, 0)).toBe("+ 5 pending");
    expect(formatHiddenTodosSummary(1, 0)).toBe("+ 1 pending");
  });

  it("formats done-only", () => {
    expect(formatHiddenTodosSummary(0, 4)).toBe("+ 4 done");
    expect(formatHiddenTodosSummary(0, 1)).toBe("+ 1 done");
  });

  it("formats both with the literal '&' separator from the spec", () => {
    expect(formatHiddenTodosSummary(5, 5)).toBe("+ 5 pending & 5 done");
    expect(formatHiddenTodosSummary(2, 3)).toBe("+ 2 pending & 3 done");
  });
});

// ===== todoStatusOf / summarizeTodoProgress =====

describe("todoStatusOf", () => {
  it("maps the four canonical statuses", () => {
    expect(todoStatusOf({ status: "in_progress" })).toBe("in_progress");
    expect(todoStatusOf({ status: "completed" })).toBe("completed");
    expect(todoStatusOf({ status: "cancelled" })).toBe("cancelled");
    expect(todoStatusOf({ status: "pending" })).toBe("pending");
  });

  it("is case-insensitive — the render path used to compare raw strings, so a "
    + "mixed-case status sorted as current but drew the pending mark", () => {
    expect(todoStatusOf({ status: "In_Progress" })).toBe("in_progress");
    expect(todoStatusOf({ status: "COMPLETED" })).toBe("completed");
  });

  it("treats an unknown or missing status as pending", () => {
    expect(todoStatusOf({ status: "blocked" })).toBe("pending");
    expect(todoStatusOf({})).toBe("pending");
    expect(todoStatusOf({ status: null })).toBe("pending");
  });
});

describe("summarizeTodoProgress", () => {
  const todo = (status: string) => ({ status, content: "x" });

  it("counts settled vs in-flight and labels the done/total counter", () => {
    const p = summarizeTodoProgress([
      todo("in_progress"),
      todo("completed"),
      todo("completed"),
      todo("pending"),
    ]);
    expect(p.total).toBe(4);
    expect(p.settled).toBe(2);
    expect(p.inProgress).toBe(1);
    expect(p.label).toBe("2/4");
    expect(p.allSettled).toBe(false);
  });

  it("counts cancelled as settled — the model is done with it", () => {
    const p = summarizeTodoProgress([todo("cancelled"), todo("pending")]);
    expect(p.settled).toBe(1);
    expect(p.label).toBe("1/2");
  });

  it("segment widths are percentages of the WHOLE list, not the visible cap", () => {
    const p = summarizeTodoProgress([
      todo("completed"),
      todo("completed"),
      todo("in_progress"),
      todo("pending"),
    ]);
    expect(p.settledPct).toBe(50);
    expect(p.activePct).toBe(25);
    // The two segments never exceed the track.
    expect(p.settledPct + p.activePct).toBeLessThanOrEqual(100);
  });

  it("labels the done/total counter once every item is terminal", () => {
    const p = summarizeTodoProgress([todo("completed"), todo("cancelled")]);
    expect(p.allSettled).toBe(true);
    expect(p.label).toBe("2/2");
    expect(p.settledPct).toBe(100);
  });

  it("does not divide by zero on an empty list", () => {
    const p = summarizeTodoProgress([]);
    expect(p.settledPct).toBe(0);
    expect(p.activePct).toBe(0);
    expect(p.allSettled).toBe(false);
    expect(p.label).toBe("0/0");
  });
});

// ===== isSelfFilteringLifecycleEvent =====


// ===== applyQuestionEvent =====



// ===== BET-112 regression: live path replaces stale GET /question re-poll =====
//
// The hook's useSseBus now drives question state via applyQuestionEvent on
// every question.* event instead of re-polling GET /question (which returns
// ALL cumulatively-pending workspace questions and dropped both the sessionID
// filter and the que_ requestId). These cases lock the properties the live
// path depends on: distinct in-session asks accumulate WITHOUT stacking a
// cross-session backlog, and every stored card carries a usable requestId so
// submit can actually POST the reply (the "stuck on loading" root cause).

// ===== hydrateQuestion =====


// ===== buildQuestionAnswers / canSubmitQuestion =====

describe("buildQuestionAnswers", () => {
  it("sends only selected labels when no custom text", () => {
    const sel = [new Set(["Yes"])];
    expect(buildQuestionAnswers(sel, [""])).toEqual([["Yes"]]);
  });

  it("sends only custom text when nothing selected", () => {
    const sel = [new Set<string>()];
    expect(buildQuestionAnswers(sel, ["only staging"])).toEqual([
      ["only staging"],
    ]);
  });

  it("appends custom text AFTER selected labels when both present", () => {
    const sel = [new Set(["Yes"])];
    expect(buildQuestionAnswers(sel, ["but only staging"])).toEqual([
      ["Yes", "but only staging"],
    ]);
  });

  it("trims custom text and ignores whitespace-only input", () => {
    const sel = [new Set(["A"])];
    expect(buildQuestionAnswers(sel, ["   "])).toEqual([["A"]]);
    expect(buildQuestionAnswers([new Set(["A"])], ["  hi  "])).toEqual([
      ["A", "hi"],
    ]);
  });

  it("handles multiple questions independently", () => {
    const sel = [new Set(["X"]), new Set<string>()];
    expect(buildQuestionAnswers(sel, ["", "freeform"])).toEqual([
      ["X"],
      ["freeform"],
    ]);
  });

  it("preserves multi-select labels then custom", () => {
    const sel = [new Set(["A", "B"])];
    const out = buildQuestionAnswers(sel, ["note"]);
    expect(out[0]).toContain("A");
    expect(out[0]).toContain("B");
    expect(out[0][out[0].length - 1]).toBe("note");
  });

  it("tolerates a missing customValues entry", () => {
    const sel = [new Set(["A"])];
    expect(buildQuestionAnswers(sel, [])).toEqual([["A"]]);
  });
});

describe("canSubmitQuestion", () => {
  it("true when every question has a selection", () => {
    expect(canSubmitQuestion([new Set(["A"]), new Set(["B"])], ["", ""])).toBe(
      true,
    );
  });

  it("true when a question has only custom text", () => {
    expect(canSubmitQuestion([new Set<string>()], ["typed"])).toBe(true);
  });

  it("false when a question has neither selection nor text", () => {
    expect(canSubmitQuestion([new Set(["A"]), new Set<string>()], ["", ""])).toBe(
      false,
    );
  });

  it("treats whitespace-only custom text as empty", () => {
    expect(canSubmitQuestion([new Set<string>()], ["   "])).toBe(false);
  });

  it("empty request (no questions) is trivially submittable", () => {
    expect(canSubmitQuestion([], [])).toBe(true);
  });
});

// ===== commandPrefixKey =====

describe("commandPrefixKey", () => {
  it("returns the full template when there are no placeholders", () => {
    const tpl = "# Refactor\n\nDo a refactoring session, no args.";
    expect(commandPrefixKey(tpl)).toBe(tpl);
  });

  it("truncates at the first $ARGUMENTS placeholder", () => {
    const tpl = "Create a component named $ARGUMENTS with TypeScript.";
    expect(commandPrefixKey(tpl)).toBe("Create a component named");
  });

  it("truncates at the first $N positional placeholder", () => {
    const tpl = "Create a file named $1 in $2 with content $3.";
    expect(commandPrefixKey(tpl)).toBe("Create a file named");
  });

  it("returns null for templates shorter than MIN_COMMAND_PREFIX_LEN", () => {
    // Even with a long template, if the prefix before the first $ is short,
    // it would generate too many false positives. Reject.
    expect(commandPrefixKey("$1 do thing")).toBeNull();
    expect(commandPrefixKey("Run $1 do thing")).toBeNull(); // "Run" < 12
  });

  it("strips trailing whitespace from the prefix", () => {
    const tpl = "Some prefix here   $ARGUMENTS more stuff";
    expect(commandPrefixKey(tpl)).toBe("Some prefix here");
  });

  it("handles non-string input defensively", () => {
    expect(commandPrefixKey(undefined as unknown as string)).toBeNull();
  });

  it("treats sentinel length correctly", () => {
    // Exactly MIN_COMMAND_PREFIX_LEN chars → accepted.
    const exact = "a".repeat(MIN_COMMAND_PREFIX_LEN);
    expect(commandPrefixKey(exact)).toBe(exact);
    // One char shorter → rejected.
    expect(commandPrefixKey("a".repeat(MIN_COMMAND_PREFIX_LEN - 1))).toBeNull();
  });
});

// ===== detectCommandFromText =====

describe("detectCommandFromText", () => {
  const commands = [
    { name: "refactor", template: "# Refactor\n\nYou are doing a focused refactoring session." },
    { name: "deploy", template: "# Deploy\n\nDeploy the project to production using ./scripts/deploy.sh." },
    { name: "component", template: "Create a new React component named $ARGUMENTS with TypeScript." },
    { name: "short", template: "$1 foo" }, // prefix too short, ignored
  ];

  it("returns null for empty / missing text", () => {
    expect(detectCommandFromText("", commands)).toBeNull();
    expect(detectCommandFromText(undefined as unknown as string, commands)).toBeNull();
  });

  it("returns null when no command matches", () => {
    expect(detectCommandFromText("Just a plain user prompt.", commands)).toBeNull();
  });

  it("matches a no-argument command on full template equality", () => {
    expect(detectCommandFromText(commands[0].template!, commands)).toBe("refactor");
  });

  it("matches a placeholder command on its static prefix", () => {
    expect(
      detectCommandFromText("Create a new React component named Button with TypeScript.", commands),
    ).toBe("component");
  });

  it("ignores commands whose prefix is too short", () => {
    // The "short" command has a sub-MIN_COMMAND_PREFIX_LEN prefix and must
    // not match arbitrary user prompts that happen to start similarly.
    expect(detectCommandFromText("any text whatsoever", commands)).toBeNull();
  });

  it("picks the longest matching prefix when multiple commands would match", () => {
    const overlap = [
      { name: "general", template: "# Header line that is long enough." },
      { name: "specific", template: "# Header line that is long enough. With more detail here." },
    ];
    // Text matches both prefixes; the more specific one wins.
    const text = "# Header line that is long enough. With more detail here. and trailing text";
    expect(detectCommandFromText(text, overlap)).toBe("specific");
  });

  it("returns null for empty commands list", () => {
    expect(detectCommandFromText("# Refactor\n\nYou are doing...", [])).toBeNull();
  });

  it("skips commands without a template", () => {
    const noTemplate = [{ name: "x" }, { name: "refactor", template: commands[0].template }];
    expect(detectCommandFromText(commands[0].template!, noTemplate)).toBe("refactor");
  });
});

// ===== isAssistantTurnComplete =====
//
// Regression: SSE UI completion gap. The spinner is cleared only by live
// `session.idle`/`session.status{idle}`/`session.error` events. When the
// scoped event stream drops AFTER the first post-resume frame but BEFORE
// `session.idle` (half-dead dedicated tunnel — "got a first line then
// hangs"), that idle event is missed forever and the UI spins on a turn
// that finished server-side. This helper lets the renderer recompute
// "done" from the authoritative transcript (assistant `time.completed`)
// on refetch and clear the stuck spinner.


// ===== Subagent helpers =====





// ===== Per-session event filter (subagent allowlist) =====
//
// These exist to lock in the ordering invariant: registration must run
// BEFORE the filter, otherwise a live `session.created` for a brand-new
// subagent child is dropped by its own filter pass (the new child id
// isn't in the allowlist yet — this very event is what would register
// it).



// ===== isAssistantTurnInProgress =====
//
// Regression: a session whose last assistant turn wedged (stuck mid-tool-
// call — opencode never emitted idle) looked IDLE on panel mount because
// the initial load never derived `running` from the transcript. With no
// spinner there was no abort affordance; new prompts queued silently
// behind the dead turn. This helper drives `running` true at mount so the
// abort button appears.


describe("shouldAbortForQueuedDrain", () => {
  it("aborts at a step boundary when a prompt is queued and not already draining", () => {
    expect(shouldAbortForQueuedDrain(1, false)).toBe(true);
    expect(shouldAbortForQueuedDrain(3, false)).toBe(true);
  });

  it("does nothing when the queue is empty", () => {
    expect(shouldAbortForQueuedDrain(0, false)).toBe(false);
  });

  it("does not re-fire while a drain-abort is already in flight (re-entrancy guard)", () => {
    // Several session.next.step.ended events can arrive before the abort POST
    // lands; only the first should issue the abort.
    expect(shouldAbortForQueuedDrain(1, true)).toBe(false);
    expect(shouldAbortForQueuedDrain(5, true)).toBe(false);
  });
});

describe("isToolStepBoundary", () => {
  it("is true for a completed tool part (the real mid-turn step boundary)", () => {
    expect(isToolStepBoundary({ type: "tool", state: { status: "completed" } })).toBe(true);
  });

  it("is true for an errored tool part (turn is about to recover/continue)", () => {
    expect(isToolStepBoundary({ type: "tool", state: { status: "error" } })).toBe(true);
  });

  it("is false for a tool part still pending/running (not a boundary yet)", () => {
    expect(isToolStepBoundary({ type: "tool", state: { status: "pending" } })).toBe(false);
    expect(isToolStepBoundary({ type: "tool", state: { status: "running" } })).toBe(false);
  });

  it("is false for non-tool parts (text/reasoning stream mid-step)", () => {
    expect(isToolStepBoundary({ type: "text", state: { status: "completed" } })).toBe(false);
    expect(isToolStepBoundary({ type: "reasoning", state: { status: "completed" } })).toBe(false);
  });

  it("is false for malformed / missing input", () => {
    expect(isToolStepBoundary(null)).toBe(false);
    expect(isToolStepBoundary(undefined)).toBe(false);
    expect(isToolStepBoundary({})).toBe(false);
    expect(isToolStepBoundary({ type: "tool" })).toBe(false);
    expect(isToolStepBoundary("tool")).toBe(false);
  });
});

describe("isDrainAbortError", () => {
  it("swallows the MessageAbortedError produced by our own drain-abort", () => {
    expect(isDrainAbortError("MessageAbortedError", true)).toBe(true);
  });

  it("does NOT swallow a manual abort (draining=false) — that error is real to the user", () => {
    expect(isDrainAbortError("MessageAbortedError", false)).toBe(false);
  });

  it("never swallows other error names even while draining", () => {
    expect(isDrainAbortError("ApiError", true)).toBe(false);
    expect(isDrainAbortError("ContextOverflowError", true)).toBe(false);
    expect(isDrainAbortError(undefined, true)).toBe(false);
  });
});

describe("isUnknownChannelError", () => {
  it("matches the exact message manta-server's rpc dispatcher throws", () => {
    expect(isUnknownChannelError("unknown rpc channel: delegate:list")).toBe(true);
  });

  it("matches wrapped variants that still contain the marker", () => {
    expect(isUnknownChannelError("HTTP 500 unknown rpc channel: delegate:list")).toBe(true);
    expect(isUnknownChannelError('rpc failed: { channel: "delegate:list", error: "unknown rpc channel: delegate:list" }')).toBe(true);
  });

  it("does NOT match other errors (transport blips, real 500s, auth)", () => {
    expect(isUnknownChannelError("Network request failed")).toBe(false);
    expect(isUnknownChannelError("HTTP 500 Internal Server Error")).toBe(false);
    expect(isUnknownChannelError("fetch failed: socket hang up")).toBe(false);
    expect(isUnknownChannelError("")).toBe(false);
  });
});





describe("describeCron", () => {
  it("every-N-minutes", () => {
    expect(describeCron("*/5 * * * *")).toBe("every 5 min");
    expect(describeCron("*/15 * * * *")).toBe("every 15 min");
  });
  it("hourly", () => {
    expect(describeCron("0 * * * *")).toBe("hourly");
    expect(describeCron("7 * * * *")).toBe("hourly at :07");
  });
  it("every-N-hours", () => {
    expect(describeCron("0 */2 * * *")).toBe("every 2h");
  });
  it("daily at time", () => {
    expect(describeCron("0 9 * * *")).toBe("daily 9:00");
    expect(describeCron("30 14 * * *")).toBe("daily 14:30");
  });
  it("one-shot daily renders 'once at'", () => {
    expect(describeCron("0 15 * * *", false)).toBe("once at 15:00");
  });
  it("weekdays", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("weekdays 9:00");
  });
  it("specific weekday", () => {
    expect(describeCron("0 9 * * 1")).toBe("Mon 9:00");
    expect(describeCron("0 9 * * 0")).toBe("Sun 9:00");
    expect(describeCron("0 9 * * 7")).toBe("Sun 9:00");
  });
  it("monthly on day", () => {
    expect(describeCron("30 14 15 * *")).toBe("monthly on the 15th at 14:30");
    expect(describeCron("0 0 1 * *")).toBe("monthly on the 1st at 0:00");
  });
  it("falls back to raw for unrecognized / invalid", () => {
    expect(describeCron("30 14 15 3 *")).toBe("30 14 15 3 *"); // specific month → raw
    expect(describeCron("garbage")).toBe("garbage");
    expect(describeCron("")).toBe("(invalid)");
  });
  it("never throws", () => {
    expect(() => describeCron(null as unknown as string)).not.toThrow();
  });
});

describe("nextCronRun", () => {
  // Fixed local reference: Mon 2026-01-05 10:30:00 local.
  const FROM = new Date(2026, 0, 5, 10, 30, 0).getTime();

  it("returns null for invalid expressions", () => {
    expect(nextCronRun("garbage", FROM)).toBeNull();
    expect(nextCronRun("", FROM)).toBeNull();
    expect(nextCronRun("60 0 * * *", FROM)).toBeNull(); // minute out of range
    expect(nextCronRun("0 0 * *", FROM)).toBeNull(); // only 4 fields
  });

  it("every-5-min lands on the next 5-minute boundary after now", () => {
    const next = nextCronRun("*/5 * * * *", FROM)!;
    expect(new Date(next).getMinutes()).toBe(35); // 10:30 → next */5 is 10:35
    expect(next).toBe(new Date(2026, 0, 5, 10, 35, 0).getTime());
  });

  it("daily at a later time today returns today's time", () => {
    const next = nextCronRun("0 14 * * *", FROM)!;
    expect(next).toBe(new Date(2026, 0, 5, 14, 0, 0).getTime());
  });

  it("daily at an earlier time rolls to tomorrow", () => {
    const next = nextCronRun("0 9 * * *", FROM)!;
    expect(next).toBe(new Date(2026, 0, 6, 9, 0, 0).getTime());
  });

  it("weekday cron skips the weekend (FROM is Monday)", () => {
    // Next Tuesday 9:00 from Monday 10:30.
    const next = nextCronRun("0 9 * * 2", FROM)!;
    expect(new Date(next).getDay()).toBe(2);
    expect(next).toBe(new Date(2026, 0, 6, 9, 0, 0).getTime());
  });

  it("does not return the current minute even if it matches", () => {
    // FROM is exactly 10:30; "30 10 * * *" matches now but next must be > now.
    const next = nextCronRun("30 10 * * *", FROM)!;
    expect(next).toBe(new Date(2026, 0, 6, 10, 30, 0).getTime()); // tomorrow
  });
});

describe("describeNextRun", () => {
  const FROM = new Date(2026, 0, 5, 10, 30, 0).getTime();

  it("returns empty for invalid cron", () => {
    expect(describeNextRun("garbage", true, FROM)).toBe("");
  });

  it("uses relative minutes for soon runs", () => {
    expect(describeNextRun("*/5 * * * *", true, FROM)).toBe("in 5m");
  });

  it("uses relative hours within 6h", () => {
    expect(describeNextRun("30 13 * * *", true, FROM)).toBe("in 3h");
  });

  it("uses 'today HH:MM' for same-day runs beyond 6h", () => {
    expect(describeNextRun("0 23 * * *", true, FROM)).toBe("today 23:00");
  });

  it("uses 'tomorrow HH:MM' for next-day runs", () => {
    expect(describeNextRun("0 9 * * *", true, FROM)).toBe("tomorrow 09:00");
  });

  it("never throws on bad input", () => {
    expect(() => describeNextRun(null as unknown as string, true, FROM)).not.toThrow();
  });
});

describe("trimOutputEdges", () => {
  it("drops trailing blank lines (the card's phantom bottom padding)", () => {
    expect(trimOutputEdges("a\nb\n")).toBe("a\nb");
    expect(trimOutputEdges("a\nb\n\n\n")).toBe("a\nb");
    expect(trimOutputEdges("a\nb\n   \n\t\n")).toBe("a\nb");
  });

  it("drops leading blank lines", () => {
    expect(trimOutputEdges("\n\na\nb")).toBe("a\nb");
  });

  it("PRESERVES interior blank lines — they are part of the output's shape", () => {
    expect(trimOutputEdges("a\n\nb\n")).toBe("a\n\nb");
  });

  it("preserves leading indentation on a content line", () => {
    expect(trimOutputEdges("\n   c48e3fd..5965a32  main -> main\n")).toBe(
      "   c48e3fd..5965a32  main -> main",
    );
  });

  it("handles CRLF and all-blank / empty input", () => {
    expect(trimOutputEdges("a\r\n\r\n")).toBe("a");
    expect(trimOutputEdges("\n\n")).toBe("");
    expect(trimOutputEdges("")).toBe("");
  });
});

describe("resolveToolOutput", () => {
  it("returns the final output when status is completed", () => {
    expect(
      resolveToolOutput({ output: "done-line-1\ndone-line-2" }),
    ).toBe("done-line-1\ndone-line-2");
  });

  it("falls back to metadata.output while running (no output field)", () => {
    expect(
      resolveToolOutput({ metadata: { output: "line-1\nline-2\n" } }),
    ).toBe("line-1\nline-2\n");
  });

  it("prefers final output over metadata.output once both exist", () => {
    // On completion opencode sets both; the final string is canonical.
    expect(
      resolveToolOutput({
        output: "final",
        metadata: { output: "partial" },
      }),
    ).toBe("final");
  });

  it("treats an empty-string output as absent and uses metadata.output", () => {
    // Running parts can carry output:"" briefly; don't render a blank body
    // when live progress is available.
    expect(
      resolveToolOutput({ output: "", metadata: { output: "tick-1\n" } }),
    ).toBe("tick-1\n");
  });

  it("returns '' when neither output nor metadata.output is present", () => {
    expect(resolveToolOutput({})).toBe("");
    expect(resolveToolOutput({ metadata: {} })).toBe("");
  });

  it("ignores non-string metadata.output", () => {
    expect(
      resolveToolOutput({ metadata: { output: 42 as unknown as string } }),
    ).toBe("");
  });

  it("never throws on null/undefined state", () => {
    expect(resolveToolOutput(null)).toBe("");
    expect(resolveToolOutput(undefined)).toBe("");
  });
});

// ===== reconcileOptimisticUser =====

describe("reconcileOptimisticUser", () => {
  type Msg = { info: { id: string; role: string; time?: { created?: number } } };

  const userMsg = (id: string, text?: string): Msg => ({
    info: { id, role: "user", time: text ? { created: 1000 } : undefined },
  });
  const assistantMsg = (id: string): Msg => ({
    info: { id, role: "assistant", time: { created: 500 } },
  });

  it("returns prev unchanged when incoming is not a user message", () => {
    const prev: Msg[] = [
      userMsg("optimistic-user-1"),
      assistantMsg("msg_1"),
    ];
    const incoming: Msg = {
      info: { id: "msg_assistant_real", role: "assistant", time: { created: 2000 } },
    };
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });

  it("returns prev unchanged when there is no optimistic entry", () => {
    const prev: Msg[] = [assistantMsg("msg_1"), userMsg("msg_user_real")];
    const incoming: Msg = userMsg("msg_user_real_2");
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });

  it("drops optimistic-user-* entry when real user message arrives", () => {
    const optimistic = userMsg("optimistic-user-1234");
    const prev: Msg[] = [assistantMsg("msg_0"), optimistic];
    const incoming: Msg = userMsg("msg_real_user");
    const result = reconcileOptimisticUser(prev, incoming);
    expect(result).not.toBe(prev); // new reference
    expect(result).toHaveLength(1);
    expect(result![0].info.id).toBe("msg_0");
  });

  it("drops optimistic entry even when it is not the last message", () => {
    const optimistic = userMsg("optimistic-user-999");
    const prev: Msg[] = [optimistic, assistantMsg("msg_1")];
    const incoming: Msg = userMsg("msg_real_user");
    const result = reconcileOptimisticUser(prev, incoming);
    expect(result).toHaveLength(1);
    expect(result![0].info.id).toBe("msg_1");
  });

  it("handles null/undefined prev gracefully", () => {
    const incoming: Msg = userMsg("msg_real");
    expect(reconcileOptimisticUser(null, incoming)).toBeNull();
    expect(reconcileOptimisticUser(undefined, incoming)).toBeUndefined();
  });

  it("handles empty prev array", () => {
    const incoming: Msg = userMsg("msg_real");
    expect(reconcileOptimisticUser([], incoming)).toEqual([]);
  });

  it("returns prev unchanged when no optimistic entry exists (same reference)", () => {
    const prev: Msg[] = [assistantMsg("msg_0"), userMsg("msg_user_1")];
    const incoming: Msg = userMsg("msg_user_2");
    // No optimistic entries → should return the same reference.
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });

  it("is a no-op for assistant messages even with optimistic entries present", () => {
    const optimistic = userMsg("optimistic-user-1");
    const prev: Msg[] = [optimistic, assistantMsg("msg_0")];
    const incoming: Msg = assistantMsg("msg_real");
    // Assistant incoming → never reconciles, even if optimistic is present.
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });
});

// ===== shouldForceReconnect =====

describe("shouldForceReconnect", () => {
  const THRESHOLD = 45_000;

  it("returns true when connected and stale beyond the threshold", () => {
    const lastFrameAt = 0;
    const now = THRESHOLD + 1;
    expect(shouldForceReconnect("connected", lastFrameAt, now, THRESHOLD)).toBe(true);
  });

  it("returns false when connected and fresh (within the threshold)", () => {
    const lastFrameAt = 1000;
    const now = 1000 + THRESHOLD - 1;
    expect(shouldForceReconnect("connected", lastFrameAt, now, THRESHOLD)).toBe(false);
  });

  it("returns false exactly at the threshold boundary (strictly greater-than)", () => {
    const lastFrameAt = 0;
    expect(shouldForceReconnect("connected", lastFrameAt, THRESHOLD, THRESHOLD)).toBe(false);
  });

  it("returns false when not connected, no matter how stale", () => {
    const now = 1_000_000;
    expect(shouldForceReconnect("connecting", 0, now, THRESHOLD)).toBe(false);
    expect(shouldForceReconnect("reconnecting", 0, now, THRESHOLD)).toBe(false);
    expect(shouldForceReconnect("stalled", 0, now, THRESHOLD)).toBe(false);
    expect(shouldForceReconnect("closed", 0, now, THRESHOLD)).toBe(false);
    expect(shouldForceReconnect("idle", 0, now, THRESHOLD)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(shouldForceReconnect("connected", 0, 100, 50)).toBe(true);
    expect(shouldForceReconnect("connected", 0, 40, 50)).toBe(false);
  });
});

// ===== shouldReconnectOnAppStateChange =====

describe("shouldReconnectOnAppStateChange", () => {
  it("returns true on resume (isActive=true) so the resume-watchdog fires", () => {
    expect(shouldReconnectOnAppStateChange(true)).toBe(true);
  });

  it("returns false on suspend (isActive=false) — OS is about to kill the socket", () => {
    expect(shouldReconnectOnAppStateChange(false)).toBe(false);
  });

  it("treats truthy non-true values as not-resume (defensive)", () => {
    // iOS always sends a real boolean, but defend against future API drift.
    expect(shouldReconnectOnAppStateChange(1 as unknown as boolean)).toBe(false);
    expect(shouldReconnectOnAppStateChange("yes" as unknown as boolean)).toBe(false);
    expect(shouldReconnectOnAppStateChange(null as unknown as boolean)).toBe(false);
    expect(shouldReconnectOnAppStateChange(undefined as unknown as boolean)).toBe(false);
  });
});

// ===== runWithConcurrency =====

describe("runWithConcurrency", () => {
  it("runs every item exactly once and resolves after all complete", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const seen: number[] = [];
    await runWithConcurrency(items, 3, async (item) => {
      await Promise.resolve();
      seen.push(item);
    });
    expect(seen.length).toBe(items.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency limit", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxObserved = 0;
    const limit = 4;
    await runWithConcurrency(items, limit, async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      // Yield a couple of microtask turns so overlapping workers have a
      // chance to race, rather than resolving synchronously.
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
    });
    expect(maxObserved).toBeLessThanOrEqual(limit);
    expect(maxObserved).toBeGreaterThan(0);
  });

  it("isolates a per-item rejection — one failure doesn't abort the batch", async () => {
    const items = [1, 2, 3, 4, 5];
    const completed: number[] = [];
    await expect(
      runWithConcurrency(items, 2, async (item) => {
        if (item === 3) throw new Error("boom");
        completed.push(item);
      }),
    ).resolves.toBeUndefined();
    expect(completed.sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
  });

  it("handles an empty items array", async () => {
    await expect(runWithConcurrency([], 4, async () => {})).resolves.toBeUndefined();
  });

  it("handles limit larger than items length", async () => {
    const items = [1, 2];
    const seen: number[] = [];
    await runWithConcurrency(items, 10, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });
});

describe("chooseUpdateSkewVariant", () => {
  // Version-skew guard (BET-225 stage 3 Part C): the renderer reads its own
  // client version (`getClientVersion()`) + the server's `minClient`
  // (from `getServerVersion()`), then asks this helper which variant of
  // the shared UpdateBar to render. Two-variant contract:
  //   - "ok"       → no banner (or the normal auto-update / server-update
  //                  banners if those are independently triggered)
  //   - "outdated" → non-dismissible "this app is out of date" banner
  //
  // The semver compare itself is already covered by versionCompare.test.ts
  // (BET-225.A); this test pins the renderer-side two-variant state
  // machine that drives UpdateBar's `dismissible` + `onAction` props.

  it("returns 'outdated' when the client version is strictly older than minClient", () => {
    expect(chooseUpdateSkewVariant("0.0.1", "0.0.2")).toBe("outdated");
    expect(chooseUpdateSkewVariant("1.0.0", "2.0.0")).toBe("outdated");
    expect(chooseUpdateSkewVariant("0.0.0", "1.0.0")).toBe("outdated");
  });

  it("returns 'ok' when the client version equals or exceeds minClient", () => {
    expect(chooseUpdateSkewVariant("0.0.2", "0.0.2")).toBe("ok");
    expect(chooseUpdateSkewVariant("1.0.0", "0.9.9")).toBe("ok");
    expect(chooseUpdateSkewVariant("2.0.0", "1.0.0")).toBe("ok");
  });

  it("returns 'ok' when the client version equals minClient exactly (no skew signal)", () => {
    // The boundary case: equal versions are NOT outdated — the client is
    // exactly at the minimum. only isClientTooOld() (strictly less than)
    // matters here.
    expect(chooseUpdateSkewVariant("1.2.3", "1.2.3")).toBe("ok");
  });

  it("returns 'ok' for missing/empty clientVersion (mid-bootstrap never flashes the blocking banner)", () => {
    expect(chooseUpdateSkewVariant(null, "0.0.0")).toBe("ok");
    expect(chooseUpdateSkewVariant(undefined, "0.0.0")).toBe("ok");
    expect(chooseUpdateSkewVariant("", "0.0.0")).toBe("ok");
  });

  it("returns 'ok' for missing/empty minClient (server version fetch failed)", () => {
    expect(chooseUpdateSkewVariant("1.0.0", null)).toBe("ok");
    expect(chooseUpdateSkewVariant("1.0.0", undefined)).toBe("ok");
    expect(chooseUpdateSkewVariant("1.0.0", "")).toBe("ok");
  });

  it("treats malformed versions as 0.0.0 (delegates to isClientTooOld)", () => {
    // versionCompare's parseVersion collapses bad input to [0,0,0] — both
    // sides → 0.0.0 → no skew. This is the "first-line guard" behavior
    // documented in versionCompare.mjs.
    expect(chooseUpdateSkewVariant("abc", "0.0.0")).toBe("ok");
    expect(chooseUpdateSkewVariant("1.x.3", "0.0.0")).toBe("ok");
    // But once one side has a real version, the compare takes over.
    expect(chooseUpdateSkewVariant("abc", "0.0.1")).toBe("outdated");
  });
});

// ===== isTransientUpdateNetworkError =====
describe("isTransientUpdateNetworkError", () => {
  it("treats a browser connection-drop during a box upgrade as transient", () => {
    // A successful self-upgrade restarts manta-server before the RPC resolves,
    // so the fetch dies with a bare network error — NOT a real failure.
    expect(isTransientUpdateNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("Failed to fetch"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("The operation was aborted"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("Load failed"))).toBe(true);
  });

  it("does NOT treat a real server-reported early failure as transient", () => {
    // Genuine failures come back as structured strings from the RPC result,
    // not as connection errors — these must still raise the update-failed banner.
    expect(isTransientUpdateNetworkError(new Error("self-update: manifest fetch failed: https://mantaui.com/releases/"))).toBe(false);
    expect(isTransientUpdateNetworkError(new Error("self-update: manifest is malformed"))).toBe(false);
    expect(isTransientUpdateNetworkError(new Error("self-update: bad tarball — missing src/server/index.mjs"))).toBe(false);
    expect(isTransientUpdateNetworkError(new Error("spawn /abs/scripts/self-update.sh EACCES"))).toBe(false);
  });

  it("is tolerant of null/undefined and arbitrary input", () => {
    expect(isTransientUpdateNetworkError(null)).toBe(false);
    expect(isTransientUpdateNetworkError(undefined)).toBe(false);
    expect(isTransientUpdateNetworkError("")).toBe(false);
    expect(isTransientUpdateNetworkError(42)).toBe(false);
  });
});

// ===== arrow history predicates (BET-257) =====
//
// The composer's ArrowUp/ArrowDown need to decide: cycle prompt history, OR
// move the caret one visual row. The DOM layer (InputArea.caretRowInfo)
// measures whether the caret sits on the first or last VISUAL row (soft wrap
// means a single long line can occupy several rows), and these predicates
// translate the row info into "navigate history?" booleans. Pure + tested in
// isolation — the visual-row measurement is the only DOM-touching piece.

describe("arrow history predicates", () => {
  it("ArrowUp navigates history only on the first visual row", () => {
    expect(arrowUpNavigatesHistory({ atFirstRow: true, atLastRow: false })).toBe(true);
    expect(arrowUpNavigatesHistory({ atFirstRow: false, atLastRow: false })).toBe(false);
    expect(arrowUpNavigatesHistory({ atFirstRow: true, atLastRow: true })).toBe(true);
  });
  it("ArrowDown navigates history only on the last visual row", () => {
    expect(arrowDownNavigatesHistory({ atFirstRow: false, atLastRow: true })).toBe(true);
    expect(arrowDownNavigatesHistory({ atFirstRow: false, atLastRow: false })).toBe(false);
    expect(arrowDownNavigatesHistory({ atFirstRow: true, atLastRow: true })).toBe(true);
  });
});

// ===== parseDeviceCode (BET-312) =====
//
// Pulls the device code out of opencode's OAuth instructions string. The
// "code" anchor guards against prose like "the user has not entered a code"
// matching its own inline "code" — only a string that explicitly presents a
// device-code-shaped token after a "code" cue is treated as one.

describe("parseDeviceCode", () => {
  it("extracts the code from the real opencode instructions string", () => {
    expect(parseDeviceCode("Enter code: TOQR-BUA7Z")).toBe("TOQR-BUA7Z");
  });

  it("accepts the anchor in lower-case and as a word boundary", () => {
    expect(parseDeviceCode("enter code ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(parseDeviceCode("Visit the page and use code WXYZ-1234 to sign in")).toBe("WXYZ-1234");
  });

  it("returns null when the string has no recognisable code", () => {
    expect(parseDeviceCode("Some prose without a code")).toBeNull();
    expect(parseDeviceCode("Sign in to your account to continue")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(parseDeviceCode("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    // Defensive: a malformed payload from opencode should not crash the UI.
    // Cast to `unknown` so the type system allows the bad input through.
    expect(parseDeviceCode(undefined as unknown as string)).toBeNull();
    expect(parseDeviceCode(null as unknown as string)).toBeNull();
    expect(parseDeviceCode(42 as unknown as string)).toBeNull();
  });
});

// ===== deviceCodeFallback + formatRemaining (BET-421 §D) =====

describe("deviceCodeFallback", () => {
  it("returns null when a code parsed (caller shows the chip)", () => {
    expect(deviceCodeFallback("Enter code: TOQR-BUA7Z")).toBeNull();
  });
  it("points at the instructions when no code parses", () => {
    expect(deviceCodeFallback("Sign in to your account to continue")).toBe(
      "The code is in the message below — copy it from there.",
    );
  });
  it("returns null for empty instructions", () => {
    expect(deviceCodeFallback("")).toBeNull();
    expect(deviceCodeFallback("   ")).toBeNull();
  });
});

describe("formatRemaining", () => {
  it("formats the remaining minutes:seconds on a device-code poll", () => {
    // 5 min limit, 90s elapsed → 3:30 remaining.
    expect(formatRemaining(0, 90_000, 300_000)).toBe("3:30 remaining");
  });
  it("clamps at 0 when the deadline has passed", () => {
    expect(formatRemaining(0, 400_000, 300_000)).toBe("0:00 remaining");
  });
  it("is NaN-safe", () => {
    expect(formatRemaining(NaN, 0, 0)).toBe("0:00 remaining");
  });
  it("handles the full-limit case at start", () => {
    expect(formatRemaining(0, 0, 300_000)).toBe("5:00 remaining");
  });
});

describe("slugifyProviderId", () => {
  it("lowercases and hyphenates a name", () => {
    expect(slugifyProviderId("Groq")).toBe("groq");
    expect(slugifyProviderId("My Cool API")).toBe("my-cool-api");
    expect(slugifyProviderId("VoskaAI v2")).toBe("voskaai-v2");
  });
  it("drops non-ASCII and collapses runs of non-alphanumerics", () => {
    expect(slugifyProviderId("Élan API!")).toBe("lan-api");
    expect(slugifyProviderId("a---b")).toBe("a-b");
  });
  it("returns empty string for blank input", () => {
    expect(slugifyProviderId("")).toBe("");
    expect(slugifyProviderId("   ")).toBe("");
    expect(slugifyProviderId("---")).toBe("");
  });
});

describe("customProviderDraftError", () => {
  const ok = (name: string, baseURL: string) =>
    customProviderDraftError({ name, baseURL });
  it("returns null for a valid name + http(s) baseURL", () => {
    expect(ok("VoskaAI", "https://api.voska.org/v1")).toBeNull();
    expect(ok("groq", "http://localhost:8080/v1")).toBeNull();
  });
  it("requires a name", () => {
    expect(ok("", "https://x/v1")).toBe("Name is required.");
    expect(ok("   ", "https://x/v1")).toBe("Name is required.");
  });
  it("rejects a name that slugifies to empty (no ASCII alphanumerics)", () => {
    expect(ok("É---!", "https://x/v1")).toBe(
      "Name must contain a letter or digit.",
    );
  });
  it("requires a baseURL with an http(s) scheme", () => {
    expect(ok("groq", "")).toBe("Base URL is required.");
    expect(ok("groq", "api.groq.com/v1")).toBe(
      "Base URL must start with http:// or https://.",
    );
    expect(ok("groq", "ftp://x/v1")).toBe(
      "Base URL must start with http:// or https://.",
    );
  });
});

// ===== connectPhaseLabel (BET-312) =====
//
// Single source of user-facing status text. The exhaustive switch in
// connectPhaseLabel lets TypeScript flag any missed variant; the test pins
// the labels so a copy change forces an explicit decision.

describe("connectPhaseLabel", () => {
  it("labels every phase distinctively", () => {
    expect(connectPhaseLabel({ kind: "starting" })).toBe("Connecting…");
    expect(
      connectPhaseLabel({ kind: "waiting", url: "u", instructions: "i", methodIndex: 0 }),
    ).toBe("Waiting for sign-in");
    expect(connectPhaseLabel({ kind: "installingClaudeCli", ptySessionKey: "k", loginSessionKey: "l", startedAt: 0, cwd: "~" })).toBe("Installing the Claude CLI");
    expect(
      connectPhaseLabel({
        kind: "needsCode",
        url: "u",
        instructions: "i",
        methodIndex: 0,
      }),
    ).toBe("Enter the code");
    expect(connectPhaseLabel({ kind: "needsKey", consoleUrl: null })).toBe(
      "Enter your API key",
    );
    expect(
      connectPhaseLabel({
        kind: "needsClaudeLogin",
        ptySessionKey: "k",
        startedAt: 0,
        cwd: "~",
        url: "",
      }),
    ).toBe("Awaiting Claude sign-in");
    expect(connectPhaseLabel({ kind: "applying", restartConfirmed: true })).toBe(
      "Applying…",
    );
    expect(connectPhaseLabel({ kind: "done" })).toBe("Connected");
    expect(connectPhaseLabel({ kind: "failed", message: "x" })).toBe("Failed");
  });

  // BET-354: the claude-login phase distinguishes "waiting" from
  // "already signed in" via the `preExisting` flag — the label flips so
  // the user can tell why nothing is happening.
  it("labels needsClaudeLogin 'Already signed in' when preExisting is true", () => {
    expect(
      connectPhaseLabel({
        kind: "needsClaudeLogin",
        ptySessionKey: "k",
        startedAt: 0,
        cwd: "~",
        url: "",
        preExisting: true,
      }),
    ).toBe("Already signed in");
  });
});

// ===== isPollExpired (BET-312) =====
//
// Shared by the 5-minute device-code poll and the 30-second restart poll.
// The deadline is a strict ">=" so the polling code can check on every tick
// without worrying about a one-frame over-shoot.

describe("isPollExpired", () => {
  it("is false before the deadline", () => {
    expect(isPollExpired(1000, 1000 + 1, 5000)).toBe(false);
    expect(isPollExpired(1000, 1000 + 4999, 5000)).toBe(false);
  });

  it("is true at and past the deadline", () => {
    expect(isPollExpired(1000, 1000 + 5000, 5000)).toBe(true);
    expect(isPollExpired(1000, 1000 + 9999, 5000)).toBe(true);
  });

  it("matches the two call sites the issue calls out (5-min device poll, 30-s restart poll)", () => {
    const start = 0;
    // Device poll: 5 min = 300_000 ms. Right at the cap = expired.
    expect(isPollExpired(start, start + 5 * 60 * 1000, 5 * 60 * 1000)).toBe(true);
    // Restart poll: 30 s = 30_000 ms. Just under = not expired.
    expect(isPollExpired(start, start + 29_999, 30_000)).toBe(false);
  });

  it("returns false for non-finite inputs (defensive against bad clocks)", () => {
    expect(isPollExpired(NaN, 1000, 5000)).toBe(false);
    expect(isPollExpired(1000, NaN, 5000)).toBe(false);
    expect(isPollExpired(1000, 1000, NaN)).toBe(false);
  });
});

// ===== describeSubscriptionStatus (BET-314) =====
//
// SubscriptionsCard renders "connected" / "not connected" next to each row.
// The string is the entire UX (no badge, no chip), so a future copy tweak
// should land here, not inline in the JSX. Two tests, both exhaustive over
// the boolean — anything else (a third value, mixed casing) is a regression.

describe("describeSubscriptionStatus", () => {
  it("returns 'connected' when status.connected is true", () => {
    expect(
      describeSubscriptionStatus({
        id: "anthropic",
        label: "Claude",
        plan: "Claude Pro / Max",
        console: null,
        docs: "https://claude.com/pricing",
        connected: true,
      }),
    ).toBe("connected");
  });

  it("returns 'not connected' when status.connected is false", () => {
    expect(
      describeSubscriptionStatus({
        id: "openai",
        label: "Codex",
        plan: "ChatGPT Plus / Pro",
        console: null,
        docs: "https://openai.com/chatgpt/pricing",
        connected: false,
      }),
    ).toBe("not connected");
  });
});

// ===== terminalShortcut (BET-333) =====
//
// Pure matcher behind Terminal.tsx's keydown handler. macOS triggers off Cmd
// alone; every other platform triggers off Ctrl+Shift. The upper-case trap:
// when Shift is held, browsers report `ev.key` as the shifted form ("C"), so
// the switch must lowercase before comparing.

const NO_MODS = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("terminalShortcut", () => {
  describe("macOS (isMac: true)", () => {
    it("maps Cmd+C → copy", () => {
      expect(
        terminalShortcut({ key: "c", ...NO_MODS, metaKey: true }, true),
      ).toBe("copy");
    });

    it("maps Cmd+V → paste", () => {
      expect(
        terminalShortcut({ key: "v", ...NO_MODS, metaKey: true }, true),
      ).toBe("paste");
    });

    it("maps Cmd+F → find", () => {
      expect(
        terminalShortcut({ key: "f", ...NO_MODS, metaKey: true }, true),
      ).toBe("find");
    });

    it("maps Cmd+K → clear", () => {
      expect(
        terminalShortcut({ key: "k", ...NO_MODS, metaKey: true }, true),
      ).toBe("clear");
    });

    it("plain Ctrl+C → null (Mac user's Ctrl+C must reach the process)", () => {
      expect(
        terminalShortcut({ key: "c", ...NO_MODS, ctrlKey: true }, true),
      ).toBeNull();
    });

    it("Cmd+Shift+K → null (Cmd+Shift combos are not our shortcuts)", () => {
      expect(
        terminalShortcut(
          { key: "K", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
          true,
        ),
      ).toBeNull();
    });
  });

  describe("non-macOS (isMac: false)", () => {
    it("Ctrl+Shift+C with key:'C' → copy (regression test for the uppercase trap)", () => {
      expect(
        terminalShortcut(
          { key: "C", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
          false,
        ),
      ).toBe("copy");
    });

    it("Ctrl+Shift+V → paste", () => {
      expect(
        terminalShortcut(
          { key: "V", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
          false,
        ),
      ).toBe("paste");
    });

    it("Ctrl+Shift+F → find", () => {
      expect(
        terminalShortcut(
          { key: "F", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
          false,
        ),
      ).toBe("find");
    });

    it("Ctrl+Shift+K → clear", () => {
      expect(
        terminalShortcut(
          { key: "K", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
          false,
        ),
      ).toBe("clear");
    });

    it("plain Ctrl+C → null (the actual bug being fixed)", () => {
      expect(
        terminalShortcut(
          { key: "c", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
          false,
        ),
      ).toBeNull();
    });

    it("plain Ctrl+K → null", () => {
      expect(
        terminalShortcut(
          { key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
          false,
        ),
      ).toBeNull();
    });

    it("plain Ctrl+F → null", () => {
      expect(
        terminalShortcut(
          { key: "f", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
          false,
        ),
      ).toBeNull();
    });

    it("plain Ctrl+V → null", () => {
      expect(
        terminalShortcut(
          { key: "v", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
          false,
        ),
      ).toBeNull();
    });

    it("Cmd+C → null (some keyboards send Meta instead of Ctrl on Win/Linux)", () => {
      expect(
        terminalShortcut(
          { key: "c", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
          false,
        ),
      ).toBeNull();
    });

    it("Ctrl+Shift+Alt+C → null (alt modifier disqualifies the trigger)", () => {
      expect(
        terminalShortcut(
          { key: "c", metaKey: false, ctrlKey: true, shiftKey: true, altKey: true },
          false,
        ),
      ).toBeNull();
    });
  });

  describe("trigger held with an unrelated key", () => {
    it("macOS Cmd+X → null", () => {
      expect(
        terminalShortcut(
          { key: "x", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
          true,
        ),
      ).toBeNull();
    });

    it("non-macOS Ctrl+Shift+X → null", () => {
      expect(
        terminalShortcut(
          { key: "x", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
          false,
        ),
      ).toBeNull();
    });
  });
});
// ===== authErrorAdvice (BET-316) =====
//
// Maps a `session.error` event to the reconnect-banner copy. The contract
// is: non-null only when the error is recognisably a credential failure on
// one of the three providers in the subscription registry. Anything else
// (context overflow, network blip, generic 5xx) returns null and falls
// through to the existing raw-message path — a wrong attribution is worse
// than no attribution.
//
// Tested cases (one assertion per scenario in the issue):
//   - Claude credential error  → anthropic + "Claude"
//   - Codex auth failure       → openai + "Codex"
//   - Kimi auth failure        → kimi-for-coding + "Kimi"
//   - Unrelated errors         → null (at least two negative cases — the
//                                 false-positive cases are the ones that
//                                 matter for this helper)

describe("authErrorAdvice", () => {
  it("attributes a Claude credential error to anthropic with label 'Claude'", () => {
    // The real upstream message — verified against the deployed opencode
    // build (see BET-280 / claudeAuth.mjs comment). `ApiError` is the typed
    // name opencode normalizes to today; `ProviderAuthError` was the legacy
    // name pre-BET-280. Both paths must work.
    expect(
      authErrorAdvice(
        "ApiError",
        "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
        "anthropic",
      ),
    ).toEqual({ providerID: "anthropic", label: "Claude" });
    expect(
      authErrorAdvice("ProviderAuthError", undefined, "anthropic"),
    ).toEqual({ providerID: "anthropic", label: "Claude" });
  });

  it("attributes a Codex auth failure to openai with label 'Codex'", () => {
    expect(
      authErrorAdvice("ApiError", "Authentication failed: invalid token", "openai"),
    ).toEqual({ providerID: "openai", label: "Codex" });
    expect(
      authErrorAdvice("ApiError", "Unauthorized: API key not valid", "openai"),
    ).toEqual({ providerID: "openai", label: "Codex" });
  });

  it("attributes a Kimi auth failure to kimi-for-coding with label 'Kimi'", () => {
    expect(
      authErrorAdvice(
        "ApiError",
        "API key expired — please renew in the console",
        "kimi-for-coding",
      ),
    ).toEqual({ providerID: "kimi-for-coding", label: "Kimi" });
    expect(
      authErrorAdvice("ApiError", "token expired", "kimi-for-coding"),
    ).toEqual({ providerID: "kimi-for-coding", label: "Kimi" });
  });

  it("returns null for an unrelated context-overflow error", () => {
    // ContextOverflowError / MessageOutputLengthError etc. are handled by
    // the existing switch in useSseBus.ts; authErrorAdvice must not steal
    // them. Both an explicit name + safe message and a default name +
    // credential-shaped message that lacks a known provider are tested.
    expect(
      authErrorAdvice("ContextOverflowError", "context window exceeded", "anthropic"),
    ).toBeNull();
    // Same credentials-shaped message but for an unrelated provider — must
    // NOT promote to a banner; the user is on something the registry does
    // not own, so we cannot reliably attribute.
    expect(
      authErrorAdvice("ApiError", "credentials expired", "some-other-provider"),
    ).toBeNull();
  });

  it("returns null for an unrelated tool / network error", () => {
    expect(
      authErrorAdvice("ApiError", "rate limit exceeded", "anthropic"),
    ).toBeNull();
    expect(authErrorAdvice("ApiError", "internal server error", "openai")).toBeNull();
    // Network-style errors carry no auth tokens and are not ApiError.
    expect(authErrorAdvice(undefined, "Network request failed", "anthropic")).toBeNull();
    expect(authErrorAdvice(undefined, "ECONNRESET", "anthropic")).toBeNull();
  });

  it("returns null when providerID is missing (no active model known)", () => {
    // Without a providerID we cannot attribute with confidence — fall
    // through to the raw-message path. Both null and undefined must be
    // tolerated (defensive against malformed event payloads).
    expect(
      authErrorAdvice("ApiError", "credentials expired", null),
    ).toBeNull();
    expect(
      authErrorAdvice("ApiError", "credentials expired", undefined),
    ).toBeNull();
    expect(authErrorAdvice("ApiError", "credentials expired", "")).toBeNull();
  });

  it("returns null for non-string / nullish inputs (defensive parsing)", () => {
    // Defensive: a malformed event from upstream must not crash the UI.
    // Cast through `unknown` so the type system allows the bad inputs.
    expect(
      authErrorAdvice(
        null as unknown as string,
        null as unknown as string,
        null as unknown as string,
      ),
    ).toBeNull();
    expect(
      authErrorAdvice(
        undefined as unknown as string,
        "credentials expired",
        "anthropic",
      ),
    ).toBeNull();
  });

  it("exposes a tight label registry (exactly the three providers)", () => {
    // Guards against a silent drift between this renderer-side table and
    // SUBSCRIPTION_PROVIDERS in src/server/subscriptionProviders.mjs. Both
    // files must agree on the three providers (anthropic / openai /
    // kimi-for-coding). Adding a fourth here is intentional and rare;
    // adding an unknown key (a typo) is the regression this catches.
    expect(Object.keys(AUTH_PROVIDER_LABELS).sort()).toEqual([
      "anthropic",
      "kimi-for-coding",
      "openai",
    ]);
    expect(AUTH_PROVIDER_LABELS.anthropic).toBe("Claude");
    expect(AUTH_PROVIDER_LABELS.openai).toBe("Codex");
    expect(AUTH_PROVIDER_LABELS["kimi-for-coding"]).toBe("Kimi");
  });
});

describe("isJobRow", () => {
  const jobs = {
    ses_a: { name: "fix-login", status: "running", activity: "editing auth.ts" },
    ses_b: { name: "add-tests", status: "done", activity: "" },
  };

  it("returns true when the window's opencodeSessionId is in the jobs map", () => {
    expect(isJobRow(jobs, "ses_a")).toBe(true);
    expect(isJobRow(jobs, "ses_b")).toBe(true);
  });

  it("returns false for an unrelated session id", () => {
    expect(isJobRow(jobs, "ses_other")).toBe(false);
  });

  it("returns false when opencodeSessionId is null (a claude-TUI window)", () => {
    expect(isJobRow(jobs, null)).toBe(false);
  });

  it("returns false when opencodeSessionId is undefined", () => {
    expect(isJobRow(jobs, undefined)).toBe(false);
  });

  it("returns false for an empty jobs map", () => {
    expect(isJobRow({}, "ses_a")).toBe(false);
  });
});

describe("formatJobSummary", () => {
  it("formats branch + files-changed count for a finished job with a worktree", () => {
    expect(
      formatJobSummary({ branch: "fix-login", filesChanged: 3, worktree: "/tmp/wt" }),
    ).toBe("fix-login · 3 files changed");
  });

  it("uses the singular 'file' for a single changed file", () => {
    expect(
      formatJobSummary({ branch: "fix-login", filesChanged: 1, worktree: "/tmp/wt" }),
    ).toBe("fix-login · 1 file changed");
  });

  it("omits the branch when there is no worktree (ran in the parent cwd)", () => {
    expect(formatJobSummary({ branch: null, filesChanged: 5, worktree: null })).toBe(
      "5 files changed",
    );
  });

  it("omits the branch when worktree is set but branch is null", () => {
    expect(formatJobSummary({ branch: null, filesChanged: 2, worktree: "/tmp/wt" })).toBe(
      "2 files changed",
    );
  });

  it("treats null filesChanged as 0", () => {
    expect(
      formatJobSummary({ branch: "fix-login", filesChanged: null, worktree: "/tmp/wt" }),
    ).toBe("fix-login · 0 files changed");
  });
});

// ===== parseModelRef (BET-801) =====

describe("parseModelRef", () => {
  it("splits a canonical providerID/modelID ref", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    });
  });

  it("splits on the FIRST slash only when the modelID contains a slash", () => {
    expect(parseModelRef("openai/gpt-4o/mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o/mini",
    });
  });

  it("returns null for absent or empty refs", () => {
    expect(parseModelRef(null)).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
    expect(parseModelRef("")).toBeNull();
  });

  it("returns null for a ref with no slash", () => {
    expect(parseModelRef("anthropic")).toBeNull();
  });

  it("returns null when either side is empty", () => {
    expect(parseModelRef("/claude")).toBeNull();
    expect(parseModelRef("anthropic/")).toBeNull();
  });

  it("returns null for a non-string (the legacy object shape on disk)", () => {
    expect(parseModelRef({ providerID: "anthropic", modelID: "claude" } as unknown as string)).toBeNull();
  });
});

// ===== isBackgroundJobCompletionTurn (BET-418 §C) =====

describe("isBackgroundJobCompletionTurn", () => {
  const userMsg = (text: string) => ({
    info: { role: "user", id: "m1" },
    parts: [{ type: "text", text, id: "p1" }],
  });

  it("matches a user turn whose first line is the job-completion marker", () => {
    expect(
      isBackgroundJobCompletionTurn(
        userMsg('[background job "fix-login" done]\nBranch: x (3 files changed)\n\nresult'),
      ),
    ).toBe(true);
  });

  it("matches a failed/stopped status marker", () => {
    expect(
      isBackgroundJobCompletionTurn(userMsg('[background job "x" failed]\n\nError: boom')),
    ).toBe(true);
    expect(
      isBackgroundJobCompletionTurn(userMsg('[background job "x" stopped]')),
    ).toBe(true);
  });

  it("ignores leading whitespace before the marker", () => {
    expect(
      isBackgroundJobCompletionTurn(userMsg('  \n[background job "x" done]\nrest')),
    ).toBe(true);
  });

  it("does not match a genuine user message that merely mentions background jobs", () => {
    expect(
      isBackgroundJobCompletionTurn(userMsg("can you start a background job to run tests?")),
    ).toBe(false);
    expect(
      isBackgroundJobCompletionTurn(userMsg('background job "x" finished')), // no brackets
    ).toBe(false);
  });

  it("returns false for an assistant message even if its text is the marker", () => {
    expect(
      isBackgroundJobCompletionTurn({
        info: { role: "assistant", id: "m2" },
        parts: [{ type: "text", text: '[background job "x" done]', id: "p1" }],
      }),
    ).toBe(false);
  });

  it("ignores synthetic/ignored text parts (only counts real user text)", () => {
    expect(
      isBackgroundJobCompletionTurn({
        info: { role: "user", id: "m1" },
        parts: [{ type: "text", text: '[background job "x" done]', synthetic: true, id: "p1" }],
      }),
    ).toBe(false);
  });
});

// ===== BET-414 sidebar helpers =====

import type { Project, PermissionRequest } from "../shared/types";

function mkProject(
  tmuxSession: string,
  windows: Array<{ index: number; name: string; opencodeSessionId?: string | null }>,
): Project {
  return {
    tmuxSession,
    defaultCwd: "~",
    windows: windows.map((w) => ({
      index: w.index,
      name: w.name,
      active: false,
      paneCurrentPath: "",
      opencodeSessionId: w.opencodeSessionId ?? null,
    })),
  } as Project;
}

describe("windowPinId / parsePinId / resolvePin", () => {
  it("round-trips a tmuxSession/windowIndex pair", () => {
    const id = windowPinId("better-ui", 3);
    expect(id).toBe("better-ui/3");
    expect(parsePinId(id)).toEqual({ tmuxSession: "better-ui", windowIndex: 3 });
  });

  it("rejects malformed pin ids", () => {
    expect(parsePinId("nodash")).toBeNull();
    expect(parsePinId("/leading")).toBeNull();
    expect(parsePinId("trailing/")).toBeNull();
    // Last slash wins; the last segment must be numeric. "a/b/3" → session "a/b".
    expect(parsePinId("a/b/3")).toEqual({ tmuxSession: "a/b", windowIndex: 3 });
    expect(parsePinId("a/b/c")).toBeNull();
    expect(parsePinId("proj/notanumber")).toBeNull();
    expect(parsePinId("proj/-1")).toBeNull();
  });

  it("resolves a live window and prunes stale ones", () => {
    const projects = [mkProject("p", [{ index: 2, name: "w2" }])];
    expect(resolvePin(projects, "p/2")?.window.index).toBe(2);
    expect(resolvePin(projects, "p/9")).toBeNull();
    expect(resolvePin(projects, "missing/2")).toBeNull();
  });
});

describe("fuzzySessionScore", () => {
  it("matches everything with score 1 on empty query", () => {
    expect(fuzzySessionScore("", "auth", "better-ui")).toBe(1);
  });

  it("ranks contiguous substring matches above subsequence matches", () => {
    const contig = fuzzySessionScore("auth", "auth-service", "better-ui");
    const subseq = fuzzySessionScore("auh", "auth-service", "better-ui");
    expect(contig).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it("ranks earlier substring matches higher", () => {
    const early = fuzzySessionScore("log", "login", "a");
    const late = fuzzySessionScore("log", "analog", "a");
    expect(early).toBeGreaterThan(late);
  });

  it("matches across session + workspace boundary (subsequence)", () => {
    // query "authbu" → "auth" from session, "bu" from workspace "bu-foo".
    expect(fuzzySessionScore("authbu", "auth", "bu-foo")).toBeGreaterThan(0);
  });

  it("returns 0 when the query is not a subsequence", () => {
    expect(fuzzySessionScore("xyz", "auth", "better-ui")).toBe(0);
    expect(fuzzySessionScore("auth", "thau", "")).toBe(0); // order matters
  });

  it("is case-insensitive", () => {
    expect(fuzzySessionScore("AUTH", "auth-service", "BETTER-UI")).toBeGreaterThan(0);
  });
});

describe("shouldResyncWindowsForJobs", () => {
  // THE REGRESSION THIS LOCKS IN: a delegated job creates its tmux window on
  // the box, so the renderer's window tree — only re-listed at bootstrap and
  // after the app's own actions — never contains it. computeJobNesting then
  // drops the job (`if (!childWin) continue`) and it renders NOWHERE, while
  // the jobs slice happily holds it. The sidebar looked like it ignored
  // background jobs entirely.
  it("running job whose window is NOT in the tree → resync (the invisible-job bug)", () => {
    const projects = [mkProject("p", [{ index: 1, name: "parent", opencodeSessionId: "parent" }])];
    const jobs = { child1: { status: "running", childSessionID: "child1" } };
    expect(shouldResyncWindowsForJobs(projects, jobs)).toBe(true);
  });

  it("documents WHY it matters: nesting renders a window-less job NOWHERE", () => {
    // Not nested, not orphaned, not top-level — computeJobNesting's
    // `if (!childWin) continue` drops it silently. This is the state the
    // sidebar was permanently in for every delegated job.
    const projects = [mkProject("p", [{ index: 1, name: "parent", opencodeSessionId: "parent" }])];
    const nesting = computeJobNesting(
      projects[0],
      { child1: { status: "running", parentSessionID: "parent", childSessionID: "child1" } },
    );
    expect(nesting.hidden.size).toBe(0);
    expect(nesting.children.size).toBe(0);
    // …which is exactly the condition the predicate flags for a re-list.
    expect(
      shouldResyncWindowsForJobs(projects, {
        child1: { status: "running", childSessionID: "child1" },
      }),
    ).toBe(true);
  });

  it("running job whose window IS in the tree → no resync", () => {
    const projects = [
      mkProject("p", [
        { index: 1, name: "parent", opencodeSessionId: "parent" },
        { index: 2, name: "job", opencodeSessionId: "child1" },
      ]),
    ];
    const jobs = { child1: { status: "running", childSessionID: "child1" } };
    expect(shouldResyncWindowsForJobs(projects, jobs)).toBe(false);
  });

  it("finished job whose window is STILL in the tree → resync (stale window would linger)", () => {
    const projects = [
      mkProject("p", [
        { index: 1, name: "parent", opencodeSessionId: "parent" },
        { index: 2, name: "job", opencodeSessionId: "child1" },
      ]),
    ];
    const jobs = { child1: { status: "done", childSessionID: "child1" } };
    expect(shouldResyncWindowsForJobs(projects, jobs)).toBe(true);
  });

  it("finished job already cleaned up → no resync (steady state, no tmux call)", () => {
    const projects = [mkProject("p", [{ index: 1, name: "parent", opencodeSessionId: "parent" }])];
    const jobs = { child1: { status: "done", childSessionID: "child1" } };
    expect(shouldResyncWindowsForJobs(projects, jobs)).toBe(false);
  });

  it("no jobs → no resync", () => {
    const projects = [mkProject("p", [{ index: 1, name: "parent", opencodeSessionId: "parent" }])];
    expect(shouldResyncWindowsForJobs(projects, {})).toBe(false);
  });

  it("job with no childSessionID is ignored (mid-start record)", () => {
    const projects = [mkProject("p", [{ index: 1, name: "parent", opencodeSessionId: "parent" }])];
    const jobs = { x: { status: "running", childSessionID: null } };
    expect(shouldResyncWindowsForJobs(projects, jobs)).toBe(false);
  });

  it("finds a job window in ANY project, not just the parent's", () => {
    const projects = [
      mkProject("a", [{ index: 1, name: "parent", opencodeSessionId: "parent" }]),
      mkProject("b", [{ index: 1, name: "job", opencodeSessionId: "child1" }]),
    ];
    const jobs = { child1: { status: "running", childSessionID: "child1" } };
    expect(shouldResyncWindowsForJobs(projects, jobs)).toBe(false);
  });
});

describe("computeJobNesting", () => {
  const jobs = {
    child1: { status: "running", parentSessionID: "parent", childSessionID: "child1" },
    child2: { status: "running", parentSessionID: "parent", childSessionID: "child2" },
    doneJob: { status: "done", parentSessionID: "parent", childSessionID: "doneChild" },
    orphanJob: { status: "running", parentSessionID: "goneParent", childSessionID: "orphanChild" },
  };

  it("nests running job children under their parent window and hides them from top level", () => {
    const project = mkProject("p", [
      { index: 0, name: "parent", opencodeSessionId: "parent" },
      { index: 1, name: "job1", opencodeSessionId: "child1" },
      { index: 2, name: "job2", opencodeSessionId: "child2" },
    ]);
    const res = computeJobNesting(project, jobs);
    expect([...res.hidden]).toEqual([1, 2]);
    expect(res.children.get(0)).toEqual([1, 2]);
  });

  it("a terminal job stays nested — selection is not an input", () => {
    const project = mkProject("p", [
      { index: 0, name: "parent", opencodeSessionId: "parent" },
      { index: 3, name: "done", opencodeSessionId: "doneChild" },
    ]);
    // Terminal job whose parent window exists is nested regardless of which
    // window is selected — selection is no longer a parameter, so calling the
    // function twice yields byte-identical results.
    const a = computeJobNesting(project, jobs);
    const b = computeJobNesting(project, jobs);
    expect(a.hidden.has(3)).toBe(true);
    expect(a.children.get(0)).toEqual([3]);
    expect(b.hidden.has(3)).toBe(true);
    expect(b.children.get(0)).toEqual([3]);
    expect([...a.hidden]).toEqual([...b.hidden]);
    expect([...a.children]).toEqual([...b.children]);
  });

  it("renders a job at top level when its parent window is gone", () => {
    const project = mkProject("p", [
      { index: 5, name: "orphan", opencodeSessionId: "orphanChild" },
    ]);
    const res = computeJobNesting(project, jobs);
    expect(res.hidden.has(5)).toBe(false);
  });

  it("ignores jobs whose child window is not in this project", () => {
    const project = mkProject("p", [{ index: 0, name: "parent", opencodeSessionId: "parent" }]);
    const res = computeJobNesting(project, jobs);
    expect(res.hidden.size).toBe(0);
    expect(res.children.size).toBe(0);
  });
});

// ===== globCovers / isApprovalCoveredByAlways (BET-418 §A5) =====

describe("globCovers", () => {
  it("covers equal patterns", () => {
    expect(globCovers("alembic upgrade head", "alembic upgrade head")).toBe(true);
    expect(globCovers("pytest *", "pytest *")).toBe(true);
  });

  it("covers when always is a bare star (matches everything)", () => {
    expect(globCovers("*", "anything")).toBe(true);
    expect(globCovers("*", "pytest tests/")).toBe(true);
  });

  it("covers when always ends with star and pattern starts with the prefix", () => {
    expect(globCovers("alembic upgrade *", "alembic upgrade head")).toBe(true);
    expect(globCovers("pytest *", "pytest tests/")).toBe(true);
    expect(globCovers("git *", "git commit -m")).toBe(true);
  });

  it("covers a narrower glob (pattern also ends with star, longer prefix)", () => {
    expect(globCovers("alembic upgrade *", "alembic upgrade head *")).toBe(true);
    expect(globCovers("git *", "git push *")).toBe(true);
  });

  it("does not cover when prefix differs", () => {
    expect(globCovers("alembic upgrade *", "pytest tests/")).toBe(false);
    expect(globCovers("git *", "hg commit")).toBe(false);
  });

  it("does not cover when always has no star and patterns differ", () => {
    expect(globCovers("alembic upgrade head", "alembic upgrade downgrade")).toBe(false);
  });

  it("is conservative with complex globs (does not parse ** patterns)", () => {
    expect(globCovers("**/*.ts", "src/foo.ts")).toBe(false);
    expect(globCovers("**/*.ts", "**/*.ts")).toBe(true);
  });
});

describe("isApprovalCoveredByAlways", () => {
  const mkPerm = (
    permission: string,
    always: string[],
  ): PermissionRequest => ({
    id: `id-${permission}`,
    sessionID: "ses",
    permission,
    always,
  });

  it("returns false when approval has no tools", () => {
    expect(isApprovalCoveredByAlways({ tools: [] }, [mkPerm("bash", ["*"])])).toBe(false);
  });

  it("returns false when there are no permissions", () => {
    const approval = { tools: [{ permission: "bash", pattern: "pytest *" }] };
    expect(isApprovalCoveredByAlways(approval, [])).toBe(false);
  });

  it("returns false when no permission matches the tool category", () => {
    const approval = { tools: [{ permission: "bash", pattern: "pytest *" }] };
    const perms = [mkPerm("write", ["/tmp/*"])];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(false);
  });

  it("returns true when a single tool is covered by a matching always grant", () => {
    const approval = { tools: [{ permission: "bash", pattern: "alembic upgrade head" }] };
    const perms = [mkPerm("bash", ["alembic upgrade *"])];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(true);
  });

  it("returns true when always is a bare star for the matching category", () => {
    const approval = { tools: [{ permission: "bash", pattern: "anything" }] };
    const perms = [mkPerm("bash", ["*"])];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(true);
  });

  it("returns true when all tools are covered (multi-tool)", () => {
    const approval = {
      tools: [
        { permission: "bash", pattern: "pytest tests/" },
        { permission: "write", pattern: "/tmp/out.txt" },
      ],
    };
    const perms = [
      mkPerm("bash", ["pytest *"]),
      mkPerm("write", ["/tmp/*"]),
    ];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(true);
  });

  it("returns false when one of multiple tools is not covered", () => {
    const approval = {
      tools: [
        { permission: "bash", pattern: "pytest tests/" },
        { permission: "write", pattern: "/etc/passwd" },
      ],
    };
    const perms = [
      mkPerm("bash", ["pytest *"]),
      mkPerm("write", ["/tmp/*"]),
    ];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(false);
  });

  it("aggregates always[] across multiple PermissionRequests of the same category", () => {
    const approval = { tools: [{ permission: "bash", pattern: "git push" }] };
    const perms = [
      mkPerm("bash", ["pytest *"]),
      mkPerm("bash", ["git *"]),
    ];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(true);
  });

  it("ignores PermissionRequests with empty always[]", () => {
    const approval = { tools: [{ permission: "bash", pattern: "pytest *" }] };
    const perms = [mkPerm("bash", [])];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(false);
  });

  it("ignores PermissionRequests with undefined always", () => {
    const approval = { tools: [{ permission: "bash", pattern: "pytest *" }] };
    const perms: PermissionRequest[] = [
      { id: "p1", sessionID: "ses", permission: "bash" },
    ];
    expect(isApprovalCoveredByAlways(approval, perms)).toBe(false);
  });
});

// ===== shortModelName (BET-460) =====

describe("shortModelName", () => {
  it("strips a known leading vendor brand from the display name", () => {
    expect(shortModelName("Claude Opus 4.7")).toBe("Opus 4.7");
    expect(shortModelName("Claude Sonnet 4.6")).toBe("Sonnet 4.6");
    expect(shortModelName("Gemini 2.5 Pro")).toBe("2.5 Pro");
  });

  it("passes an unknown / brandless name through unchanged", () => {
    expect(shortModelName("GPT-4o")).toBe("GPT-4o");
    expect(shortModelName("DeepSeek R1")).toBe("R1");
  });

  it("handles blank and null input", () => {
    expect(shortModelName(null)).toBeNull();
    expect(shortModelName(undefined)).toBeNull();
    expect(shortModelName("   ")).toBeNull();
  });
});

// ===== Fast-mode sibling models (composer ⚡ toggle) =====

describe("fast-mode model helpers", () => {
  const M = (
    providerID: string,
    id: string,
    variants?: string[],
    extra: Partial<OpencodeModel> = {},
  ): OpencodeModel =>
    ({
      id,
      providerID,
      name: id,
      ...(variants ? { variants: variants.map((v) => ({ id: v })) } : {}),
      ...extra,
    }) as OpencodeModel;

  it("isFastModelId / baseModelId / fastModelId round-trip", () => {
    expect(isFastModelId("gpt-5.6-fast")).toBe(true);
    expect(isFastModelId("gpt-5.6")).toBe(false);
    // A bare "-fast" is not a fast flavour of anything.
    expect(isFastModelId("-fast")).toBe(false);
    expect(baseModelId("gpt-5.6-fast")).toBe("gpt-5.6");
    expect(baseModelId("gpt-5.6")).toBe("gpt-5.6");
    expect(fastModelId("gpt-5.6")).toBe("gpt-5.6-fast");
    expect(fastModelId("gpt-5.6-fast")).toBe("gpt-5.6-fast");
  });

  it("hideFastSiblingGroups drops a -fast model when its base is present", () => {
    const groups: Array<[string, OpencodeModel[]]> = [
      ["openai", [M("openai", "gpt-5.6"), M("openai", "gpt-5.6-fast"), M("openai", "gpt-5.4-mini")]],
    ];
    expect(hideFastSiblingGroups(groups)[0][1].map((m) => m.id)).toEqual([
      "gpt-5.6",
      "gpt-5.4-mini",
    ]);
  });

  it("hideFastSiblingGroups KEEPS an orphan -fast model (nothing else reaches it)", () => {
    const groups: Array<[string, OpencodeModel[]]> = [
      ["x", [M("x", "solo-fast")]],
    ];
    expect(hideFastSiblingGroups(groups)[0][1].map((m) => m.id)).toEqual(["solo-fast"]);
  });

  it("hideFastSiblingGroups drops a group left empty", () => {
    const groups: Array<[string, OpencodeModel[]]> = [
      ["a", [M("a", "m"), M("a", "m-fast")]],
      ["b", [M("b", "only-fast"), M("b", "only")]],
    ];
    const out = hideFastSiblingGroups(groups);
    expect(out.map(([p]) => p)).toEqual(["a", "b"]);
    expect(out[1][1].map((m) => m.id)).toEqual(["only"]);
  });

  it("resolveFastToggle: base model with a fast twin is available and off", () => {
    const models = [M("openai", "gpt-5.6", ["low", "high"]), M("openai", "gpt-5.6-fast", ["low", "high"])];
    const r = resolveFastToggle(models, models[0], "high");
    expect(r).toMatchObject({
      available: true,
      on: false,
      target: { providerID: "openai", modelID: "gpt-5.6-fast", variant: "high" },
    });
  });

  it("resolveFastToggle: fast model reports on and targets the base", () => {
    const models = [M("openai", "gpt-5.6", ["low"]), M("openai", "gpt-5.6-fast", ["low"])];
    const r = resolveFastToggle(models, models[1], "low");
    expect(r).toMatchObject({
      available: true,
      on: true,
      target: { providerID: "openai", modelID: "gpt-5.6", variant: "low" },
    });
  });

  it("resolveFastToggle: no variant selected → target carries no variant", () => {
    const models = [M("openai", "a"), M("openai", "a-fast")];
    expect(resolveFastToggle(models, models[0], undefined).target).toEqual({
      providerID: "openai",
      modelID: "a-fast",
    });
  });

  it("resolveFastToggle: disabled when the twin lacks the selected effort", () => {
    const models = [
      M("openai", "a", ["low", "max"]),
      M("openai", "a-fast", ["low"]),
    ];
    const r = resolveFastToggle(models, models[0], "max");
    expect(r.available).toBe(false);
    expect(r.target).toBeNull();
    expect(r.title).toContain("max");
  });

  it("resolveFastToggle: disabled when no twin exists at all", () => {
    const models = [M("openai", "solo", ["low"])];
    expect(resolveFastToggle(models, models[0], "low")).toMatchObject({
      available: false,
      on: false,
      target: null,
    });
  });

  it("resolveFastToggle: a twin in a DIFFERENT provider does not count", () => {
    const models = [M("openai", "a"), M("azure", "a-fast")];
    expect(resolveFastToggle(models, models[0], undefined).available).toBe(false);
  });

  it("resolveFastToggle: a deactivated/deprecated twin does not count", () => {
    const models = [
      M("openai", "a"),
      M("openai", "a-fast", undefined, { enabled: false }),
    ];
    expect(resolveFastToggle(models, models[0], undefined).available).toBe(false);
  });

  it("resolveFastToggle: fast model with no base still reports on, but not clickable", () => {
    const models = [M("openai", "orphan-fast")];
    expect(resolveFastToggle(models, models[0], undefined)).toMatchObject({
      available: false,
      on: true,
      target: null,
    });
  });

  it("resolveFastToggle: null model is off + unavailable", () => {
    expect(resolveFastToggle([], null, undefined)).toMatchObject({
      available: false,
      on: false,
    });
  });
});

// ===== Transcript entry motion =====
//
// The gate that decides which transcript rows animate their arrival. Every
// case below is a bug that shipped, not a hypothetical: the feature reached
// production animating exactly the wrong set (all of history, none of the new
// messages), so these tests pin both halves of the contract.

describe("updateEntryMotion", () => {
  const user = (id: string) => ({ id, role: "user" });
  const asst = (id: string) => ({ id, role: "assistant" });

  it("animates nothing on the first populated render — that is history", () => {
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1"), asst("a1"), user("u2")]);
    expect([...s.entering]).toEqual([]);
  });

  it("does not prime on an empty transcript, so a new session's first send still animates", () => {
    // The "Welcome" state renders with zero messages. If that primed the gate,
    // the very next message would be classified as pre-existing history and a
    // brand-new session would never animate anything.
    const s = createEntryMotionState();
    updateEntryMotion(s, []);
    expect(s.seen).toBeNull();
    updateEntryMotion(s, [user("u1")]);
    expect([...s.entering]).toEqual([]); // u1 IS the first populated render
  });

  it("animates a message appended after the initial load", () => {
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1"), asst("a1")]);
    updateEntryMotion(s, [user("u1"), asst("a1"), user("u2")]);
    expect([...s.entering]).toEqual(["u2"]);
  });

  it("KEEPS the flag across later renders — dropping it cancels the animation", () => {
    // A CSS animation is killed the moment its class is removed, and the
    // element snaps to its end state. The transcript re-renders every few ms
    // during a streaming turn, so a flag that lasted one render meant the
    // animation was destroyed about one frame in and never visibly played.
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]);
    updateEntryMotion(s, [user("u1"), asst("a1")]);
    expect(s.entering.has("a1")).toBe(true);
    for (let i = 0; i < 50; i++) updateEntryMotion(s, [user("u1"), asst("a1")]);
    expect(s.entering.has("a1")).toBe(true);
  });

  it("animates the optimistic placeholder a send appends", () => {
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1"), asst("a1")]);
    updateEntryMotion(s, [user("u1"), asst("a1"), user("optimistic-user-7")]);
    expect(s.entering.has("optimistic-user-7")).toBe(true);
  });

  it("does NOT replay the pop when the canonical message replaces the placeholder", () => {
    // The server's real message arrives under a different id, so React tears
    // the bubble down and mounts a new one. Without the handover that reads as
    // a second pop a few hundred ms after the first.
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]);
    updateEntryMotion(s, [user("u1"), user("optimistic-user-7")]);
    updateEntryMotion(s, [user("u1"), user("msg_real")]);
    expect(s.entering.has("msg_real")).toBe(false);
  });

  it("still animates the assistant reply that follows a placeholder handover", () => {
    // The handover must be spent on exactly one user row, never on the
    // assistant turn that arrives alongside it.
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]);
    updateEntryMotion(s, [user("u1"), user("optimistic-user-7")]);
    updateEntryMotion(s, [user("u1"), user("msg_real"), asst("a_new")]);
    expect(s.entering.has("msg_real")).toBe(false);
    expect(s.entering.has("a_new")).toBe(true);
  });

  it("a message id registered as reconciled-from-optimistic is NOT marked entering", () => {
    // BET-680 step 6: when useTranscriptState's reconcile swaps the optimistic
    // placeholder for the canonical server id, it registers the canonical id
    // via markReconciledFromOptimistic. updateEntryMotion consults the same
    // state and must not mark it entering — otherwise the bubble pops twice.
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]); // prime
    updateEntryMotion(s, [user("u1"), user("optimistic-user-9")]);
    expect(s.entering.has("optimistic-user-9")).toBe(true); // placeholder pops
    // The canonical id now replaces the placeholder and is registered.
    markReconciledFromOptimistic(s, "msg_real");
    expect(s.seen?.has("msg_real")).toBe(true);
    updateEntryMotion(s, [user("u1"), user("msg_real")]);
    expect(s.entering.has("msg_real")).toBe(false);
  });

  it("forgets ids that leave the transcript, so a cleared session stays bounded", () => {
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]);
    updateEntryMotion(s, [user("u1"), asst("a1")]);
    expect(s.entering.has("a1")).toBe(true);
    updateEntryMotion(s, [user("u1")]);
    expect(s.entering.has("a1")).toBe(false);
  });

  it("recognises the renderer's optimistic id prefix", () => {
    expect(isOptimisticUserId("optimistic-user-1770000000000")).toBe(true);
    expect(isOptimisticUserId("msg_01ABC")).toBe(false);
  });

  // A hidden panel (App.tsx hides inactive ChatPanels with display:none) folds
  // its new messages into `seen` as history but must NOT mark them entering —
  // CSS animations don't run on a display:none element, so the whole batch
  // would otherwise slide in at the instant the user switches to the session.
  it("with animate:false, a new id is folded into seen but NOT entering", () => {
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]); // prime
    updateEntryMotion(s, [user("u1"), asst("a1")], false);
    expect(s.entering.has("a1")).toBe(false);
    expect(s.seen?.has("a1")).toBe(true);
  });

  it("an id absorbed as history while inactive stays history when the panel becomes active", () => {
    // This is the whole point: a turn that landed while hidden must not slide
    // in on the switch. Re-folding the SAME id with animate:true does nothing
    // because it is already in `seen`.
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]); // prime
    updateEntryMotion(s, [user("u1"), asst("a1")], false); // hidden turn
    updateEntryMotion(s, [user("u1"), asst("a1")], true); // user switches in
    expect(s.entering.has("a1")).toBe(false);
  });

  it("a genuinely new id after an inactive batch IS marked entering", () => {
    const s = createEntryMotionState();
    updateEntryMotion(s, [user("u1")]); // prime
    updateEntryMotion(s, [user("u1"), asst("a1")], false); // absorbed as history
    updateEntryMotion(s, [user("u1"), asst("a1"), user("u2")], true); // live send
    expect(s.entering.has("a1")).toBe(false);
    expect(s.entering.has("u2")).toBe(true);
  });
});

describe("artifact preview type routing (BET-661)", () => {
  it("routes each mime family correctly", () => {
    expect(resolvePreviewType("image/png", "shot.png")).toBe("image");
    expect(resolvePreviewType("image/svg+xml", "icon.svg")).toBe("image");
    expect(resolvePreviewType("application/pdf", "guide.pdf")).toBe("pdf");
    expect(resolvePreviewType("text/plain", "notes.txt")).toBe("text");
    expect(resolvePreviewType("text/markdown", "README.md")).toBe("text");
    expect(resolvePreviewType("text/csv", "q3.csv")).toBe("refuse");
  });

  it("routes an unknown mime with a known extension to text", () => {
    expect(resolvePreviewType(null, "util.ts")).toBe("text");
    expect(resolvePreviewType(null, "script.sh")).toBe("text");
    // A source file mis-detected with a generic/octet-stream mime still previews.
    expect(resolvePreviewType("application/octet-stream", "main.tsx")).toBe("text");
  });

  it("refuses an unknown mime with an unknown extension", () => {
    expect(resolvePreviewType(null, "archive.zip")).toBe("refuse");
    expect(resolvePreviewType(null, "binary.bin")).toBe("refuse");
    // .csv with a null mime must refuse too (not in the allowlist).
    expect(resolvePreviewType(null, "data.csv")).toBe("refuse");
    expect(resolvePreviewType("application/octet-stream", "blob.xyz")).toBe("refuse");
  });

  it("routing is case-insensitive on extension and mime", () => {
    expect(resolvePreviewType(null, "LOG.txt")).toBe("text");
    expect(resolvePreviewType("IMAGE/PNG", "a.png")).toBe("image");
    expect(resolvePreviewType("Text/CSV", "a.csv")).toBe("refuse");
  });
});

describe("artifact preview size guard (BET-661)", () => {
  it("allows exactly MAX_PREVIEW_BYTES and refuses one byte more", () => {
    expect(isWithinPreviewSize(MAX_PREVIEW_BYTES)).toBe(true);
    expect(isWithinPreviewSize(MAX_PREVIEW_BYTES + 1)).toBe(false);
  });

  it("allows everything below the cap and refuses negatives/NaN", () => {
    expect(isWithinPreviewSize(0)).toBe(true);
    expect(isWithinPreviewSize(1024)).toBe(true);
    expect(isWithinPreviewSize(-1)).toBe(false);
    expect(isWithinPreviewSize(Number.NaN)).toBe(false);
  });

  it("MAX_PREVIEW_BYTES is 25 MiB", () => {
    expect(MAX_PREVIEW_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("artifact preview footer + metadata (BET-661)", () => {
  it("formats an image footer with dimensions, size and origin", () => {
    expect(formatPreviewFooter("image", { width: 2048, height: 1108, size: 1470480, origin: "user" })).toBe(
      "2048 × 1108 · 1.4 MB · you sent this",
    );
    expect(formatPreviewFooter("image", { width: 1200, height: 800, size: 500_000, origin: "agent" })).toBe(
      "1200 × 800 · 488 KB · generated",
    );
  });

  it("formats a pdf footer as the raw size", () => {
    expect(formatPreviewFooter("pdf", { size: 5_033_164 })).toBe("4.8 MB");
  });

  it("formats a text footer as lines · language", () => {
    expect(formatPreviewFooter("text", { lines: 12, language: "typescript" })).toBe("12 lines · typescript");
    expect(formatPreviewFooter("text", { lines: 0, language: "text" })).toBe("0 lines · text");
  });

  it("counts lines like CodeBlock (single trailing newline trimmed)", () => {
    expect(countPreviewLines("a\nb\nc")).toBe(3);
    expect(countPreviewLines("a\nb\nc\n")).toBe(3);
    expect(countPreviewLines("")).toBe(0);
  });

  it("derives a language label from the filename", () => {
    expect(previewLanguage("foo.ts")).toBe("typescript");
    expect(previewLanguage("Foo.tsx")).toBe("tsx");
    expect(previewLanguage("notes.md")).toBe("markdown");
    expect(previewLanguage("random.txt")).toBe("text");
    expect(previewLanguage("noext")).toBe("text");
  });

  it("origin word matches the file rows", () => {
    expect(previewOriginWord("user")).toBe("you sent this");
    expect(previewOriginWord("agent")).toBe("generated");
  });
});

describe("decodeDataUri", () => {
  it("decodes a base64 data URI into its mime + bytes", () => {
    const r = decodeDataUri("data:image/png;base64,aGk="); // base64("hi")
    expect(r).not.toBeNull();
    expect(r!.mime).toBe("image/png");
    expect(Array.from(r!.data)).toEqual([0x68, 0x69]); // "hi"
  });
  it("decodes a url-encoded (non-base64) data URI", () => {
    const r = decodeDataUri("data:text/plain,hello%20world");
    expect(r!.mime).toBe("text/plain");
    expect(Array.from(r!.data)).toEqual(Array.from(new TextEncoder().encode("hello world")));
  });
  it("returns null for a non-data URI", () => {
    expect(decodeDataUri("/home/dev/shot.png")).toBeNull();
    expect(decodeDataUri("https://example.com/x.png")).toBeNull();
  });
  it("returns null for a malformed data URI", () => {
    expect(decodeDataUri("data:image/png")).toBeNull();
  });
});

describe("transcript initial-fetch timeout + retry", () => {
  it("resolves on the first attempt without touching the retry path", async () => {
    const fetchOnce = vi.fn(() => Promise.resolve(["a"]));
    await expect(
      fetchTranscriptWithRetry(fetchOnce, { timeoutMs: 15000, retryDelayMs: 2000 }),
    ).resolves.toEqual(["a"]);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it("times out, waits the cooldown, then a retry succeeds", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchOnce = vi.fn(() => {
        calls++;
        return calls === 1
          ? new Promise(() => {}) // never resolves → timeout
          : Promise.resolve(["loaded"]);
      });
      const p = fetchTranscriptWithRetry(fetchOnce, {
        timeoutMs: 1000,
        retryDelayMs: 2000,
      });
      await vi.advanceTimersByTimeAsync(1000); // first attempt times out
      await vi.advanceTimersByTimeAsync(2000); // cooldown elapses
      await expect(p).resolves.toEqual(["loaded"]);
      expect(fetchOnce).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out, cooldown, times out again → rejects (loadError path)", async () => {
    vi.useFakeTimers();
    try {
      const fetchOnce = vi.fn(() => new Promise(() => {}));
      const p = fetchTranscriptWithRetry(fetchOnce, {
        timeoutMs: 1000,
        retryDelayMs: 2000,
      });
      // Attach the rejection handler EAGERLY — if it's only attached after the
      // timer advances, the retry's timeout rejection lands as unhandled.
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fetchOnce).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== computeTurnInfo (BET-688) =====

describe("computeTurnInfo", () => {
  const userMsg = (id: string) => ({
    info: { role: "user", id },
    parts: [],
  });

  const assistantMsg = (
    id: string,
    opts: {
      created?: number;
      completed?: number;
      output?: number;
      reasoning?: number;
    } = {},
  ) => ({
    info: {
      role: "assistant",
      id,
      time:
        opts.created != null || opts.completed != null
          ? { created: opts.created, completed: opts.completed }
          : undefined,
      tokens:
        opts.output != null || opts.reasoning != null
          ? {
              input: 0,
              output: opts.output ?? 0,
              reasoning: opts.reasoning ?? 0,
              cache: { read: 0, write: 0 },
            }
          : undefined,
    } as never,
    parts: [],
  });

  it("running: true, transcript ending in an assistant message → no footer entry for it", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 5000, output: 42 }),
    ];
    const info = computeTurnInfo(messages as never, true);
    expect(info.size).toBe(0);
    expect(info.has("a1")).toBe(false);
  });

  it("running: false, same transcript → footer entry with same duration/tokens", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 5000, output: 42 }),
    ];
    const info = computeTurnInfo(messages as never, false);
    expect(info.has("a1")).toBe(true);
    expect(info.get("a1")).toEqual({
      turnDurationMs: 4000,
      turnTokens: 42,
      verbSeedId: "a1",
    });
  });

  it("running: true, transcript ending with a USER message → completed turn footer PRESENT", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 5000, output: 9 }),
      userMsg("u2"),
    ];
    const info = computeTurnInfo(messages as never, true);
    expect(info.has("a1")).toBe(true);
    expect(info.get("a1")).toEqual({
      turnDurationMs: 4000,
      turnTokens: 9,
      verbSeedId: "a1",
    });
  });

  it("multi-step turn, running: false → entry only on the final assistant message", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 2000, output: 3 }),
      assistantMsg("a2", { created: 2000, completed: 6000, output: 20 }),
    ];
    const info = computeTurnInfo(messages as never, false);
    expect(info.has("a1")).toBe(false);
    expect(info.has("a2")).toBe(true);
    expect(info.get("a2")).toEqual({
      turnDurationMs: 5000,
      turnTokens: 23,
      verbSeedId: "a1",
    });
  });

  it("multi-step turn, running: true → the still-streaming final assistant gets NO footer", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 2000, output: 3 }),
      assistantMsg("a2", { created: 2000, completed: 6000, output: 20 }),
    ];
    const info = computeTurnInfo(messages as never, true);
    expect(info.has("a1")).toBe(false);
    expect(info.has("a2")).toBe(false);
  });

  it("returns empty map for a null transcript", () => {
    expect(computeTurnInfo(null, false).size).toBe(0);
    expect(computeTurnInfo(null, true).size).toBe(0);
  });

  it("sums output + reasoning across ALL assistant steps of the turn (not the last step's output)", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 2000, output: 10, reasoning: 1 }),
      assistantMsg("a2", { created: 2000, completed: 3000, output: 20, reasoning: 2 }),
      assistantMsg("a3", { created: 3000, completed: 7000, output: 30, reasoning: 3 }),
    ];
    const info = computeTurnInfo(messages as never, false);
    expect(info.get("a3")).toEqual({
      turnDurationMs: 6000,
      turnTokens: 66,
      verbSeedId: "a1",
    });
  });

  it("a turn with reasoning: 0 behaves as before (output-only arithmetic)", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 2000, output: 10, reasoning: 0 }),
      assistantMsg("a2", { created: 2000, completed: 5000, output: 20, reasoning: 0 }),
    ];
    const info = computeTurnInfo(messages as never, false);
    expect(info.get("a2")).toEqual({
      turnDurationMs: 4000,
      turnTokens: 30,
      verbSeedId: "a1",
    });
  });

  it("verbSeedId is the FIRST assistant message's id, not the last", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, completed: 2000, output: 5 }),
      assistantMsg("a2", { created: 2000, completed: 3000, output: 7 }),
      assistantMsg("a3", { created: 3000, completed: 6000, output: 9 }),
    ];
    const info = computeTurnInfo(messages as never, false);
    expect(info.get("a3")?.verbSeedId).toBe("a1");
  });

  it("computeLiveTurn: happy path — start time, summed tokens, first-assistant seed id", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", { created: 1000, output: 10, reasoning: 1 }),
      assistantMsg("a2", { created: 2000, output: 20, reasoning: 2 }),
    ];
    expect(computeLiveTurn(messages as never)).toEqual({
      startedAt: 1000,
      tokens: 33,
      verbSeedId: "a1",
    });
  });

  it("computeLiveTurn: no assistant message yet → falls back to the user message", () => {
    const messages = [{ info: { role: "user", id: "u1", time: { created: 5000 } }, parts: [] }];
    expect(computeLiveTurn(messages as never)).toEqual({
      startedAt: 5000,
      tokens: 0,
      verbSeedId: "u1",
    });
  });

  it("computeLiveTurn: null for an empty transcript", () => {
    expect(computeLiveTurn([] as never)).toBeNull();
    expect(computeLiveTurn(null)).toBeNull();
  });

  it("computeLiveTurn: null for a transcript with no user message", () => {
    const messages = [assistantMsg("a1", { created: 1000, output: 4 })];
    expect(computeLiveTurn(messages as never)).toBeNull();
  });
});

// ===== Subscription plan usage (BET-738) =====

function usageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: "claude",
    providerIDs: ["anthropic"],
    windows: [{ kind: "session", label: "Session (5h)", pct: 42 }],
    fetchedAt: 1_000_000,
    ...overrides,
  };
}

describe("selectUsageSnapshot", () => {
  it("matches the snapshot whose providerIDs contains the active providerID", () => {
    const anthropic = usageSnapshot({ provider: "claude", providerIDs: ["anthropic"] });
    const openai = usageSnapshot({ provider: "codex", providerIDs: ["openai"] });
    expect(selectUsageSnapshot([anthropic, openai], "openai")).toBe(openai);
    expect(selectUsageSnapshot([anthropic, openai], "anthropic")).toBe(anthropic);
  });

  it("returns null when no snapshot covers the providerID", () => {
    const anthropic = usageSnapshot({ providerIDs: ["anthropic"] });
    expect(selectUsageSnapshot([anthropic], "kimi-for-coding")).toBeNull();
  });

  it("returns null for an empty snapshot array", () => {
    expect(selectUsageSnapshot([], "anthropic")).toBeNull();
  });

  it("returns null when providerID is null/undefined, even with snapshots present", () => {
    const anthropic = usageSnapshot({ providerIDs: ["anthropic"] });
    expect(selectUsageSnapshot([anthropic], null)).toBeNull();
    expect(selectUsageSnapshot([anthropic], undefined)).toBeNull();
    expect(selectUsageSnapshot(null, "anthropic")).toBeNull();
  });
});

describe("usageDialState", () => {
  it("hidden below 70 with the always-show setting off", () => {
    const snap = usageSnapshot({ windows: [{ kind: "session", label: "s", pct: 69 }] });
    expect(usageDialState(snap, false).visible).toBe(false);
  });

  it("visible below 70 when the always-show setting is on", () => {
    const snap = usageSnapshot({ windows: [{ kind: "session", label: "s", pct: 10 }] });
    const state = usageDialState(snap, true);
    expect(state.visible).toBe(true);
    expect(state.tone).toBe("under");
  });

  it("tone flips at exactly 70 (under → warn)", () => {
    expect(
      usageDialState(usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 69 }] }), true).tone,
    ).toBe("under");
    expect(
      usageDialState(usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 70 }] }), true).tone,
    ).toBe("warn");
  });

  it("tone flips at exactly 90 (warn → danger)", () => {
    expect(
      usageDialState(usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 89 }] }), true).tone,
    ).toBe("warn");
    expect(
      usageDialState(usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 90 }] }), true).tone,
    ).toBe("danger");
  });

  it("tone flips at exactly 100 (danger → over)", () => {
    expect(
      usageDialState(usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 99 }] }), true).tone,
    ).toBe("danger");
    expect(
      usageDialState(usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 100 }] }), true).tone,
    ).toBe("over");
  });

  it("70 is visible even with the setting off (boundary is inclusive)", () => {
    const snap = usageSnapshot({ windows: [{ kind: "s", label: "s", pct: 70 }] });
    expect(usageDialState(snap, false).visible).toBe(true);
  });

  it("reports the FIRST window, not the highest — a 40% session beats an 85% weekly", () => {
    const snap = usageSnapshot({
      windows: [
        { kind: "session", label: "Session (5h)", pct: 40 },
        { kind: "weekly", label: "Weekly", pct: 85 },
      ],
    });
    const state = usageDialState(snap, true);
    expect(state.pct).toBe(40);
    expect(state.window?.kind).toBe("session");
    expect(state.tone).toBe("under");
  });

  it("a later window over threshold still makes the dial visible at 0% primary", () => {
    const snap = usageSnapshot({
      windows: [
        { kind: "session", label: "Session (5h)", pct: 0 },
        { kind: "weekly", label: "Weekly", pct: 95 },
      ],
    });
    const state = usageDialState(snap, false);
    expect(state.visible).toBe(true); // the weekly is what surfaces it
    expect(state.pct).toBe(0); // …but the number shown is the session's
    expect(state.window?.kind).toBe("session");
  });

  it("a snapshot with a single window works", () => {
    const snap = usageSnapshot({ windows: [{ kind: "session", label: "s", pct: 55 }] });
    const state = usageDialState(snap, true);
    expect(state.pct).toBe(55);
    expect(state.window?.kind).toBe("session");
  });

  it("a snapshot with zero windows is not visible", () => {
    const snap = usageSnapshot({ windows: [] });
    expect(usageDialState(snap, true)).toEqual({
      visible: false,
      pct: 0,
      tone: "under",
      window: null,
    });
  });

  it("a null snapshot is not visible", () => {
    expect(usageDialState(null, true).visible).toBe(false);
    expect(usageDialState(undefined, true).visible).toBe(false);
  });
});

describe("formatWindowReset", () => {
  it("formats hours and minutes", () => {
    const now = 0;
    expect(formatWindowReset(now + 2 * 3_600_000 + 10 * 60_000, now)).toBe("resets in 2h 10m");
  });

  it("formats minutes only under an hour", () => {
    const now = 0;
    expect(formatWindowReset(now + 45 * 60_000, now)).toBe("resets in 45m");
  });

  it("appends the absolute clock time when more than 12h out", () => {
    const now = 0;
    const resetsAt = now + 13 * 3_600_000;
    const result = formatWindowReset(resetsAt, now);
    expect(result).toMatch(/^resets in 13h 0m \(\d{2}:\d{2}\)$/);
  });

  it("returns null for a missing or past timestamp", () => {
    expect(formatWindowReset(null, 0)).toBeNull();
    expect(formatWindowReset(undefined, 0)).toBeNull();
    expect(formatWindowReset(-1, 0)).toBeNull();
    expect(formatWindowReset(NaN, 0)).toBeNull();
  });
});

describe("formatUpdatedAgo / usageStale", () => {
  it("formats sub-minute elapsed as 'updated just now'", () => {
    expect(formatUpdatedAgo(1000, 1000)).toBe("updated just now");
    expect(formatUpdatedAgo(1000, 30_000)).toBe("updated just now");
  });

  it("formats minutes/hours/days ago using formatAge's ladder", () => {
    expect(formatUpdatedAgo(0, 5 * 60_000)).toBe("updated 5m ago");
    expect(formatUpdatedAgo(0, 2 * 3_600_000)).toBe("updated 2h ago");
  });

  it("usageStale flips at exactly 10 minutes", () => {
    expect(usageStale(0, 10 * 60_000)).toBe(false);
    expect(usageStale(0, 10 * 60_000 + 1)).toBe(true);
  });
});


describe("pruneVisitedSessions", () => {
  it("returns dead sessions for removal", () => {
    const visited = new Set(["a", "b", "c"]);
    const live = new Set(["a", "c"]);
    expect(pruneVisitedSessions(visited, live, null).sort()).toEqual(["b"]);
  });

  it("keeps live sessions", () => {
    const visited = new Set(["a", "b"]);
    const live = new Set(["a", "b", "c"]);
    expect(pruneVisitedSessions(visited, live, null)).toEqual([]);
  });

  it("never removes the active session even if not in a live window", () => {
    const visited = new Set(["a", "b"]);
    const live = new Set<string>();
    expect(pruneVisitedSessions(visited, live, "a")).toEqual(["b"]);
  });

  it("returns an empty array for an empty visited set", () => {
    expect(pruneVisitedSessions(new Set<string>(), new Set(["a"]), null)).toEqual([]);
  });
});

// ===== selectStatusItems (BET-782 status-item registry cut) =====

describe("selectStatusItems", () => {
  const s = (id: string, priority: number) => ({
    id,
    priority,
    render: () => null,
  });

  // The real registry today, in construction order: context, artifacts, menu.
  // selectStatusItems preserves that order (acceptance #1: pixel-identical at
  // wide width); priority governs ONLY the overflow sacrifice order.
  const registry: StatusItem[] = [
    s("context", 60),
    s("artifacts", 80),
    s("menu", 100),
  ];

  it("renders everything in today's order at wide width, no overflow", () => {
    const { visible, overflow } = selectStatusItems(registry, 900, []);
    expect(visible.map((i) => i.id)).toEqual(["context", "artifacts", "menu"]);
    expect(overflow).toEqual([]);
  });

  it("keeps context at 560px (between the two cuts) — 560 cut is a seam only", () => {
    const { visible, overflow } = selectStatusItems(registry, 560, []);
    expect(visible.map((i) => i.id)).toEqual(["context", "artifacts", "menu"]);
    expect(overflow).toEqual([]);
  });

  it("moves context into overflow below 420px, keeping artifacts + menu", () => {
    const { visible, overflow } = selectStatusItems(registry, 419, []);
    expect(visible.map((i) => i.id)).toEqual(["artifacts", "menu"]);
    expect(overflow.map((i) => i.id)).toEqual(["context"]);
  });

  it("never auto-hides priority ≥ 80 at any width", () => {
    const { visible, overflow } = selectStatusItems(registry, 200, []);
    expect(visible.map((i) => i.id)).toEqual(["artifacts", "menu"]);
    expect(overflow.map((i) => i.id)).toEqual(["context"]);
  });

  it("both cuts: a <60 item is hidden at 560 only, and `context` joins at 420", () => {
    const items = [...registry, s("checks", 40)];
    // 900px — everything fits, today's order preserved, checks appended last.
    let r = selectStatusItems(items, 900, []);
    expect(r.visible.map((i) => i.id)).toEqual([
      "context",
      "artifacts",
      "menu",
      "checks",
    ]);
    expect(r.overflow).toEqual([]);
    // 500px (≥420, <560): hide priority < 60 → checks, keep the rest.
    r = selectStatusItems(items, 500, []);
    expect(r.visible.map((i) => i.id)).toEqual(["context", "artifacts", "menu"]);
    expect(r.overflow.map((i) => i.id)).toEqual(["checks"]);
    // 400px: also hide context.
    r = selectStatusItems(items, 400, []);
    expect(r.visible.map((i) => i.id)).toEqual(["artifacts", "menu"]);
    expect(r.overflow.map((i) => i.id)).toEqual(["context", "checks"]);
  });

  it("a hidden id is absent from both arrays (bar and overflow)", () => {
    const { visible, overflow } = selectStatusItems(registry, 300, ["context"]);
    expect(visible.map((i) => i.id)).toEqual(["artifacts", "menu"]);
    expect(overflow.map((i) => i.id)).toEqual([]);
  });

  it("hidden ids can remove a ≥80 item entirely, distinct from the auto cut", () => {
    const { visible, overflow } = selectStatusItems(registry, 900, ["artifacts"]);
    expect(visible.map((i) => i.id)).toEqual(["context", "menu"]);
    expect(overflow).toEqual([]);
  });

  it("keeps the registry construction order stable (no priority re-sort of the bar)", () => {
    const items = [s("menu", 100), s("context", 60), s("artifacts", 80)];
    const r = selectStatusItems(items, 900, []);
    expect(r.visible.map((i) => i.id)).toEqual(["menu", "context", "artifacts"]);
    expect(r.overflow).toEqual([]);
  });

  it("breaks equal-priority ties by stable id sort", () => {
    // Same priority, deliberately out of id order — must come back id-sorted,
    // regardless of the order they were pushed into the registry.
    const tied = [s("z", 60), s("b", 60), s("a", 60)];
    const r = selectStatusItems(tied, 900, []);
    expect(r.visible.map((i) => i.id)).toEqual(["a", "b", "z"]);
    expect(r.overflow).toEqual([]);
  });

  it("id-sorts tied items within the overflow too", () => {
    // Two equal-priority (60) items both cut at 400px — id-ordered in overflow.
    const tied = [s("z", 60), s("a", 60)];
    const r = selectStatusItems(tied, 400, []);
    expect(r.visible).toEqual([]);
    expect(r.overflow.map((i) => i.id)).toEqual(["a", "z"]);
  });

  it("handles an empty registry", () => {
    const r = selectStatusItems([], 400, []);
    expect(r.visible).toEqual([]);
    expect(r.overflow).toEqual([]);
  });
});

describe("arrangeCards", () => {
  const blocking = (id: string, order: number) => ({ id, tier: "blocking" as const, order });
  const ambient = (id: string, order: number) => ({ id, tier: "ambient" as const, order });

  it("returns an empty result for no cards", () => {
    expect(arrangeCards([])).toEqual({
      blocking: null,
      blockingMore: 0,
      ambient: [],
      ambientRollup: [],
    });
  });

  it("renders a single blocking card", () => {
    const cards = [blocking("permission-a", 0)];
    const r = arrangeCards(cards);
    expect(r.blocking?.id).toBe("permission-a");
    expect(r.blockingMore).toBe(0);
  });

  it("three blocking cards: one expanded plus 2 more", () => {
    const cards = [
      blocking("permission-a", 0),
      blocking("permission-b", 1),
      blocking("delegate-approval", 2),
    ];
    const r = arrangeCards(cards);
    expect(r.blocking?.id).toBe("delegate-approval"); // newest (highest order)
    expect(r.blockingMore).toBe(2);
  });

  it("blocking picks the newest regardless of input order", () => {
    const cards = [
      blocking("delegate-approval", 5),
      blocking("permission-a", 0),
      blocking("permission-b", 1),
    ];
    expect(arrangeCards(cards).blocking?.id).toBe("delegate-approval");
    expect(arrangeCards(cards).blockingMore).toBe(2);
  });

  it("two ambient cards both render expanded", () => {
    const cards = [ambient("retry", 7), ambient("compaction", 6)];
    const r = arrangeCards(cards);
    expect(r.ambient.map((c) => c.id)).toEqual(["retry", "compaction"]);
    expect(r.ambientRollup).toEqual([]);
  });

  it("four ambient cards: two expanded, two rolled up", () => {
    const cards = [
      ambient("retry", 7),
      ambient("compaction", 6),
      ambient("send-error", 5),
      ambient("queued", 4),
    ];
    const r = arrangeCards(cards);
    expect(r.ambient.map((c) => c.id)).toEqual(["retry", "compaction"]);
    expect(r.ambientRollup.map((c) => c.id)).toEqual(["send-error", "queued"]);
  });

  it("ambient priority order is independent of input order", () => {
    const r = arrangeCards([
      ambient("queued", 4),
      ambient("send-error", 5),
      ambient("retry", 7),
      ambient("compaction", 6),
    ]);
    expect(r.ambient.map((c) => c.id)).toEqual(["retry", "compaction"]);
    expect(r.ambientRollup.map((c) => c.id)).toEqual(["send-error", "queued"]);
  });

  it("blocking always orders above ambient (never interleaved)", () => {
    const r = arrangeCards([
      ambient("retry", 100),
      blocking("permission-a", 0),
      ambient("compaction", 90),
    ]);
    // blocking is separate from ambient entirely:
    expect(r.blocking?.id).toBe("permission-a");
    expect(r.ambient.map((c) => c.id)).toEqual(["retry", "compaction"]);
  });

  it("blocks with more ambient than the expanded cap roll up", () => {
    const r = arrangeCards([
      blocking("permission-a", 0),
      ambient("retry", 7),
      ambient("compaction", 6),
      ambient("send-error", 5),
      ambient("queued", 4),
    ]);
    expect(r.blocking?.id).toBe("permission-a");
    expect(r.blockingMore).toBe(0);
    expect(r.ambient.length).toBe(2);
    expect(r.ambientRollup.length).toBe(2);
  });
});

// ===== BET-787: repo-probe zero state =====

function repoRow(over: Partial<RepoRow>): RepoRow {
  return {
    path: "/home/u/proj",
    name: "proj",
    branch: "main",
    originUrl: "https://github.com/owner/proj.git",
    forge: "github",
    repoKey: "owner/proj",
    lastCommitAt: 0,
    local: true,
    ...over,
  };
}

describe("zeroStateMode", () => {
  it("returns scanning while the probe is pending, whatever the repos", () => {
    expect(zeroStateMode({ probePending: true, probeFailed: false, repos: [] })).toBe("scanning");
    expect(
      zeroStateMode({ probePending: true, probeFailed: false, repos: [repoRow({})] }),
    ).toBe("scanning");
  });

  it("returns degraded when the probe failed", () => {
    expect(zeroStateMode({ probePending: false, probeFailed: true, repos: [] })).toBe("degraded");
    expect(
      zeroStateMode({ probePending: false, probeFailed: true, repos: [repoRow({})] }),
    ).toBe("degraded");
  });

  it("returns list when the probe succeeded with repos", () => {
    expect(
      zeroStateMode({ probePending: false, probeFailed: false, repos: [repoRow({})] }),
    ).toBe("list");
  });

  it("returns fresh (not degraded) when the probe succeeded with zero repos", () => {
    expect(zeroStateMode({ probePending: false, probeFailed: false, repos: [] })).toBe("fresh");
  });
});

describe("initialRepoSelection", () => {
  it("checks every local row when they fit under the cap", () => {
    const repos = [
      repoRow({ path: "/a", lastCommitAt: 3 }),
      repoRow({ path: "/b", lastCommitAt: 2 }),
      repoRow({ path: "/c", lastCommitAt: 1 }),
    ];
    const sel = initialRepoSelection(repos, 8);
    expect(sel.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
  });

  it("caps the checked set at the cap, most-recent first (12 repos -> 8)", () => {
    const repos = Array.from({ length: 12 }, (_, i) =>
      repoRow({ path: `/r${i}`, lastCommitAt: 12 - i }),
    );
    const sel = initialRepoSelection(repos, 8);
    expect(sel).toHaveLength(8);
    expect(sel[0].path).toBe("/r0");
    expect(sel[1].path).toBe("/r1");
    expect(sel[7].path).toBe("/r7");
  });

  it("never pre-checks a non-local row, even a recent one", () => {
    const repos = [
      repoRow({ path: "/local-repo", lastCommitAt: 2 }),
      repoRow({ path: "/clone-repo", lastCommitAt: 99, local: false }),
    ];
    const sel = initialRepoSelection(repos, 8);
    expect(sel.map((r) => r.path)).toEqual(["/local-repo"]);
  });
});

describe("describeRepoRow", () => {
  it("shows only the branch when the repo has an origin", () => {
    expect(describeRepoRow(repoRow({ branch: "feat/forge-seam" }))).toBe("⎇ feat/forge-seam");
  });

  it("shows branch + path + no remote without an origin", () => {
    expect(
      describeRepoRow(
        repoRow({ branch: "main", originUrl: null, path: "/home/u/scratch", repoKey: null, forge: null }),
      ),
    ).toBe("⎇ main · /home/u/scratch · no remote");
  });
});

describe("planHighlightRanges", () => {
  it("returns one range for a single match inside one text node", () => {
    expect(planHighlightRanges([15], "the quick brown fox", "brown")).toEqual([
      { startNode: 0, startOffset: 10, endNode: 0, endOffset: 15 },
    ]);
  });

  it("returns ONE range spanning two text nodes when a match straddles them", () => {
    const lengths = [6, 6]; // "Hello " + "worldX"
    const text = "Hello worldX";
    expect(planHighlightRanges(lengths, text, " world")).toEqual([
      { startNode: 0, startOffset: 5, endNode: 1, endOffset: 5 },
    ]);
  });

  it("is case-insensitive", () => {
    expect(planHighlightRanges([3], "foo", "Foo")).toEqual([
      { startNode: 0, startOffset: 0, endNode: 0, endOffset: 3 },
    ]);
  });

  it("returns one range per non-overlapping match, in document order", () => {
    expect(planHighlightRanges([13], "cat dog cat", "cat")).toEqual([
      { startNode: 0, startOffset: 0, endNode: 0, endOffset: 3 },
      { startNode: 0, startOffset: 8, endNode: 0, endOffset: 11 },
    ]);
  });

  it("resumes after each match so 'aa' in 'aaaa' yields 2 ranges, not 3", () => {
    expect(planHighlightRanges([4], "aaaa", "aa")).toEqual([
      { startNode: 0, startOffset: 0, endNode: 0, endOffset: 2 },
      { startNode: 0, startOffset: 2, endNode: 0, endOffset: 4 },
    ]);
    expect(planHighlightRanges([4], "aaaa", "aa")).toHaveLength(2);
  });

  it("returns [] for an empty query, a whitespace-only query, or no match", () => {
    expect(planHighlightRanges([5], "abcde", "")).toEqual([]);
    expect(planHighlightRanges([5], "abcde", "   ")).toEqual([]);
    expect(planHighlightRanges([5], "abcde", "zzz")).toEqual([]);
  });

  it("returns [] for an empty lengths array (a row with no text nodes)", () => {
    expect(planHighlightRanges([], "", "cat")).toEqual([]);
  });
});

// ===== checksChipDescriptor / branchChipLabel / shouldOfferForgeConnect (BET-789) =====

describe("countsForChecks", () => {
  it("buckets success / other-conclusion / pending into passed / failed / running", () => {
    const checks = [
      { name: "a", conclusion: "success" },
      { name: "b", conclusion: "failure" },
      { name: "c", conclusion: "timed_out" },
      { name: "d" },
      { name: "e", status: "in_progress" },
      { name: "f", status: "queued" },
    ];
    expect(countsForChecks(checks)).toEqual({ passed: 1, failed: 2, running: 3 });
  });

  it("empty list → all zero", () => {
    expect(countsForChecks([])).toEqual({ passed: 0, failed: 0, running: 0 });
  });
});

describe("checksChipDescriptor", () => {
  it("green → ✓ N, ok tone, priority 40 (first to overflow)", () => {
    expect(checksChipDescriptor("green", { passed: 7, failed: 0, running: 0 })).toEqual({
      label: "✓ 7",
      tone: "ok",
      priority: 40,
    });
  });

  it("red → ✗ N failed, danger tone, priority 90 (survives the narrow layout)", () => {
    expect(checksChipDescriptor("red", { passed: 0, failed: 2, running: 0 })).toEqual({
      label: "✗ 2 failed",
      tone: "danger",
      priority: 90,
    });
  });

  it("yellow → ◐ N running, warn tone, priority 40", () => {
    expect(checksChipDescriptor("yellow", { passed: 0, failed: 0, running: 3 })).toEqual({
      label: "◐ 3 running",
      tone: "warn",
      priority: 40,
    });
  });

  it("none → null (no chip — nothing to say)", () => {
    expect(checksChipDescriptor("none", { passed: 0, failed: 0, running: 0 })).toBeNull();
  });
});

describe("branchChipLabel", () => {
  it("branch only → ⎇ branch", () => {
    expect(branchChipLabel("feat/forge-seam", null)).toBe("⎇ feat/forge-seam");
  });

  it("branch + pr → ⎇ branch · #412", () => {
    expect(branchChipLabel("feat/forge-seam", { number: 412 })).toBe(
      "⎇ feat/forge-seam · #412",
    );
  });

  it("no branch → null (chip not rendered), whatever the PR state", () => {
    expect(branchChipLabel(null, null)).toBeNull();
    expect(branchChipLabel(null, { number: 412 })).toBeNull();
  });
});

describe("shouldOfferForgeConnect", () => {
  const cases: [boolean, string | null, boolean, boolean][] = [
    // connected  forgeKind               dismissed  expected
    [false, "github", false, true], // forge present, not connected, not dismissed → offer
    [false, "github", true, false], // dismissed → permanent
    [false, null, false, false], // not a forge origin → no offer
    [false, null, true, false],
    [true, "github", false, false], // connected → never offer
    [true, "github", true, false],
    [true, null, false, false],
    [true, null, true, false],
  ];
  for (const [connected, forgeKind, dismissed, expected] of cases) {
    it(`connected=${connected} forgeKind=${forgeKind ?? "null"} dismissed=${dismissed} → ${expected}`, () => {
      expect(shouldOfferForgeConnect({ connected, forgeKind, dismissed })).toBe(expected);
    });
  }
});

describe("failuresToAgentPrompt", () => {
  it("names failing checks with their log URLs", () => {
    const prompt = failuresToAgentPrompt([
      { name: "typecheck-test", conclusion: "failure", url: "https://x/logs/1" },
      { name: "duplication-gate", conclusion: "failure" },
      { name: "lint", conclusion: "success" },
    ]);
    expect(prompt).toContain("typecheck-test");
    expect(prompt).toContain("https://x/logs/1");
    expect(prompt).toContain("duplication-gate");
    expect(prompt).not.toContain("lint");
  });

  it("no failing checks → empty body", () => {
    expect(failuresToAgentPrompt([])).toBe("");
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  createEntryMotionState,
  updateEntryMotion,
  markReconciledFromOptimistic,
  isOptimisticUserId,
  computeTurnInfo,
  computeLiveTurn,
  contextModelLabel,
  formatTokens,
  buildCumulativePath,
  chartAxisTicks,
  formatBytes,
  describeSavedFile,
  voiceUiEnabled,
  expiryLabel,
  formatDuration,
  formatClockTime,
  ctxStageColor,
  cssVar,
  filterCommands,
  detectTypeaheadTrigger,
  dedupeAgainstBuiltins,
  formatModelContextSize,
  shouldClearMissingModel,
  findSessionTitle,
  formatHiddenTodosSummary,
  summarizeTodoProgress,
  todoStatusOf,
  buildQuestionAnswers,
  canSubmitQuestion,
  formatAge,
  QUOTE_MAX,
  QUOTE_HEAD,
  QUOTE_TAIL,
  truncateMiddle,
  buildQuoteBlock,
  isUnknownChannelError,
  describeCron,
  nextCronRun,
  describeNextRun,
  resolveToolOutput,
  trimOutputEdges,
  reconcileOptimisticUser,
  shouldForceReconnect,
  authProviderSeatId,
  shouldReconnectOnAppStateChange,
  runWithConcurrency,
  chooseUpdateSkewVariant,
  isTransientUpdateNetworkError,
  boxUpgradeLanded,
  arrowUpNavigatesHistory,
  arrowDownNavigatesHistory,
  parseDeviceCode,
  deviceCodeFallback,
  formatRemaining,
  slugifyProviderId,
  customProviderDraftError,
  connectPhaseLabel,
  isPollExpired,
  arrangeCards,
  terminalShortcut,
  terminalMountKey,
  registerMountedTerminal,
  isJobRow,
  isBackgroundJobCompletionTurn,
  visibleAssistantParts,
  isRenderableMessage,
  windowPinId,
  parsePinId,
  resolvePin,
  projectForNavKey,
  fuzzySessionScore,
  computeJobNesting,
  sessionsWithActiveWork,
  shouldResyncWindowsForJobs,
  shortModelName,
  isFastModelId,
  baseModelId,
  fastModelId,
  resolveFastToggle,
  resolvePlanToggle,
  filterModelGroups,
  moveMenuHighlight,
  MAX_PREVIEW_BYTES,
  resolvePreviewType,
  isWithinPreviewSize,
  formatPreviewFooter,
  countPreviewLines,
  resolveMediaAspect,
  mediaKindFromMime,
  isMediaMime,
  mediaGrid,
  filePartToMediaEntry,
  applyMediaEvent,
  dispatchMedia,
  applyWidgetEvent,
  dispatchWidget,
  previewLanguage,
  previewOriginWord,
  decodeDataUri,
  fetchTranscriptWithRetry,
  selectUsageSnapshot,
  providersFromExcludedKeys,
  usageDialState,
  formatWindowReset,
  formatResetAt,
  formatResetDistance,
  formatTimerDuration,
  formatUpdatedAgo,
  usageStale,
  pruneVisitedSessions,
  selectStatusItems,
  shouldOfferForgeConnect,
  zeroStateMode,
  describeRepoRow,
  homeRelativePath,
  planHighlightRanges,
  type StatusItem,
  type RepoRow,
  workingIndicatorLabel,
  progressAttentionKind,
  concatUserMessageText,
  buildVoiceNoteMap,
  dispatchAppControl,
  scrollElementToTail,
  classifyFollowOnScroll,
  isUpwardScrollGesture,
  createUserScrollIntent,
  hasUserScrollIntent,
  releaseUserScrollIntent,
  USER_SCROLL_INTENT_WINDOW_MS,
  FOLLOW_THRESHOLD_PX,
  isPlanExitQuestion,
  extractPlanData,
  resolveDelegateModel,
  deviceAuthErrorMessage,
} from "./chatUtils";

import type { OpencodeModel, OpencodeAgent, UsageSnapshot, OpencodeMessage, VoiceNoteRecord, QuestionRequest } from "../shared/types";



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

// ===== buildCumulativePath (BET-1337) =====

describe("buildCumulativePath", () => {
  it("returns empty string for empty or non-array input", () => {
    expect(buildCumulativePath([], 100, 200, 10)).toBe("");
    expect(buildCumulativePath(undefined as never, 100, 200, 10)).toBe("");
  });

  it("renders a single value as one point at the origin (x=0)", () => {
    // cum = 5 of max 10 on a 200px tall surface → y = 200 - (5/10)*200 = 100
    expect(buildCumulativePath([5], 100, 200, 10)).toBe("M 0.00 100.00");
  });

  it("is cumulative and monotonic (running sum only grows)", () => {
    const p = buildCumulativePath([2, 3, 1], 200, 100, 10);
    // cumulative sums: 2, 5, 6 → y = 100 - sum/10*100 = 80, 50, 40
    expect(p).toBe("M 0.00 80.00 L 100.00 50.00 L 200.00 40.00");
  });

  it("maps a cumulative sum equal to max to the very top (y=0)", () => {
    expect(buildCumulativePath([10], 100, 200, 10)).toBe("M 0.00 0.00");
  });

  it("rounds coordinates to 2 decimals", () => {
    // 3 values, width 100 → x = 0, 50, 100 exactly; y from a fractional sum
    expect(buildCumulativePath([1, 2, 3], 100, 99, 7)).toBe(
      "M 0.00 84.86 L 50.00 56.57 L 100.00 14.14",
    );
  });

  it("falls back to the top of the surface when max is not positive", () => {
    // no positive max → every point sits at y = height (bottom)
    expect(buildCumulativePath([1, 2], 100, 200, 0)).toBe("M 0.00 200.00 L 100.00 200.00");
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

// ===== describeSavedFile =====

describe("describeSavedFile", () => {
  it("splits an absolute POSIX path into folder + name", () => {
    expect(describeSavedFile("/Users/antoine/Downloads/dog-running.mp4")).toEqual({
      dir: "/Users/antoine/Downloads",
      name: "dog-running.mp4",
    });
  });

  it("splits a Windows path on backslashes", () => {
    expect(describeSavedFile("C:\\Users\\antoine\\Downloads\\report.pdf")).toEqual({
      dir: "C:\\Users\\antoine\\Downloads",
      name: "report.pdf",
    });
  });

  it("keeps the root slash rather than reporting an empty folder", () => {
    expect(describeSavedFile("/dog.png")).toEqual({ dir: "/", name: "dog.png" });
  });

  it("returns null when there is no OS path to describe (mobile/web)", () => {
    // agentPullFile returns "" on mobile — the browser owns the download
    // chrome there, so the toast must not claim a path we don't have.
    expect(describeSavedFile("")).toBeNull();
    expect(describeSavedFile("   ")).toBeNull();
    expect(describeSavedFile(undefined)).toBeNull();
    expect(describeSavedFile(null)).toBeNull();
  });

  it("returns null for a bare directory (no file name)", () => {
    expect(describeSavedFile("/Users/antoine/Downloads/")).toBeNull();
  });

  it("treats a bare filename as having no folder", () => {
    expect(describeSavedFile("dog.png")).toEqual({ dir: "", name: "dog.png" });
  });
});

// ===== expiryLabel =====

describe("voiceUiEnabled (BET-1191)", () => {
  it("is off when the build flag is unset or any value other than '1'", () => {
    expect(voiceUiEnabled(undefined)).toBe(false);
    expect(voiceUiEnabled("")).toBe(false);
    expect(voiceUiEnabled("0")).toBe(false);
    expect(voiceUiEnabled("true")).toBe(false);
  });

  it("is on when the build flag is exactly '1'", () => {
    expect(voiceUiEnabled("1")).toBe(true);
  });
});

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

// ===== shouldClearMissingModel =====
describe("shouldClearMissingModel", () => {
  const sel = { providerID: "anthropic", modelID: "claude-opus-5-5" };
  it("never clears on an empty or missing catalog", () => {
    expect(shouldClearMissingModel([], sel)).toBe(false);
    expect(shouldClearMissingModel(null, sel)).toBe(false);
    expect(shouldClearMissingModel(undefined, sel)).toBe(false);
  });
  it("clears when a non-empty catalog lacks the saved model", () => {
    expect(shouldClearMissingModel([{ providerID: "anthropic", id: "claude-haiku-4-5" }], sel)).toBe(true);
    expect(shouldClearMissingModel([{ providerID: "openai", id: "claude-opus-5-5" }], sel)).toBe(true);
  });
  it("keeps a saved model the catalog contains, and does nothing without a saved model", () => {
    expect(shouldClearMissingModel([{ providerID: "anthropic", id: "claude-opus-5-5" }], sel)).toBe(false);
    expect(shouldClearMissingModel([{ providerID: "anthropic", id: "x" }], null)).toBe(false);
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

// ===== findSessionTitle (BET-1018) =====
describe("findSessionTitle", () => {
  const sessions = [
    { id: "ses_sky", title: "Sky colour" },
    { id: "ses_pay", title: "  Payment webhook retry idempotency  " },
    { id: "ses_untitled", title: "" },
    { id: "ses_no_title" },
  ];

  it("returns the title for a matching session id", () => {
    expect(findSessionTitle(sessions, "ses_sky")).toBe("Sky colour");
  });

  it("trims surrounding whitespace from the title", () => {
    expect(findSessionTitle(sessions, "ses_pay")).toBe("Payment webhook retry idempotency");
  });

  it("returns '' when the session id has no match", () => {
    expect(findSessionTitle(sessions, "ses_missing")).toBe("");
  });

  it("returns '' when the session carries no usable title", () => {
    expect(findSessionTitle(sessions, "ses_untitled")).toBe("");
    expect(findSessionTitle(sessions, "ses_no_title")).toBe("");
  });

  it("returns a contraction title intact (no apostrophe stripping to a fragment) (BET-1100)", () => {
    expect(findSessionTitle([{ id: "ses_im", title: "I'm just checking the setup" }], "ses_im")).toBe(
      "I'm just checking the setup",
    );
  });

  it("returns '' for an empty / missing session list or id", () => {
    expect(findSessionTitle([], "ses_sky")).toBe("");
    expect(findSessionTitle(sessions, "")).toBe("");
    expect(findSessionTitle(undefined as never, "ses_sky")).toBe("");
  });
});

// ===== filterModelGroups =====

function model(id: string, providerID: string): OpencodeModel {
  return {
    id,
    providerID,
    name: id,
    limit: { context: 200_000 },
    capabilities: { toolcall: true, input: ["text"], output: ["text"] },
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

// ===== truncateMiddle / buildQuoteBlock (BET-1351) =====

describe("truncateMiddle", () => {
  it("returns text unchanged at and below max", () => {
    const text = "a".repeat(QUOTE_MAX);
    expect(truncateMiddle(text, QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL)).toBe(text);
    expect(truncateMiddle("short", QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL)).toBe("short");
  });

  it("produces `head … tail` above max and is shorter than the input", () => {
    const text = "x".repeat(QUOTE_MAX + 50);
    const out = truncateMiddle(text, QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL);
    expect(out).toBe(`${"x".repeat(QUOTE_HEAD)} … ${"x".repeat(QUOTE_TAIL)}`);
    expect(out.length).toBeLessThan(text.length);
    expect(out.length).toBeLessThanOrEqual(QUOTE_MAX);
  });

  it("uses a single U+2026 with one space each side", () => {
    const text = "a".repeat(QUOTE_MAX + 10);
    const out = truncateMiddle(text, QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL);
    expect(out).toContain(" \u2026 ");
    expect(out.split("\u2026")).toHaveLength(2);
    expect(out).not.toContain("...");
  });
});

describe("buildQuoteBlock", () => {
  it("collapses newlines and runs of spaces to single spaces and trims", () => {
    const out = buildQuoteBlock("  hello   world\n\nsecond  line  ", QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL);
    expect(out).toBe("> hello world second line\n\n");
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(buildQuoteBlock("", QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL)).toBeNull();
    expect(buildQuoteBlock("   \n\t  ", QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL)).toBeNull();
  });

  it("prefixes exactly '> ' and ends with exactly '\\n\\n'", () => {
    const out = buildQuoteBlock("hello", QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL);
    expect(out).toMatch(/^> /);
    expect(out!.endsWith("\n\n")).toBe(true);
  });

  it("reduces a long multi-paragraph selection to one line with exactly one ellipsis", () => {
    const paragraph = "word ".repeat(120).trim();
    const multi = `${paragraph}\n\n${paragraph}`;
    const out = buildQuoteBlock(multi, QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL)!;
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out.split(" \u2026 ")).toHaveLength(2);
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

// ===== "Check for updates" verdict rows =====

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

  it("treats a gateway 5xx on the update RPC as the same transient restart-drop", () => {
    // Over HTTPS a reverse proxy answers the in-flight update RPC with a bare
    // gateway 5xx while the box restarts itself — the same benign success-path
    // drop as `Failed to fetch`, just a different spelling. Must NOT abort the
    // graceful boxUpgrading flow.
    expect(isTransientUpdateNetworkError(new Error("HTTP 502 Bad Gateway"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("HTTP 502"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("HTTP 503"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("HTTP 504 Gateway Timeout"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("Bad Gateway"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("HTTP 521"))).toBe(true);
    expect(isTransientUpdateNetworkError(new Error("HTTP 524 origin is unreachable"))).toBe(true);
  });

  it("does NOT treat a real server-reported early failure as transient", () => {
    // Genuine failures come back as structured strings from the RPC result,
    // not as connection errors — these must still raise the update-failed banner.
    expect(isTransientUpdateNetworkError(new Error("self-update: manifest fetch failed: https://mantaui.com/releases/"))).toBe(false);
    expect(isTransientUpdateNetworkError(new Error("self-update: manifest is malformed"))).toBe(false);
    expect(isTransientUpdateNetworkError(new Error("self-update: bad tarball — missing src/server/index.mjs"))).toBe(false);
    expect(isTransientUpdateNetworkError(new Error("spawn /abs/scripts/self-update.sh EACCES"))).toBe(false);
    // Even a structured failure whose text mentions the download URL (which can
    // contain "502") must stay real — the box is UP and reported it couldn't
    // fetch the tarball. The `self-update:` guard wins over the gateway match.
    expect(isTransientUpdateNetworkError(new Error("self-update: download failed: https://mantaui.com/releases/manta-x.tar.gz"))).toBe(false);
  });

  it("does NOT treat a bare HTTP 500 (server up but errored) as transient", () => {
    // 500 means the box answered — it is NOT restarting, so this is a real
    // failure, not the benign origin-unreachable family.
    expect(isTransientUpdateNetworkError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
  });

  it("is tolerant of null/undefined and arbitrary input", () => {
    expect(isTransientUpdateNetworkError(null)).toBe(false);
    expect(isTransientUpdateNetworkError(undefined)).toBe(false);
    expect(isTransientUpdateNetworkError("")).toBe(false);
    expect(isTransientUpdateNetworkError(42)).toBe(false);
  });
});

// ===== boxUpgradeLanded =====
describe("boxUpgradeLanded", () => {
  it("returns true only when both versions are present and differ", () => {
    expect(boxUpgradeLanded(null, "1.0.1")).toBe(false);
    expect(boxUpgradeLanded("1.0.0", null)).toBe(false);
    expect(boxUpgradeLanded("", "1.0.1")).toBe(false);
    expect(boxUpgradeLanded("1.0.0", "")).toBe(false);
    expect(boxUpgradeLanded("1.0.0", "1.0.0")).toBe(false);
    expect(boxUpgradeLanded("1.0.0", "1.0.1")).toBe(true);
    expect(boxUpgradeLanded("1.0.1", "1.0.0")).toBe(true);
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

// ===== visibleAssistantParts / isRenderableMessage (BET-874) =====

function assistantMsg(parts: Array<Record<string, unknown>>): OpencodeMessage {
  return { info: { role: "assistant", id: "ma", sessionID: "s1" }, parts } as unknown as OpencodeMessage;
}

describe("visibleAssistantParts", () => {
  it("keeps a real text part", () => {
    const parts = visibleAssistantParts(
      assistantMsg([{ type: "text", text: "hello", id: "p1" }]),
    );
    expect(parts).toHaveLength(1);
  });

  it("drops step-start/step-finish and todowrite tool parts", () => {
    const parts = visibleAssistantParts(
      assistantMsg([
        { type: "step-start", id: "p1" },
        { type: "tool", tool: "todowrite", id: "p2" },
        { type: "step-finish", id: "p3" },
      ]),
    );
    expect(parts).toHaveLength(0);
  });

  it("drops empty, synthetic and ignored text parts", () => {
    const parts = visibleAssistantParts(
      assistantMsg([
        { type: "text", text: "", id: "p1" },
        { type: "text", text: "skip", synthetic: true, id: "p2" },
        { type: "text", text: "skip", ignored: true, id: "p3" },
        { type: "tool", tool: "bash", id: "p4" },
      ]),
    );
    expect(parts.map((p) => p.id)).toEqual(["p4"]);
  });
});

describe("isRenderableMessage", () => {
  const userMsg = (text: string, extra?: Array<Record<string, unknown>>): OpencodeMessage =>
    ({ info: { role: "user", id: "m1", sessionID: "s1" }, parts: [{ type: "text", text, id: "p1" }, ...(extra ?? [])] }) as unknown as OpencodeMessage;

  it("false for a background-job completion turn", () => {
    expect(
      isRenderableMessage(
        userMsg('[background job "x" done]\nresult'),
      ),
    ).toBe(false);
  });

  it("true for a user message with text", () => {
    expect(isRenderableMessage(userMsg("hello there"))).toBe(true);
  });

  it("true for a user message with only a file part", () => {
    expect(isRenderableMessage(userMsg("", [{ type: "file", id: "f1" }]))).toBe(
      true,
    );
  });

  it("false for a user message with neither text nor a file part", () => {
    expect(isRenderableMessage(userMsg(""))).toBe(false);
  });

  it("false for an assistant message with only step-start/step-finish", () => {
    expect(
      isRenderableMessage(
        assistantMsg([
          { type: "step-start", id: "p1" },
          { type: "step-finish", id: "p2" },
        ]),
      ),
    ).toBe(false);
  });

  it("false for an assistant message with only a todowrite tool part", () => {
    expect(
      isRenderableMessage(assistantMsg([{ type: "tool", tool: "todowrite", id: "p1" }])),
    ).toBe(false);
  });

  it("true for an assistant message with a text part", () => {
    expect(
      isRenderableMessage(assistantMsg([{ type: "text", text: "result", id: "p1" }])),
    ).toBe(true);
  });

  it("true for an assistant message whose only parts are a non-todo tool call", () => {
    expect(
      isRenderableMessage(assistantMsg([{ type: "tool", tool: "bash", id: "p1" }])),
    ).toBe(true);
  });
});

// ===== BET-414 sidebar helpers =====

import type { Project } from "../shared/types";

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

describe("projectForNavKey", () => {
  it("resolves a group key to its session", () => {
    expect(projectForNavKey("group:better-ui")).toBe("better-ui");
  });

  it("resolves window and job keys to their session", () => {
    expect(projectForNavKey("win:better-ui:3")).toBe("better-ui");
    expect(projectForNavKey("job:better-ui:4")).toBe("better-ui");
  });

  it("returns null for pin keys (the caller resolves pins)", () => {
    expect(projectForNavKey("pin:anything")).toBeNull();
  });

  it("returns null for null and garbage", () => {
    expect(projectForNavKey(null)).toBeNull();
    expect(projectForNavKey("garbage")).toBeNull();
    expect(projectForNavKey("")).toBeNull();
    expect(projectForNavKey("win:")).toBeNull();
  });

  it("resolves a session name containing a colon", () => {
    expect(projectForNavKey("group:a:b")).toBe("a:b");
    expect(projectForNavKey("win:a:b:3")).toBe("a:b");
    expect(projectForNavKey("job:a:b:7")).toBe("a:b");
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

describe("a job row nests by displayParentID ?? parentSessionID", () => {
  // The real parent ("old") has no window; the orchestrator that drives the job ("driver") does.
  const projects = [
    mkProject("p", [
      { index: 1, name: "driver", opencodeSessionId: "driver" },
      { index: 2, name: "job", opencodeSessionId: "child1" },
      { index: 3, name: "other", opencodeSessionId: "other" },
    ]),
  ];
  const base = { status: "running", parentSessionID: "old", childSessionID: "child1" };

  it("computeJobNesting nests under the display parent when the real parent has no window", () => {
    const r = computeJobNesting(projects[0], { j: { ...base, displayParentID: "driver" } });
    expect(r.children.get(1)).toEqual([2]);
    expect([...r.hidden]).toEqual([2]);
  });

  it("computeJobNesting prefers the display parent even when the real parent also has a window", () => {
    const r = computeJobNesting(projects[0], { j: { ...base, parentSessionID: "other", displayParentID: "driver" } });
    expect(r.children.get(1)).toEqual([2]);
    expect(r.children.has(3)).toBe(false);
  });

  it("computeJobNesting lifts a row whose parent is itself a nested row to the top-level ancestor", () => {
    const proj = mkProject("p", [
      { index: 1, name: "orch", opencodeSessionId: "orch" },
      { index: 2, name: "a", opencodeSessionId: "a" },
      { index: 3, name: "b", opencodeSessionId: "b" },
    ]);
    const r = computeJobNesting(proj, {
      a: { status: "running", parentSessionID: "orch", childSessionID: "a" },
      b: { status: "running", parentSessionID: "x", displayParentID: "a", childSessionID: "b" },
    });
    expect(r.children.get(1)).toEqual([2, 3]);
    expect(r.children.has(2)).toBe(false);
    expect([...r.hidden].sort()).toEqual([2, 3]);
  });

  it("computeJobNesting leaves a parent cycle top-level instead of hiding it", () => {
    const proj = mkProject("p", [
      { index: 1, name: "a", opencodeSessionId: "a" },
      { index: 2, name: "b", opencodeSessionId: "b" },
    ]);
    const r = computeJobNesting(proj, {
      a: { status: "running", parentSessionID: "b", childSessionID: "a" },
      b: { status: "running", parentSessionID: "a", childSessionID: "b" },
    });
    expect(r.hidden.size).toBe(0);
  });

  it("falls back to parentSessionID without a display parent (absent or null)", () => {
    expect(computeJobNesting(projects[0], { j: { ...base, parentSessionID: "other" } }).children.get(3)).toEqual([2]);
    expect(computeJobNesting(projects[0], { j: { ...base, parentSessionID: "other", displayParentID: null } }).children.get(3)).toEqual([2]);
    expect(computeJobNesting(projects[0], { j: base }).children.size).toBe(0); // windowless real parent → top-level
  });

  it("sessionsWithActiveWork rolls a running job up to its display parent, not the windowless real parent", () => {
    const withDisplay = sessionsWithActiveWork([], { child1: "old" }, { j: { ...base, displayParentID: "driver" } });
    expect([...withDisplay].sort()).toEqual(["child1", "driver"]);
    const without = sessionsWithActiveWork([], { child1: "old" }, { j: base });
    expect([...without].sort()).toEqual(["child1", "old"]);
  });
});

describe("superseded jobs are invisible to the sidebar inputs", () => {
  const projects = [
    mkProject("p", [
      { index: 1, name: "parent", opencodeSessionId: "parent" },
      { index: 2, name: "job", opencodeSessionId: "child1" },
    ]),
  ];
  const old = { status: "done", parentSessionID: "parent", childSessionID: "child1", supersededBy: "next" };
  const live = { status: "running", parentSessionID: "parent", childSessionID: "child1" };

  it("computeJobNesting ignores a superseded record but nests the live one", () => {
    expect(computeJobNesting(projects[0], { old }).children.size).toBe(0);
    expect(computeJobNesting(projects[0], { old, live }).children.get(1)).toEqual([2]);
  });

  it("sessionsWithActiveWork ignores a superseded running record", () => {
    expect(sessionsWithActiveWork([], {}, { old: { ...old, status: "running" } }).size).toBe(0);
    expect([...sessionsWithActiveWork([], {}, { live })].sort()).toEqual(["child1", "parent"]);
  });

  it("shouldResyncWindowsForJobs does not chase a superseded record's window", () => {
    expect(shouldResyncWindowsForJobs(projects, { old })).toBe(false);
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

describe("sessionsWithActiveWork", () => {
  it("includes running sessions and every ancestor", () => {
    const out = sessionsWithActiveWork(["grandchild"], { grandchild: "child", child: "root" }, {});
    expect([...out].sort()).toEqual(["child", "grandchild", "root"]);
  });

  it("is empty when nothing runs", () => {
    expect(sessionsWithActiveWork([], { c: "p" }, {}).size).toBe(0);
  });

  it("a running background job marks its child and its parent", () => {
    const out = sessionsWithActiveWork([], {}, {
      j: { status: "running", parentSessionID: "parent", childSessionID: "jobChild" },
    });
    expect(out.has("jobChild")).toBe(true);
    expect(out.has("parent")).toBe(true);
  });

  it("finished jobs do not count", () => {
    const out = sessionsWithActiveWork([], {}, {
      j: { status: "done", parentSessionID: "parent", childSessionID: "jobChild" },
    });
    expect(out.size).toBe(0);
  });

  it("a mid-start job (no child yet) keeps the parent busy", () => {
    const out = sessionsWithActiveWork([], {}, {
      j: { status: "running", parentSessionID: "parent", childSessionID: null },
    });
    expect([...out]).toEqual(["parent"]);
  });

  it("terminates on a parent cycle", () => {
    const out = sessionsWithActiveWork(["a"], { a: "b", b: "a" }, {});
    expect([...out].sort()).toEqual(["a", "b"]);
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

// ===== resolvePlanToggle =====

describe("resolvePlanToggle", () => {
  const A = (name: string, mode?: string): OpencodeAgent =>
    ({ name, mode } as OpencodeAgent);

  it("null agents → loading, unavailable, carries the requested on state", () => {
    expect(resolvePlanToggle(null, true)).toMatchObject({
      available: false,
      on: true,
      loading: true,
    });
    expect(resolvePlanToggle(null, false).loading).toBe(true);
  });

  it("no plan agent → unavailable, off", () => {
    const r = resolvePlanToggle([A("build", "primary"), A("x", "subagent")], false);
    expect(r).toMatchObject({ available: false, on: false });
    expect(r.title).toContain("no plan agent");
  });

  it("no plan agent but on → unavailable but stays lit (honest frozen control)", () => {
    const r = resolvePlanToggle([A("build", "primary")], true);
    expect(r).toMatchObject({ available: false, on: true });
    expect(r.title).toContain("Plan mode on");
  });

  it("plan agent → available, off, agent resolved", () => {
    const r = resolvePlanToggle([A("build", "primary"), A("plan", "primary")], false);
    expect(r).toMatchObject({ available: true, on: false, agent: "plan" });
  });

  it("plan agent → available, on", () => {
    const r = resolvePlanToggle([A("plan", "primary")], true);
    expect(r).toMatchObject({ available: true, on: true, agent: "plan" });
  });

  it("a plan agent that is a subagent does not count", () => {
    const r = resolvePlanToggle([A("plan", "subagent")], false);
    expect(r.available).toBe(false);
  });
});

describe("resolvePlanToggle — agent preference", () => {
  const A = (name: string, mode?: string): OpencodeAgent =>
    ({ name, mode } as OpencodeAgent);

  it("both plan and manta-plan present → prefers manta-plan", () => {
    const r = resolvePlanToggle(
      [A("plan", "primary"), A("manta-plan", "primary")],
      false,
    );
    expect(r.agent).toBe("manta-plan");
  });

  it("only plan present → falls back to plan", () => {
    const r = resolvePlanToggle([A("plan", "primary")], false);
    expect(r.agent).toBe("plan");
  });

  it("only manta-plan present → selects manta-plan", () => {
    const r = resolvePlanToggle([A("manta-plan", "primary")], false);
    expect(r.agent).toBe("manta-plan");
  });

  it("neither present / only subagents → unavailable", () => {
    const r = resolvePlanToggle(
      [A("build", "primary"), A("manta-plan", "subagent")],
      false,
    );
    expect(r.available).toBe(false);
  });

  it("a manta-plan subagent is not picked; primary plan is preferred", () => {
    const r = resolvePlanToggle(
      [A("plan", "primary"), A("manta-plan", "subagent")],
      false,
    );
    expect(r.agent).toBe("plan");
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

// The box stamps `tone` on every window it publishes (WS09 SF-M18,
// src/server/usageWindowView.mjs); mirror that here so fixtures look like a
// real snapshot. An explicit `tone` (or `tone: undefined`) on a window wins.
const boxTone = (pct: number): "under" | "warn" | "danger" | "over" =>
  pct >= 100 ? "over" : pct >= 90 ? "danger" : pct >= 70 ? "warn" : "under";

function usageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const snap: UsageSnapshot = {
    provider: "claude",
    providerIDs: ["anthropic"],
    windows: [{ kind: "session", label: "Session (5h)", pct: 42 }],
    fetchedAt: 1_000_000,
    ...overrides,
  };
  return { ...snap, windows: snap.windows.map((w) => ({ tone: boxTone(w.pct), ...w })) };
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
  it("a window with no box tone (an older box) reports tone null — no colour is invented", () => {
    const snap = usageSnapshot({ windows: [{ kind: "session", label: "5h", pct: 95, tone: undefined }] });
    expect(usageDialState(snap, false).tone).toBeNull();
  });

  it("an inactive window never drives visibility or the reported window", () => {
    const snap = usageSnapshot({
      windows: [
        { kind: "session", label: "5h", pct: 10 },
        { kind: "weekly_scoped:fable", label: "7d · Fable", pct: 100, scope: "Fable", active: false },
      ],
    });
    const state = usageDialState(snap, false);
    expect(state.visible).toBe(false);
    expect(state.window?.kind).toBe("session");
    expect(state.tone).toBe("under");
  });

  it("an ACTIVE scoped window still counts toward visibility", () => {
    const snap = usageSnapshot({
      windows: [
        { kind: "session", label: "5h", pct: 10 },
        { kind: "weekly_scoped:fable", label: "7d · Fable", pct: 95, scope: "Fable" },
      ],
    });
    expect(usageDialState(snap, false).visible).toBe(true);
  });

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
      awaitingReset: false,
      window: null,
    });
  });

  it("a null snapshot is not visible", () => {
    expect(usageDialState(null, true).visible).toBe(false);
    expect(usageDialState(undefined, true).visible).toBe(false);
  });

  it("a waiting primary keeps its own window, reports no value, and holds its place", () => {
    const snap = usageSnapshot({ windows: [
      { kind: "session", label: "Session (5h)", pct: 100, stale: true },
      { kind: "weekly", label: "Weekly", pct: 45 },
    ] });
    const st = usageDialState(snap, false);
    expect(st.awaitingReset).toBe(true);
    expect(st.window?.kind).toBe("session"); // never switches to the weekly window
    expect(st.pct).toBe(0);
    expect(st.tone).toBe("under");
    expect(st.visible).toBe(true);           // stays on screen rather than vanishing
  });

  it("a live primary is untouched", () => {
    const st = usageDialState(usageSnapshot({ windows: [{ kind: "session", label: "S", pct: 95 }] }), false);
    expect(st.awaitingReset).toBe(false);
    expect(st.pct).toBe(95);
    expect(st.tone).toBe("danger");
  });

  it("a waiting NON-primary window does not blank the primary", () => {
    const snap = usageSnapshot({ windows: [
      { kind: "session", label: "S", pct: 80 },
      { kind: "weekly", label: "W", pct: 99, stale: true },
    ] });
    const st = usageDialState(snap, false);
    expect(st.awaitingReset).toBe(false);
    expect(st.pct).toBe(80);
  });
});

describe("formatTimerDuration", () => {
  it("renders the canonical compact ladder with no spaces", () => {
    expect(formatTimerDuration(45_000)).toBe("45s");
    expect(formatTimerDuration(59_000)).toBe("59s");
    expect(formatTimerDuration(60_000)).toBe("1m");
    expect(formatTimerDuration(57 * 60_000)).toBe("57m");
    expect(formatTimerDuration(2 * 3_600_000 + 10 * 60_000)).toBe("2h10m");
    expect(formatTimerDuration(2 * 3_600_000 + 57 * 60_000)).toBe("2h57m");
    expect(formatTimerDuration(3 * 3_600_000)).toBe("3h");
  });

  it("drops minutes when zero and handles sub-second and non-finite", () => {
    expect(formatTimerDuration(3 * 3_600_000)).toBe("3h");
    expect(formatTimerDuration(0)).toBe("0s");
    expect(formatTimerDuration(-5)).toBe("0s");
    expect(formatTimerDuration(NaN)).toBe("0s");
    expect(formatTimerDuration(999)).toBe("1s");
  });
});

describe("formatResetDistance", () => {
  it("covers the whole ladder with exact strings", () => {
    expect(formatResetDistance(30_000)).toBe("under a minute");
    expect(formatResetDistance(45 * 60_000)).toBe("45m");
    expect(formatResetDistance(2 * 3_600_000 + 10 * 60_000)).toBe("2h10m");
    expect(formatResetDistance(3 * 3_600_000)).toBe("3h"); // drop the zero minutes
    expect(formatResetDistance(26 * 3_600_000)).toBe("1d2h");
    expect(formatResetDistance(48 * 3_600_000)).toBe("2d"); // drop the zero hours
    expect(formatResetDistance(140 * 3_600_000 + 12 * 60_000)).toBe("5d20h");
  });

  it("returns 'now' for a missing, non-finite, or past distance", () => {
    expect(formatResetDistance(NaN)).toBe("now");
    expect(formatResetDistance(Infinity)).toBe("now");
    expect(formatResetDistance(0)).toBe("now");
    expect(formatResetDistance(-5)).toBe("now");
  });
});

describe("formatResetAt", () => {
  // Fixture built with local-time arithmetic so the same-day / cross-day
  // boundary is deterministic regardless of timezone or locale. Assert SHAPE
  // only — exact Intl output differs across machines.
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime(); // local noon

  it("returns '' for a missing or non-finite timestamp", () => {
    expect(formatResetAt(undefined, now)).toBe("");
    expect(formatResetAt(null, now)).toBe("");
    expect(formatResetAt(NaN, now)).toBe("");
  });

  it("renders time-only on the same local day", () => {
    const sameDay = now + 2 * 3_600_000;
    expect(formatResetAt(sameDay, now)).not.toBe("");
    expect(formatResetAt(sameDay, now)).not.toContain(",");
  });

  it("adds a weekday for a cross-day reset within a week", () => {
    const r = formatResetAt(now + 5 * 86_400_000, now);
    expect(r).not.toBe("");
    expect(r).not.toBe(formatResetAt(now + 2 * 3_600_000, now));
    expect(r).not.toContain("2026");
  });

  it("adds the full date for a reset a week or more out", () => {
    const r = formatResetAt(now + 8 * 86_400_000, now);
    expect(r).not.toBe("");
    expect(r).toContain(","); // weekday + month/day separator
    expect(r).not.toBe(formatResetAt(now + 5 * 86_400_000, now));
  });
});

describe("formatWindowReset", () => {
  // Local-time fixtures (see formatResetAt): same-day vs cross-day is
  // deterministic across timezones. Assert SHAPE, not exact Intl output.
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime(); // local noon

  it("renders a same-day reset without an absolute anchor", () => {
    const resetsAt = now + 2 * 3_600_000;
    const line = formatWindowReset(resetsAt, now);
    expect(line).toMatch(/^resets in /);
    expect(line).toContain(formatResetDistance(resetsAt - now));
    expect(line).not.toContain("(");
  });

  it("appends the absolute anchor for a cross-day reset", () => {
    const resetsAt = now + 5 * 86_400_000;
    const line = formatWindowReset(resetsAt, now);
    expect(line).toMatch(/^resets in /);
    expect(line).toContain(formatResetDistance(resetsAt - now));
    expect(line).toContain("(");
    expect(line).toContain(")");
  });

  it("returns null for a missing or non-finite timestamp", () => {
    expect(formatWindowReset(null, now)).toBeNull();
    expect(formatWindowReset(undefined, now)).toBeNull();
    expect(formatWindowReset(NaN, now)).toBeNull();
  });

  it("returns 'resetting…' once the reset instant has passed", () => {
    expect(formatWindowReset(now - 1, now)).toBe("resetting…");
    expect(formatWindowReset(now, now)).toBe("resetting…");
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

  it("usageStale flips at exactly 25 minutes", () => {
    expect(usageStale(0, 25 * 60_000)).toBe(false);
    expect(usageStale(0, 25 * 60_000 + 1)).toBe(true);
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
  const management = (id: string, order: number) => ({ id, tier: "management" as const, order });

  it("returns an empty result for no cards", () => {
    expect(arrangeCards([])).toEqual({
      blocking: null,
      blockingMore: 0,
      ambient: [],
      ambientRollup: [],
      management: [],
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

  it("a management card lands in management, not ambient/rollup", () => {
    const r = arrangeCards([ambient("retry", 7), management("schedules", 3)]);
    expect(r.management.map((c) => c.id)).toEqual(["schedules"]);
    expect(r.ambient.map((c) => c.id)).toEqual(["retry"]);
    expect(r.ambientRollup).toEqual([]);
  });

  it("a management card does not consume ambient expanded slots", () => {
    const r = arrangeCards([
      management("secrets", 2),
      ambient("retry", 7),
      ambient("compaction", 6),
      ambient("send-error", 5),
      ambient("queued", 4),
    ]);
    expect(r.ambient.length).toBe(2);
    expect(r.ambientRollup.length).toBe(2);
    expect(r.management.map((c) => c.id)).toEqual(["secrets"]);
  });

  it("management ordering (highest order first) is independent of input order", () => {
    const r = arrangeCards([
      management("webhooks", 1),
      management("schedules", 3),
      management("secrets", 2),
    ]);
    expect(r.management.map((c) => c.id)).toEqual(["schedules", "secrets", "webhooks"]);
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

  it("renders a no-remote repo under the home dir as ~/… per the mockup", () => {
    expect(
      describeRepoRow(
        repoRow({ branch: "main", originUrl: null, path: "/home/u/scratch", repoKey: null, forge: null }),
        "/home/u",
      ),
    ).toBe("⎇ main · ~/scratch · no remote");
  });

  it("leaves a path outside the home dir absolute even when homeDir is given", () => {
    expect(
      describeRepoRow(
        repoRow({ branch: "main", originUrl: null, path: "/opt/other/scratch", repoKey: null, forge: null }),
        "/home/u",
      ),
    ).toBe("⎇ main · /opt/other/scratch · no remote");
  });

  it("renders the home dir itself as ~", () => {
    expect(homeRelativePath("/home/u", "/home/u")).toBe("~");
  });

  it("returns the raw path when no homeDir is available", () => {
    expect(homeRelativePath("/home/u/scratch", null)).toBe("/home/u/scratch");
  });

  it("handles a trailing-slash homeDir", () => {
    expect(homeRelativePath("/home/u/scratch", "/home/u/")).toBe("~/scratch");
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

// ===== shouldOfferForgeConnect (BET-789) =====

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


describe("workingIndicatorLabel (BET-791)", () => {
  const base = {
    fallbackVerb: "Ruminating",
    elapsed: "4m 12s",
    tokens: 18_000, // formatTokens → "18k tokens"
  };

  it("no progress record — byte-identical to today", () => {
    expect(workingIndicatorLabel({ progress: null, ...base })).toBe(
      "Ruminating… · 4m 12s · 18k tokens",
    );
  });

  it("emits no token segment when tokens is 0", () => {
    expect(
      workingIndicatorLabel({ progress: null, fallbackVerb: "Ruminating", elapsed: "4m 12s", tokens: 0 }),
    ).toBe("Ruminating… · 4m 12s");
  });

  it("working record with label only — no counter (indeterminate)", () => {
    expect(
      workingIndicatorLabel({
        progress: { sessionID: "s1", label: "Running integration tests", step: null, total: null, state: "working", detail: "", updatedAt: 0 },
        ...base,
      }),
    ).toBe("· 4m 12s · 18k tokens");
  });

  it("working record with label + step/total shows the counter", () => {
    expect(
      workingIndicatorLabel({
        progress: { sessionID: "s1", label: "Running integration tests", step: 3, total: 5, state: "working", detail: "", updatedAt: 0 },
        ...base,
      }),
    ).toBe("· 3/5 · 4m 12s · 18k tokens");
  });

  it("step present but total missing — NO counter (never 3/?)", () => {
    expect(
      workingIndicatorLabel({
        progress: { sessionID: "s1", label: "Running integration tests", step: 3, total: null, state: "working", detail: "", updatedAt: 0 },
        ...base,
      }),
    ).toBe("· 4m 12s · 18k tokens");
  });

  it("blocked — the indicator yields to the card (generic line)", () => {
    expect(
      workingIndicatorLabel({
        progress: { sessionID: "s1", label: "Running integration tests", step: 3, total: 5, state: "blocked", detail: "decide", updatedAt: 0 },
        ...base,
      }),
    ).toBe("Ruminating… · 4m 12s · 18k tokens");
  });

  it("done/failed — no indicator treatment either (the turn ending is visible)", () => {
    expect(
      workingIndicatorLabel({
        progress: { sessionID: "s1", label: "Running integration tests", step: 5, total: 5, state: "done", detail: "", updatedAt: 0 },
        ...base,
      }),
    ).toBe("Ruminating… · 4m 12s · 18k tokens");
    expect(
      workingIndicatorLabel({
        progress: { sessionID: "s1", label: "Running integration tests", step: 5, total: 5, state: "failed", detail: "", updatedAt: 0 },
        ...base,
      }),
    ).toBe("Ruminating… · 4m 12s · 18k tokens");
  });
});

describe("progressAttentionKind (BET-791)", () => {
  it("only blocked lights an attention kind", () => {
    expect(progressAttentionKind("blocked")).toBe("blocked");
    expect(progressAttentionKind("working")).toBeNull();
    expect(progressAttentionKind("done")).toBeNull();
    expect(progressAttentionKind("failed")).toBeNull();
    expect(progressAttentionKind(null)).toBeNull();
    expect(progressAttentionKind(undefined)).toBeNull();
  });
});

// ===== buildVoiceNoteMap (BET-837) =====

function umsg(id: string, text: string): OpencodeMessage {
  return {
    info: { id, role: "user" } as OpencodeMessage["info"],
    parts: [
      {
        id: `p-${id}`,
        type: "text",
        text,
        synthetic: false,
        ignored: false,
      } as OpencodeMessage["parts"][number],
    ],
  } as OpencodeMessage;
}

function vnote(id: string, transcript: string, extra: Partial<VoiceNoteRecord> = {}): VoiceNoteRecord {
  return {
    id,
    sessionId: "ses_1",
    transcript,
    mime: "audio/webm",
    durationMs: 1000,
    peaks: new Uint8Array([128, 64]),
    createdAt: 0,
    expiresAt: null,
    audioAvailable: true,
    ...extra,
  };
}

describe("buildVoiceNoteMap (BET-837)", () => {
  it("matches a note's transcript to the message whose text equals it", () => {
    const messages = [umsg("m1", "hello world")];
    const notes = [vnote("n1", "hello world")];
    const map = buildVoiceNoteMap(messages, notes);
    expect(map.get("m1")?.id).toBe("n1");
    expect(map.size).toBe(1);
  });

  it("no match when the text differs", () => {
    const messages = [umsg("m1", "hello world")];
    const notes = [vnote("n1", "something else")];
    expect(buildVoiceNoteMap(messages, notes).size).toBe(0);
  });

  it("claims in order: duplicate transcripts claimed oldest→newest by message", () => {
    const messages = [
      umsg("m1", "repeat"),
      umsg("m2", "repeat"),
      umsg("m3", "repeat"),
    ];
    const notes = [vnote("n1", "repeat"), vnote("n2", "repeat")];
    const map = buildVoiceNoteMap(messages, notes);
    expect(map.get("m1")?.id).toBe("n1");
    expect(map.get("m2")?.id).toBe("n2");
    expect(map.has("m3")).toBe(false);
  });

  it("claims the FIRST unclaimed user message, oldest→newest", () => {
    const messages = [
      umsg("m1", "a"),
      umsg("m2", "b"),
      umsg("m3", "c"),
    ];
    const notes = [vnote("n1", "c")]; // matches only the NEWEST message
    const map = buildVoiceNoteMap(messages, notes);
    expect(map.get("m3")?.id).toBe("n1");
  });

  it("skips notes with an empty transcript", () => {
    const messages = [umsg("m1", "x")];
    const notes = [vnote("n1", "   "), vnote("n2", "x")];
    const map = buildVoiceNoteMap(messages, notes);
    expect(map.get("m1")?.id).toBe("n2");
  });

  it("does not double-claim: a note is used once even if two messages match", () => {
    const messages = [umsg("m1", "x"), umsg("m2", "x")];
    const notes = [vnote("n1", "x")];
    const map = buildVoiceNoteMap(messages, notes);
    expect(map.get("m1")?.id).toBe("n1");
    expect(map.has("m2")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty map for an empty notes list", () => {
    const messages = [umsg("m1", "hello")];
    expect(buildVoiceNoteMap(messages, []).size).toBe(0);
    expect(buildVoiceNoteMap(messages, null).size).toBe(0);
    expect(buildVoiceNoteMap(null, [vnote("n1", "x")]).size).toBe(0);
  });

  it("assigns each note to the oldest unclaimed matching message (newest-first notes are matched in list order)", () => {
    const messages = [umsg("m1", "first"), umsg("m2", "second")];
    // Two notes matching different messages must not collide.
    const notes = [vnote("n1", "second"), vnote("n2", "first")];
    const map = buildVoiceNoteMap(messages, notes);
    expect(map.get("m1")?.id).toBe("n2");
    expect(map.get("m2")?.id).toBe("n1");
  });

  it("only claims USER messages", () => {
    const assistant = {
      info: { id: "a1", role: "assistant" } as OpencodeMessage["info"],
      parts: [],
    } as OpencodeMessage;
    const messages = [umsg("m1", "hello"), assistant];
    const notes = [vnote("n1", "hello")];
    expect(buildVoiceNoteMap(messages, notes).get("m1")?.id).toBe("n1");
  });

  it("uses concatenated text parts (newline-joined), matching MessageRow text", () => {
    const msg = {
      info: { id: "m1", role: "user" } as OpencodeMessage["info"],
      parts: [
        { id: "p1", type: "text", text: "line one", synthetic: false, ignored: false } as OpencodeMessage["parts"][number],
        { id: "p2", type: "text", text: "line two", synthetic: false, ignored: false } as OpencodeMessage["parts"][number],
      ],
    } as OpencodeMessage;
    expect(concatUserMessageText(msg)).toBe("line one\nline two");
    const map = buildVoiceNoteMap([msg], [vnote("n1", "line one\nline two")]);
    expect(map.get("m1")?.id).toBe("n1");  });
});

describe("dispatchAppControl (BET-841)", () => {
  it("routes switch-model to the handler with the resolved model", () => {
    const switchModel = vi.fn();
    const renameSession = vi.fn();
    dispatchAppControl(
      { action: "switch-model", sessionId: "ses_1", providerID: "anthropic", modelID: "claude-opus-4-7" },
      { switchModel, renameSession },
    );
    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(switchModel).toHaveBeenCalledWith({
      sessionId: "ses_1",
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
    });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("does not fire switch-model when required fields are missing", () => {
    const switchModel = vi.fn();
    dispatchAppControl(
      { action: "switch-model", sessionId: "ses_1", providerID: "anthropic" },
      { switchModel },
    );
    dispatchAppControl({ action: "switch-model" }, { switchModel });
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("routes rename-session to the handler with the new name", () => {
    const renameSession = vi.fn();
    dispatchAppControl(
      { action: "rename-session", sessionId: "ses_1", name: "my session" },
      { renameSession },
    );
    expect(renameSession).toHaveBeenCalledTimes(1);
    expect(renameSession).toHaveBeenCalledWith({
      sessionId: "ses_1",
      name: "my session",
    });
  });

  it("no-ops for compact-session", () => {
    const switchModel = vi.fn();
    const renameSession = vi.fn();
    dispatchAppControl(
      { action: "compact-session", sessionId: "ses_1" },
      { switchModel, renameSession },
    );
    expect(switchModel).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("ignores unknown actions and non-object payloads silently", () => {
    const switchModel = vi.fn();
    const renameSession = vi.fn();
    dispatchAppControl({ action: "future-action" }, { switchModel, renameSession });
    dispatchAppControl(null, { switchModel, renameSession });
    dispatchAppControl("nope", { switchModel, renameSession });
    dispatchAppControl(undefined, { switchModel, renameSession });
    expect(switchModel).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });
});

describe("scrollElementToTail", () => {
  it("does not throw on a null element", () => {
    expect(() => scrollElementToTail(null)).not.toThrow();
  });

  it("sets scrollTop to the element's scrollHeight", () => {
    const el = { scrollTop: 5, scrollHeight: 4242 } as HTMLElement;
    scrollElementToTail(el);
    expect(el.scrollTop).toBe(4242);
  });
});

describe("classifyFollowOnScroll", () => {
  it("is following at the exact bottom (distance 0)", () => {
    // scrollHeight - scrollTop - clientHeight === 0
    expect(classifyFollowOnScroll({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, 600, false))
      .toBe(true);
  });

  it("is following when distance equals FOLLOW_THRESHOLD_PX (inclusive boundary)", () => {
    expect(
      classifyFollowOnScroll(
        { scrollTop: 1000 - FOLLOW_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 0 },
        500,
        false,
      ),
    ).toBe(true);
  });

  it("is null (no decision) when away from the bottom but scrollTop increased", () => {
    // Scrolling down through history must not toggle anything.
    expect(
      classifyFollowOnScroll({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 }, 500, true),
    ).toBe(null);
  });

  it("is false (stop following) when the USER scrolled up away from the bottom", () => {
    expect(
      classifyFollowOnScroll({ scrollTop: 300, scrollHeight: 1000, clientHeight: 100 }, 500, true),
    ).toBe(false);
  });

  it("REGRESSION: content growth must not detach the transcript", () => {
    // scrollHeight grew a lot, scrollTop unchanged, distance far past the
    // threshold -> scrollTop did NOT decrease, so the event is `null`. This
    // is the bug: a growing tool card must never detach the transcript.
    expect(
      classifyFollowOnScroll({ scrollTop: 500, scrollHeight: 2000, clientHeight: 100 }, 500, true),
    ).toBe(null);
  });

  it("REGRESSION: a scroll-up with no user gesture must not detach the transcript", () => {
    // Virtuoso's upward-scrolling compensation after re-measuring a row that a
    // tool card just grew: scrollTop moves UP, far from the bottom, with no
    // input event anywhere near it. Identical numbers to the user case above —
    // the intent flag is the ONLY thing that separates them.
    expect(
      classifyFollowOnScroll({ scrollTop: 300, scrollHeight: 1000, clientHeight: 100 }, 500, false),
    ).toBe(null);
  });

  it("is following when the scroller clamped scrollTop down but lands at the bottom", () => {
    // The transcript shrank so the browser clamped scrollTop down; the result
    // is at the bottom, so following wins (bottom check evaluated first).
    expect(
      classifyFollowOnScroll({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }, 999999, false),
    ).toBe(true);
  });

  it("re-attaches on a user scroll back down to the bottom", () => {
    expect(
      classifyFollowOnScroll({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }, 300, true),
    ).toBe(true);
  });
});

describe("follow: only when all the way down", () => {
  it("REGRESSION: a small scroll-up near the bottom is NOT re-attached (a slow trackpad gesture)", () => {
    // 20px above the bottom after a user gesture: was inside the old 64px band
    // and re-attached, so the next streamed delta yanked the user back down.
    expect(
      classifyFollowOnScroll({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 }, 900, true),
    ).toBe(false);
  });

  it("isUpwardScrollGesture: wheel up / PageUp / ArrowUp / Home / finger dragging down count; down gestures don't", () => {
    const m = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
    expect(isUpwardScrollGesture({ type: "wheel", deltaY: -3 }, m)).toBe(true);
    expect(isUpwardScrollGesture({ type: "wheel", deltaY: 3 }, m)).toBe(false);
    expect(isUpwardScrollGesture({ type: "keydown", key: "PageUp" }, m)).toBe(true);
    expect(isUpwardScrollGesture({ type: "keydown", key: "ArrowUp" }, m)).toBe(true);
    expect(isUpwardScrollGesture({ type: "keydown", key: "Home" }, m)).toBe(true);
    expect(isUpwardScrollGesture({ type: "keydown", key: "PageDown" }, m)).toBe(false);
    expect(isUpwardScrollGesture({ type: "touchmove" }, m, 12)).toBe(true);
    expect(isUpwardScrollGesture({ type: "touchmove" }, m, -12)).toBe(false);
  });

  it("isUpwardScrollGesture: nothing counts when the transcript can't scroll", () => {
    expect(isUpwardScrollGesture({ type: "wheel", deltaY: -100 }, { scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toBe(false);
  });
});

describe("user scroll intent", () => {
  it("is absent on a fresh tracker", () => {
    expect(hasUserScrollIntent(createUserScrollIntent(), 1_000_000)).toBe(false);
  });

  it("holds for the window after an input event, then lapses", () => {
    const intent = createUserScrollIntent();
    intent.lastInputAt = 1_000;
    expect(hasUserScrollIntent(intent, 1_000 + USER_SCROLL_INTENT_WINDOW_MS)).toBe(true);
    expect(hasUserScrollIntent(intent, 1_000 + USER_SCROLL_INTENT_WINDOW_MS + 1)).toBe(false);
  });

  it("holds indefinitely while a pointer button is down", () => {
    // A slow scrollbar drag can outlast the window; the flag, not the
    // timestamp, is what covers it.
    const intent = createUserScrollIntent();
    intent.pointerDown = true;
    expect(hasUserScrollIntent(intent, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("grants the trailing window to a press that actually scrolled", () => {
    // A quick click in the scrollbar track can release before its later scroll
    // events land, so the release has to vouch for them.
    const intent = createUserScrollIntent();
    intent.pointerDown = true;
    intent.pointerScrolled = true;
    releaseUserScrollIntent(intent, 5_000);
    expect(intent.pointerDown).toBe(false);
    expect(hasUserScrollIntent(intent, 5_000 + USER_SCROLL_INTENT_WINDOW_MS)).toBe(true);
  });

  it("REGRESSION: a press that never scrolled grants nothing on release", () => {
    // Clicking a tool card open re-measures its row and Virtuoso compensates a
    // few ms later. If the click earned a window, that compensation would look
    // like a user scroll-up — the same bug from the other side.
    const intent = createUserScrollIntent();
    intent.pointerDown = true;
    releaseUserScrollIntent(intent, 5_000);
    expect(intent.pointerDown).toBe(false);
    expect(hasUserScrollIntent(intent, 5_001)).toBe(false);
  });
});

describe("isPlanExitQuestion", () => {
  const planq = (callID?: string): QuestionRequest =>
    ({
      id: "q1",
      sessionID: "s1",
      questions: [],
      tool: callID ? { messageID: "m1", callID } : undefined,
    }) as QuestionRequest;

  const part = (tool: string, callID: string) =>
    ({ type: "tool", id: "p", messageID: "m1", tool, callID });

  it("true when a transcript tool part named plan_exit carries the question's callID", () => {
    const msg: OpencodeMessage = {
      info: {} as never,
      parts: [
        part("read", "call-read"),
        part("plan_exit", "call-exit"),
      ],
    };
    expect(isPlanExitQuestion(planq("call-exit"), [msg])).toBe(true);
  });

  it("false when the matching callID belongs to a DIFFERENT tool", () => {
    const msg: OpencodeMessage = { info: {} as never, parts: [part("edit", "call-exit")] };
    expect(isPlanExitQuestion(planq("call-exit"), [msg])).toBe(false);
  });

  it("false for an ordinary question with no tool call", () => {
    expect(isPlanExitQuestion(planq(undefined), null)).toBe(false);
  });

  it("false when no part matches the callID even if a plan_exit part exists", () => {
    const msg: OpencodeMessage = { info: {} as never, parts: [part("plan_exit", "other")] };
    expect(isPlanExitQuestion(planq("call-exit"), [msg])).toBe(false);
  });

  it("matches a nested state.input.tool shape (reconciled transcript part)", () => {
    const msg: OpencodeMessage = {
      info: {} as never,
      parts: [
        {
          type: "tool",
          id: "p",
          messageID: "m1",
          callID: "call-exit",
          state: { status: "completed", input: { tool: "plan_exit", planPath: "/x/plan.md" } },
        },
      ],
    };
    expect(isPlanExitQuestion(planq("call-exit"), [msg])).toBe(true);
  });
});

describe("extractPlanData", () => {
  const planq = (callID: string): QuestionRequest =>
    ({ id: "q1", sessionID: "s1", questions: [], tool: { messageID: "m1", callID } }) as QuestionRequest;

  it("title from first heading + the plan text from the tool input", () => {
    const msg: OpencodeMessage = {
      info: {} as never,
      parts: [
        {
          type: "tool",
          id: "p",
          messageID: "m1",
          callID: "call-exit",
          state: { status: "completed", input: { tool: "plan_exit", plan: "# Add login\n## Step 1\n- `src/a.ts`" } },
        },
      ],
    };
    const d = extractPlanData(planq("call-exit"), [msg]);
    expect(d.title).toBe("Add login");
    expect(d.text).toContain("## Step 1");
  });

  it("falls back to the question header when no plan text is present", () => {
    const q = planq("call-exit");
    q.questions = [{ question: "Plan at /p is complete. Would you like to switch?", header: "Build Agent", options: [] }];
    const d = extractPlanData(q, []);
    expect(d.title).toBe("Build Agent");
    expect(d.text).toBe("");
  });
});

describe("resolveDelegateModel", () => {
  const sel = (providerID: string, modelID: string): import("./chatShared").ModelSelection =>
    ({ providerID, modelID });
  const groups = (ids: Array<[string, string]>): Array<[string, OpencodeModel[]]> =>
    [...new Set(ids.map(([p]) => p))].map((p) => [
      p,
      ids.filter(([pp]) => pp === p).map(([, id]) => ({ id, providerID: p, name: id }) as OpencodeModel),
    ]);

  it("level 1: an explicit pick wins while open", () => {
    const r = resolveDelegateModel({
      picked: sel("anthropic", "opus"),
      remembered: sel("anthropic", "sonnet"),
      sessionModel: sel("anthropic", "haiku"),
      selectable: groups([["anthropic", "opus"], ["anthropic", "sonnet"], ["anthropic", "haiku"]]),
    });
    expect(r.model).toEqual(sel("anthropic", "opus"));
    expect(r.overridden).toBe(true);
  });

  it("level 2: the remembered override is used when no explicit pick", () => {
    const r = resolveDelegateModel({
      picked: null,
      remembered: sel("anthropic", "sonnet"),
      sessionModel: sel("anthropic", "haiku"),
      selectable: groups([["anthropic", "sonnet"], ["anthropic", "haiku"]]),
    });
    expect(r.model).toEqual(sel("anthropic", "sonnet"));
    expect(r.overridden).toBe(true);
  });

  it("level 3: falls through to the build/session model when neither pick nor remember", () => {
    const r = resolveDelegateModel({
      picked: null,
      remembered: null,
      sessionModel: sel("anthropic", "haiku"),
      selectable: groups([["anthropic", "haiku"]]),
    });
    expect(r.model).toEqual(sel("anthropic", "haiku"));
    expect(r.overridden).toBe(false);
  });

  it("falls through to level 3 when the remembered model is deactivated (not selectable)", () => {
    const r = resolveDelegateModel({
      picked: null,
      remembered: sel("anthropic", "sonnet"),
      sessionModel: sel("anthropic", "haiku"),
      selectable: groups([["anthropic", "haiku"]]), // sonnet deactivated
    });
    expect(r.model).toEqual(sel("anthropic", "haiku"));
    expect(r.overridden).toBe(false);
  });

  it("keeps the remembered pick (not silently falling through) while models are still loading", () => {
    const r = resolveDelegateModel({
      picked: null,
      remembered: sel("anthropic", "sonnet"),
      sessionModel: sel("anthropic", "haiku"),
      selectable: null, // loading — cannot validate
    });
    expect(r.model).toEqual(sel("anthropic", "sonnet"));
    expect(r.overridden).toBe(true);
  });
});

// ===== deviceAuthErrorMessage (BET-1043) =====

describe("deviceAuthErrorMessage", () => {
  it('maps "expired" to the expiry copy', () => {
    expect(deviceAuthErrorMessage("expired")).toBe("The sign-in code expired. Try again.");
  });
  it('maps "not_started" to the not-started copy', () => {
    expect(deviceAuthErrorMessage("not_started")).toBe("Sign-in didn't start. Try again.");
  });
  it("falls back to the generic copy for anything else / undefined", () => {
    expect(deviceAuthErrorMessage("bad_response")).toBe("Sign-in failed. Try again.");
    expect(deviceAuthErrorMessage(undefined)).toBe("Sign-in failed. Try again.");
  });
});

// =============================================================================
// Inline media (BET-1148) — pure helpers for the transcript media renderer.
// =============================================================================
describe("resolvePreviewType video", () => {
  it("routes video/* to the video renderer instead of refuse", () => {
    expect(resolvePreviewType("video/mp4", "clip.mp4")).toBe("video");
    expect(resolvePreviewType("video/quicktime", "clip.mov")).toBe("video");
  });
});

describe("mediaKindFromMime / isMediaMime", () => {
  it("maps image/* and video/* mimes", () => {
    expect(mediaKindFromMime("image/png")).toBe("image");
    expect(mediaKindFromMime("Image/PNG")).toBe("image");
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("application/pdf")).toBeNull();
    expect(mediaKindFromMime(null)).toBeNull();
    expect(mediaKindFromMime(undefined)).toBeNull();
  });

  it("isMediaMime is true only for media mimes", () => {
    expect(isMediaMime("image/png")).toBe(true);
    expect(isMediaMime("video/webm")).toBe(true);
    expect(isMediaMime("application/pdf")).toBe(false);
    expect(isMediaMime(null)).toBe(false);
  });
});

describe("resolveMediaAspect", () => {
  it("uses explicit dimensions when both are known", () => {
    expect(resolveMediaAspect({ width: 800, height: 600, aspectRatio: null })).toBeCloseTo(4 / 3, 5);
  });

  it("falls back to the declared aspect ratio when dimensions are unknown", () => {
    expect(resolveMediaAspect({ width: null, height: null, aspectRatio: 1.5 })).toBeCloseTo(1.5, 5);
  });

  it("defaults to 16:9 when neither is known", () => {
    expect(resolveMediaAspect({ width: null, height: null, aspectRatio: null })).toBeCloseTo(16 / 9, 5);
  });

  it("ignores non-positive dimensions/ratios", () => {
    expect(resolveMediaAspect({ width: 0, height: 0, aspectRatio: null })).toBeCloseTo(16 / 9, 5);
    expect(resolveMediaAspect({ width: 100, height: 0, aspectRatio: null })).toBeCloseTo(16 / 9, 5);
  });
});

describe("mediaGrid", () => {
  it("renders a single tile for 0/1/unknown counts", () => {
    expect(mediaGrid(null)).toEqual({ tiles: 1, more: 0 });
    expect(mediaGrid(0)).toEqual({ tiles: 1, more: 0 });
    expect(mediaGrid(1)).toEqual({ tiles: 1, more: 0 });
  });

  it("caps at 4 tiles and folds the rest behind +N more", () => {
    expect(mediaGrid(2)).toEqual({ tiles: 2, more: 0 });
    expect(mediaGrid(4)).toEqual({ tiles: 4, more: 0 });
    expect(mediaGrid(5)).toEqual({ tiles: 4, more: 1 });
    expect(mediaGrid(7)).toEqual({ tiles: 4, more: 3 });
  });
});

describe("applyMediaEvent", () => {
  const begin = { action: "begin", handle: "h1", sessionID: "s", messageID: "m", kind: "image", width: 800, height: 600, count: 3, title: "logo" } as const;

  it("begin reserves a pending entry with the declared metadata", () => {
    const e = applyMediaEvent(undefined, begin, 1000);
    expect(e.state).toBe("pending");
    expect(e.beganAt).toBe(1000);
    expect(e.handle).toBe("h1");
    expect(e.meta.kind).toBe("image");
    expect(e.meta.width).toBe(800);
    expect(e.meta.height).toBe(600);
    expect(e.meta.count).toBe(3);
  });

  it("begin 'video' kind is preserved", () => {
    const e = applyMediaEvent(undefined, { ...begin, kind: "video" }, 0);
    expect(e.meta.kind).toBe("video");
  });

  it("show swaps a pending entry to ready, carrying prior metadata", () => {
    const pending = applyMediaEvent(undefined, begin, 1000);
    const e = applyMediaEvent(pending, { action: "show", path: "/home/dev/logo.png", mime: "image/png", width: 800, height: 600, handle: "h1", sessionID: "s", messageID: "m" });
    expect(e.state).toBe("ready");
    expect(e.meta.path).toBe("/home/dev/logo.png");
    expect(e.meta.mime).toBe("image/png");
    expect(e.meta.kind).toBe("image");
    expect(e.meta.count).toBe(3);
    expect(e.beganAt).toBe(1000);
  });

  it("show without a prior begin works standalone (kind from mime)", () => {
    const e = applyMediaEvent(undefined, { action: "show", path: "/v/clip.mp4", mime: "video/mp4", width: 1920, height: 1080 });
    expect(e.state).toBe("ready");
    expect(e.meta.kind).toBe("video");
  });

  it("fail ends a pending entry as failed, preserving the reserved box metadata", () => {
    const pending = applyMediaEvent(undefined, begin, 1000);
    const e = applyMediaEvent(pending, { action: "fail", handle: "h1" });
    expect(e.state).toBe("failed");
    expect(e.meta.width).toBe(800);
    expect(e.meta.height).toBe(600);
    expect(e.meta.kind).toBe("image");
  });
});

describe("applyWidgetEvent", () => {
  // The wire shape the box spine (src/server/widgets.mjs) publishes: sessionId /
  // messageId (lowercase `d`) — deliberately different casing from the media kind.
  const show = {
    action: "show",
    id: "w1",
    url: "https://g1.boxes.mantaui.com/widgets/w1",
    title: "Revenue by quarter",
    width: 800,
    height: 600,
    sessionId: "s",
    messageId: "m",
  } as const;

  it("show creates a ready entry with the reserved-box metadata", () => {
    const e = applyWidgetEvent(undefined, show);
    expect(e.state).toBe("ready");
    expect(e.meta.id).toBe("w1");
    expect(e.meta.url).toBe("https://g1.boxes.mantaui.com/widgets/w1");
    expect(e.meta.title).toBe("Revenue by quarter");
    expect(e.meta.width).toBe(800);
    expect(e.meta.height).toBe(600);
    expect(e.meta.aspectRatio).toBeNull();
  });

  it("a repeat show for the same id is idempotent", () => {
    const first = applyWidgetEvent(undefined, show);
    const second = applyWidgetEvent(first, show);
    expect(second.state).toBe("ready");
    expect(second).toEqual(first);
  });

  it("fail marks the entry degraded, preserving the reserved-box metadata", () => {
    const prev = applyWidgetEvent(undefined, show);
    const e = applyWidgetEvent(prev, { action: "fail", id: "w1" });
    expect(e.state).toBe("failed");
    expect(e.meta.width).toBe(800);
    expect(e.meta.height).toBe(600);
    expect(e.meta.url).toBe("https://g1.boxes.mantaui.com/widgets/w1");
  });

  it("an unknown action is a no-op (and dispatching it calls no handler)", () => {
    const prev = applyWidgetEvent(undefined, show);
    expect(applyWidgetEvent(prev, { action: "banana" })).toEqual(prev);

    // Mirrors the media dispatcher contract: an unsupported action routes to
    // no handler. The "unknown session ignored" guard lives at the App-level
    // onWidget subscription (drops events with empty sessionId/messageId
    // before they reach the reducer), so routing here is purely by `action`.
    let called: string[] = [];
    dispatchWidget({ action: "show", id: "w1" }, {
      show: () => called.push("show"),
      fail: () => called.push("fail"),
    });
    expect(called).toEqual(["show"]);

    dispatchWidget({ action: "nope" }, {
      show: () => called.push("show"),
      fail: () => called.push("fail"),
    });
    expect(called).toEqual(["show"]);
  });
});

describe("filePartToMediaEntry", () => {
  it("derives a ready image entry from a file part", () => {
    const e = filePartToMediaEntry({ type: "file", mime: "image/png", url: "file:///home/dev/diagram.png", filename: "diagram.png" } as never);
    expect(e.state).toBe("ready");
    expect(e.meta.kind).toBe("image");
    expect(e.meta.path).toBe("/home/dev/diagram.png");
    expect(e.meta.mime).toBe("image/png");
  });

  it("derives a ready video entry from a file part", () => {
    const e = filePartToMediaEntry({ type: "file", mime: "video/mp4", url: "file:///home/dev/clip.mp4" } as never);
    expect(e.meta.kind).toBe("video");
    expect(e.meta.path).toBe("/home/dev/clip.mp4");
  });

  it("falls back to image for a non-media file part (never used, defensive)", () => {
    const e = filePartToMediaEntry({ type: "file", mime: "application/pdf", url: "file:///x.pdf" } as never);
    expect(e.meta.kind).toBe("image");
  });
});

describe("dispatchMedia", () => {
  it("routes begin/show/fail to the matching handler only", () => {
    const seen: string[] = [];
    const handlers = {
      begin: () => seen.push("begin"),
      show: () => seen.push("show"),
      fail: () => seen.push("fail"),
    };
    dispatchMedia({ action: "begin" }, handlers);
    dispatchMedia({ action: "show" }, handlers);
    dispatchMedia({ action: "fail" }, handlers);
    expect(seen).toEqual(["begin", "show", "fail"]);
  });

  it("ignores non-object payloads and unknown actions", () => {
    const seen: string[] = [];
    const handlers = { begin: () => seen.push("begin"), show: () => seen.push("show"), fail: () => seen.push("fail") };
    dispatchMedia(null, handlers);
    dispatchMedia("x", handlers);
    dispatchMedia({ action: "unknown" }, handlers);
    expect(seen).toEqual([]);
  });

  it("still routes when only some handlers are supplied", () => {
    expect(() => dispatchMedia({ action: "show" }, {})).not.toThrow();
  });
});

describe("chartAxisTicks", () => {
  const day = (n: number) => new Date(`2026-08-${String(n).padStart(2, "0")}T00:00:00`).getTime();

  it("returns [] for empty input", () => {
    expect(chartAxisTicks([], "day")).toEqual([]);
    expect(chartAxisTicks([], "hour")).toEqual([]);
  });

  it("fewer points than budget → one tick per point", () => {
    const ticks = chartAxisTicks([day(1), day(2)], "day");
    expect(ticks).toEqual([
      { index: 0, label: "Aug 1" },
      { index: 1, label: "Aug 2" },
    ]);
  });

  it("exactly the budget → one tick per point, all indices present", () => {
    const ts = [day(1), day(2), day(3), day(4)];
    const ticks = chartAxisTicks(ts, "day");
    expect(ticks.map((t) => t.index)).toEqual([0, 1, 2, 3]);
  });

  it("30 day points → 4 ticks with first index 0 and last index 29, no duplicate indices", () => {
    const ts = Array.from({ length: 30 }, (_, i) => day(i + 1));
    const ticks = chartAxisTicks(ts, "day");
    expect(ticks.length).toBe(4);
    expect(ticks[0].index).toBe(0);
    expect(ticks[ticks.length - 1].index).toBe(29);
    const idx = ticks.map((t) => t.index);
    expect(new Set(idx).size).toBe(idx.length);
  });

  it("24 hour points → 5 ticks, monotonic indices, last index 23", () => {
    const ts = Array.from({ length: 24 }, (_, i) => new Date(`2026-08-01T${String(i).padStart(2, "0")}:00:00`).getTime());
    const ticks = chartAxisTicks(ts, "hour");
    expect(ticks.length).toBe(5);
    expect(ticks[0].index).toBe(0);
    expect(ticks[ticks.length - 1].index).toBe(23);
    const idx = ticks.map((t) => t.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("formats day labels as en-US short month + numeric day", () => {
    const ticks = chartAxisTicks([day(3), day(15)], "day");
    expect(ticks[0].label).toBe("Aug 3");
    expect(ticks[1].label).toBe("Aug 15");
  });

  it("formats hour labels as 2-digit local hour", () => {
    const ts = [new Date("2026-08-01T14:37:00").getTime(), new Date("2026-08-01T09:05:00").getTime()];
    const ticks = chartAxisTicks(ts, "hour");
    expect(ticks[0].label).toBe("14:00");
    expect(ticks[1].label).toBe("09:00");
  });
});



// ===== Endpoint health formatting (BET-1537 S5 review Blocks 1+3) =====


describe("providersFromExcludedKeys / ENDPOINT_STATE_LABEL coverage", () => {
  it("derives the distinct providers behind the excluded keys", () => {
    expect(providersFromExcludedKeys(["anthropic/a", "anthropic/b", "voska/c", "junk"])).toEqual([
      "anthropic",
      "voska",
    ]);
    expect(providersFromExcludedKeys(undefined)).toEqual([]);
  });

  it("every endpoint state label is non-empty and distinct; unknown states map to null", async () => {
    const { ENDPOINT_STATE_LABEL, endpointStateLabel } = await import("../shared/providerHealthLabel.mjs");
    const labels = Object.values(ENDPOINT_STATE_LABEL);
    for (const l of labels) expect(typeof l === "string" && l.length > 0).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    for (const state of Object.keys(ENDPOINT_STATE_LABEL)) {
      expect(endpointStateLabel(state)).toBe(ENDPOINT_STATE_LABEL[state]);
    }
    expect(endpointStateLabel("nonexistent-state")).toBeNull();
  });
});

// ===== detectTypeaheadTrigger =====

describe("detectTypeaheadTrigger", () => {
  const t = (text: string, caret: number) => detectTypeaheadTrigger(text, caret);

  it("opens the agent typeahead on @@ and @@partial", () => {
    expect(t("@@", 2)).toEqual({ mode: "agent", query: "", anchorStart: 0, anchorEnd: 2 });
    expect(t("@@bu", 4)).toEqual({ mode: "agent", query: "bu", anchorStart: 0, anchorEnd: 4 });
    expect(t("hi @@bu", 7)).toEqual({ mode: "agent", query: "bu", anchorStart: 3, anchorEnd: 7 });
    expect(t("hi\n@@x", 6)).toMatchObject({ mode: "agent", query: "x", anchorStart: 3 });
  });

  it("extends the anchor to the end of the token when the caret is mid-token", () => {
    expect(t("@@build ok", 4)).toEqual({ mode: "agent", query: "bu", anchorStart: 0, anchorEnd: 7 });
  });

  it("keeps single-@ file typeahead", () => {
    expect(t("@", 1)).toEqual({ mode: "file", query: "", anchorStart: 0, anchorEnd: 1 });
    expect(t("@src/fo", 7)).toMatchObject({ mode: "file", query: "src/fo" });
    expect(t("see @a", 6)).toMatchObject({ mode: "file", query: "a", anchorStart: 4 });
  });

  it("opens nothing for email-like or malformed tokens", () => {
    for (const [text, caret] of [
      ["a@b", 3],
      ["foo@", 4],
      ["x@@y", 4],
      ["@foo@bar", 8],
      ["@@foo@bar", 9],
      ["@@@", 3],
      ["@a b", 4],
      ["", 0],
    ] as const) {
      expect(t(text, caret), `${JSON.stringify(text)}@${caret}`).toBeNull();
    }
  });

  it("treats a caret between the two @ as file mode", () => {
    expect(t("@@x", 1)).toMatchObject({ mode: "file", query: "" });
  });

  describe("slash commands (semantics preserved)", () => {
    it("uses the whole first token as the query, wherever the caret sits in it", () => {
      expect(t("/review rest", 3)).toEqual({ mode: "command", query: "review", anchorStart: 0, anchorEnd: 7 });
      expect(t("/review rest", 0)).toMatchObject({ mode: "command", query: "review" });
    });

    it("stops the command token at punctuation", () => {
      expect(t("/review.foo", 7)).toEqual({ mode: "command", query: "review", anchorStart: 0, anchorEnd: 7 });
    });

    it("does not trigger on a leading-space slash or past the first word", () => {
      expect(t(" /rev", 5)).toBeNull();
      expect(t("/rev x", 6)).toBeNull();
      expect(t("/@@x", 4)).toBeNull();
    });

    it("falls through to file mentions once the caret leaves the command token", () => {
      expect(t("/rev @file", 10)).toEqual({ mode: "file", query: "file", anchorStart: 5, anchorEnd: 10 });
    });
  });
});

describe("authProviderSeatId", () => {
  it("maps the seat-bearing providers", () => {
    expect(authProviderSeatId("anthropic")).toBe("claude");
    expect(authProviderSeatId("openai")).toBe("codex");
  });
  it("has no seat panel for Kimi or anything else", () => {
    for (const v of ["kimi-for-coding", "", "foo", null, undefined]) expect(authProviderSeatId(v)).toBeUndefined();
  });
});

describe("contextModelLabel (WS11 D2 decision 4)", () => {
  const models = [{ id: "opus", providerID: "anthropic", name: "Claude Opus" }];
  it("names the model the box measured against, from the catalog", () => {
    expect(contextModelLabel(models, { providerID: "anthropic", modelID: "opus" }, "selected", "Other")).toBe("Claude Opus");
  });
  it("marks a last-reply fallback so the label cannot name a model that was not measured", () => {
    expect(contextModelLabel(models, { providerID: "anthropic", modelID: "opus" }, "last-used", "Other")).toBe("Claude Opus (last reply's model)");
  });
  it("falls back to the raw model id when the catalog lacks it, and to the client's name on an older box", () => {
    expect(contextModelLabel(models, { providerID: "x", modelID: "mystery" }, "selected", "Other")).toBe("mystery");
    expect(contextModelLabel(models, null, undefined, "Other")).toBe("Other");
    expect(contextModelLabel(models, undefined, null, null)).toBeNull();
  });
});

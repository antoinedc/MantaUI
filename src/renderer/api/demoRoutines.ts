// demoRoutines.ts — the Routines feature's demo fixture + in-memory store.
//
// Reproduces docs/screens/routines/mockup.html: eight routines, the seven-run
// history of "Daily analytics digest", the queue, three follow-ups, the memory
// note and the Thu 30 Oct 9:02 run's transcript. Served ONLY in the
// `routines` / `routines-chat` demo states so every other baseline is untouched.
//
// The clock is Thu 30 Oct 2025 10:01 (box-local): the mockup's weekday labels
// ("Thu 30", "Fri 24", "Wed 5 Nov") only line up in 2025. Every timestamp is
// built from `new Date(y, m, d, h, min)` so the rendering is timezone-independent.
//
// The store is mutable so every control in the demo does something real
// (create, edit, pause, run, mark read, move) — it implements the same
// `routines:*` contract httpApi talks to the box with.

import type {
  FollowupRow,
  Routine,
  RoutineDetail,
  RoutineInput,
  RoutineMoveTarget,
  RoutineRun,
  RoutinesSummary,
} from "../../shared/routines.js";
import type { OpencodeMessage, OpencodeModel, OpencodeSessionListItem, Project, ScheduledJob } from "../../shared/types.js";

const at = (d: number, h: number, m: number, s = 0): number => new Date(2025, 9, d, h, m, s).getTime();
const atN = (d: number, h: number, m: number): number => new Date(2025, 10, d, h, m).getTime();

/** Thu 30 Oct 2025 10:01 box-local. */
export const ROUTINES_T0 = at(30, 10, 1);
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Sidebar workspaces / sessions (the mockup's rail)
// ---------------------------------------------------------------------------

const SES_ANALYTICS = "ses_routines_analytics";
const SES_ONBOARDING = "ses_routines_onboarding";
const SES_BILLING = "ses_routines_billing";
const SES_500S = "ses_routines_500s";
const SES_AUTH = "ses_routines_auth";
const SES_CSV = "ses_routines_csv";
const SES_RUN_DIGEST = "ses_run_digest_thu30";

export const ROUTINES_ACTIVE_SESSION = SES_ANALYTICS;

export const routinesProjects: Project[] = [
  {
    tmuxSession: "ronda",
    defaultCwd: "/home/dev/projects/ronda",
    attached: true,
    windows: [
      { index: 0, name: "Analytics review", active: true, paneCurrentPath: "/home/dev/projects/ronda", opencodeSessionId: SES_ANALYTICS },
      { index: 1, name: "Onboarding emails", active: false, paneCurrentPath: "/home/dev/projects/ronda", opencodeSessionId: SES_ONBOARDING },
    ],
  },
  {
    tmuxSession: "better-ui",
    defaultCwd: "/home/dev/projects/better-ui",
    attached: true,
    windows: [
      { index: 0, name: "Deploy new billing service", active: false, paneCurrentPath: "/home/dev/projects/better-ui", opencodeSessionId: SES_BILLING },
      { index: 1, name: "Investigate 500s in /api", active: false, paneCurrentPath: "/home/dev/projects/better-ui", opencodeSessionId: SES_500S },
      { index: 2, name: "Refactor auth middleware", active: false, paneCurrentPath: "/home/dev/projects/better-ui", opencodeSessionId: SES_AUTH },
    ],
  },
  {
    tmuxSession: "ethernal",
    defaultCwd: "/home/dev/projects/ethernal",
    attached: true,
    windows: [
      { index: 0, name: "Add CSV export", active: false, paneCurrentPath: "/home/dev/projects/ethernal", opencodeSessionId: SES_CSV },
    ],
  },
  { tmuxSession: "marketing", defaultCwd: "/home/dev/projects/marketing", attached: true, windows: [] },
];

const ago = (min: number) => ROUTINES_T0 - min * MIN;

export const routinesStatus: Record<string, Record<number, { running: boolean; subagents: number; attention: boolean; lastMessageAt?: number }>> = {
  ronda: {
    0: { running: false, subagents: 0, attention: false, lastMessageAt: ago(6) },
    1: { running: false, subagents: 0, attention: false, lastMessageAt: ago(120) },
  },
  "better-ui": {
    0: { running: false, subagents: 0, attention: false, lastMessageAt: ago(2) },
    1: { running: false, subagents: 0, attention: false, lastMessageAt: ago(8) },
    2: { running: false, subagents: 0, attention: false, lastMessageAt: ago(24 * 60) },
  },
  ethernal: { 0: { running: false, subagents: 0, attention: false, lastMessageAt: ago(14) } },
};

const sess = (id: string, title: string, directory: string, updatedMinAgo: number): OpencodeSessionListItem => ({
  id,
  slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  directory,
  time: { created: ago(updatedMinAgo + 30), updated: ago(updatedMinAgo) },
  model: { id: "claude-opus-4-7", providerID: "anthropic" },
});

export const routinesSessionList: OpencodeSessionListItem[] = [
  sess(SES_ANALYTICS, "Analytics review", "/home/dev/projects/ronda", 6),
  sess(SES_ONBOARDING, "Onboarding emails", "/home/dev/projects/ronda", 120),
  sess(SES_BILLING, "Deploy new billing service", "/home/dev/projects/better-ui", 2),
  sess(SES_500S, "Investigate 500s in /api", "/home/dev/projects/better-ui", 8),
  sess(SES_AUTH, "Refactor auth middleware", "/home/dev/projects/better-ui", 24 * 60),
  sess(SES_CSV, "Add CSV export", "/home/dev/projects/ethernal", 14),
];

export const routinesExtraModels: OpencodeModel[] = [
  {
    id: "claude-sonnet-5-5",
    providerID: "anthropic",
    name: "Sonnet 5.5",
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 32_000 },
    capabilities: { toolcall: true, input: ["text", "image"], output: ["text"] },
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  },
];

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

const DIGEST_PROMPT =
  "Use $posthog-digest for yesterday. Compare against the baselines you remember. Only report changes beyond ±10% or anything new in errors; otherwise say there's nothing new.";

const MEMORY_ADDED = ["- checkout errors on Safari 17", "  since Tue deploy — 4.3% (Oct 30)"];
const MEMORY_NOW = [
  "## Baselines (trailing 4 wks)",
  "signups/day ≈ 50 · activation 34%",
  "checkout error rate ≈ 2%",
  "",
  "## Watching",
  "- onboarding copy change (Oct 27):",
  "  activation 31% → recovering",
  ...MEMORY_ADDED,
  "",
  "## Ignore",
  "- weekend dips; HN spikes",
].join("\n");
const MEMORY_BEFORE = MEMORY_NOW.split("\n").filter((l) => !MEMORY_ADDED.includes(l)).join("\n");

function routine(over: Partial<Routine> & Pick<Routine, "id" | "name" | "cron" | "directory" | "projectName">): Routine {
  return {
    prompt: "Check the project and report anything that changed.",
    icon: "calendar-clock",
    access: "read",
    model: null,
    notify: "findings",
    enabled: true,
    destination: { type: "new-session" },
    catchUpHours: 6,
    createdAt: at(1, 9, 0),
    updatedAt: at(1, 9, 0),
    createdFrom: null,
    nextRunAt: null,
    memoryUpdatedByRunId: null,
    ...over,
  };
}

const ID = {
  digest: "a1b2c3d4",
  triage: "b2c3d4e5",
  crash: "c3d4e5f6",
  docs: "d4e5f6a7",
  dep: "e5f6a7b8",
  comp: "f6a7b8c9",
  err: "a7b8c9d0",
  rel: "b8c9d0e1",
};

const initialRoutines = (): Routine[] => [
  routine({
    id: ID.digest,
    name: "Daily analytics digest",
    prompt: DIGEST_PROMPT,
    icon: "chart",
    cron: "0 9 * * 1-5",
    directory: "/home/dev/projects/ronda",
    projectName: "ronda",
    model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" },
    createdFrom: { sessionID: SES_ANALYTICS },
    nextRunAt: at(31, 9, 0),
    memoryUpdatedByRunId: "run_dg_23",
  }),
  routine({
    id: ID.triage,
    name: "Weekly bug triage",
    icon: "bug",
    cron: "30 9 * * 4",
    directory: "/home/dev/projects/better-ui",
    projectName: "better-ui",
    nextRunAt: atN(6, 9, 30),
  }),
  routine({
    id: ID.crash,
    name: "Crash report sweep",
    icon: "alert",
    cron: "0 7 * * *",
    directory: "/home/dev/projects/better-ui",
    projectName: "better-ui",
    nextRunAt: at(31, 7, 0),
  }),
  routine({
    id: ID.docs,
    name: "Docs drift check",
    icon: "book",
    cron: "30 8 * * 3",
    directory: "/home/dev/projects/better-ui",
    projectName: "better-ui",
    nextRunAt: atN(5, 8, 30),
  }),
  routine({
    id: ID.dep,
    name: "Dependency audit",
    icon: "package",
    cron: "0 14 * * 5",
    directory: "/home/dev/projects/ethernal",
    projectName: "ethernal",
    access: "edit",
    nextRunAt: at(31, 14, 0),
  }),
  routine({
    id: ID.comp,
    name: "Competitor pricing scan",
    icon: "tag",
    cron: "0 10 * * 4",
    directory: "/home/dev/projects/marketing",
    projectName: "marketing",
    nextRunAt: atN(6, 10, 0),
  }),
  routine({
    id: ID.err,
    name: "Error budget check",
    icon: "shield",
    cron: "0 * * * *",
    directory: "/home/dev/projects/ronda",
    projectName: "ronda",
    notify: "failures",
    nextRunAt: at(30, 11, 0),
  }),
  routine({
    id: ID.rel,
    name: "Release notes draft",
    icon: "tag",
    cron: "0 16 * * 5",
    directory: "/home/dev/projects/better-ui",
    projectName: "better-ui",
    enabled: false,
    nextRunAt: null,
  }),
];

let runSeq = 0;
function run(r: Routine, over: Partial<RoutineRun> & Pick<RoutineRun, "id" | "seq" | "status">): RoutineRun {
  runSeq += 1;
  return {
    routineName: r.name,
    projectName: r.projectName,
    routineId: r.id,
    trigger: "scheduled",
    queuedAt: ROUTINES_T0,
    startedAt: null,
    endedAt: null,
    sessionID: `ses_run_${over.id}`,
    worktree: null,
    report: null,
    error: null,
    notes: [],
    readAt: null,
    notifiedAt: null,
    keptInSidebar: false,
    memoryDiff: null,
    tokens: null,
    question: null,
    reprompted: false,
    reportCount: over.report ? 1 : 0,
    memoryAtStart: "",
    ...over,
  };
}

const nothing = (title = "All metrics within normal range") => ({ outcome: "nothing" as const, title, summary: "", body: "" });

const DIGEST_BODY = [
  "- **Signups** 412 vs 349 last week +18% — mostly organic search",
  "- **Checkout errors** 2.1% → 4.3% ×2 — Safari 17 only, since deploy `a41c9e2`",
  "- **Activation** back to 33% after Monday's dip — no action needed",
].join("\n");

const initialRuns = (rs: Routine[]): RoutineRun[] => {
  const by = (id: string) => rs.find((r) => r.id === id) as Routine;
  const dg = by(ID.digest);
  const read = (ms: number) => ({ readAt: ms });
  return [
    run(dg, {
      id: "run_dg_23",
      seq: 23,
      status: "done",
      queuedAt: at(30, 9, 0),
      startedAt: at(30, 9, 2),
      endedAt: at(30, 9, 4, 14),
      sessionID: SES_RUN_DIGEST,
      report: {
        outcome: "findings",
        title: "Signups up 18% week over week; checkout errors doubled since Tuesday",
        summary: "412 signups (vs 349). Checkout error rate 2.1% → 4.3%, all on Safari 17 — started with Tuesday's deploy.",
        body: DIGEST_BODY,
      },
      reportCount: 1,
      notes: ["Safari 17 only — lines up with Tuesday's deploy"],
      notifiedAt: at(30, 9, 4),
      tokens: 38_200,
      memoryDiff: { added: MEMORY_ADDED },
      memoryAtStart: MEMORY_BEFORE,
    }),
    run(dg, { id: "run_dg_22", seq: 22, status: "done", queuedAt: at(29, 9, 0), startedAt: at(29, 9, 1), endedAt: at(29, 9, 2, 48), report: nothing(), ...read(at(29, 9, 3)) }),
    run(dg, {
      id: "run_dg_21",
      seq: 21,
      status: "done",
      queuedAt: at(28, 9, 0),
      startedAt: at(28, 9, 7),
      endedAt: at(28, 9, 9, 30),
      report: { outcome: "findings", title: "Activation dipped to 31% after the onboarding copy change", summary: "", body: "" },
      notes: ["Waited 6 min in line behind Dependency audit"],
      ...read(at(28, 10, 0)),
    }),
    run(dg, {
      id: "run_dg_20",
      seq: 20,
      status: "done",
      trigger: "catch_up",
      queuedAt: at(27, 9, 41),
      startedAt: at(27, 9, 41),
      endedAt: at(27, 9, 43, 2),
      report: { outcome: "findings", title: "Weekend traffic 2.3× normal — a Hacker News link", summary: "", body: "" },
      notes: ["Caught up at 9:41: the box was restarting at 9:00"],
      ...read(at(27, 11, 0)),
    }),
    run(dg, { id: "run_dg_19", seq: 19, status: "done", queuedAt: at(24, 9, 0), startedAt: at(24, 9, 1), endedAt: at(24, 9, 2, 39), report: nothing(), ...read(at(24, 9, 5)) }),
    run(dg, {
      id: "run_dg_18",
      seq: 18,
      status: "failed",
      queuedAt: at(23, 9, 0),
      startedAt: at(23, 9, 0),
      endedAt: at(23, 9, 0, 18),
      error: "PostHog returned 401 — the API key was rotated",
      notes: ["Fixed by updating the posthog_key secret · re-ran at 11:12"],
      ...read(at(23, 11, 12)),
    }),
    run(dg, { id: "run_dg_17", seq: 17, status: "done", queuedAt: at(22, 9, 0), startedAt: at(22, 9, 1), endedAt: at(22, 9, 2, 51), report: nothing(), ...read(at(22, 9, 5)) }),

    run(by(ID.triage), {
      id: "run_tr_9",
      seq: 9,
      status: "needs_input",
      queuedAt: at(30, 9, 49),
      startedAt: at(30, 9, 49),
      question: "14 bug reports are older than 90 days with no repro. Close them as stale, or keep them at P3?",
    }),
    run(by(ID.crash), {
      id: "run_cr_40",
      seq: 40,
      status: "done",
      trigger: "catch_up",
      queuedAt: at(30, 7, 0),
      startedAt: at(30, 7, 0),
      endedAt: at(30, 7, 2),
      report: {
        outcome: "findings",
        title: "New crash in transcript list on iOS 26.1 — 23 users",
        summary: "Index out of range while a compaction lands mid-scroll. Matches an issue closed in September; likely a regression.",
        body: "",
      },
      reportCount: 1,
    }),
    run(by(ID.docs), { id: "run_dd_12", seq: 12, status: "running", trigger: "manual", queuedAt: at(30, 9, 57, 19), startedAt: at(30, 9, 57, 19) }),
    run(by(ID.dep), {
      id: "run_da_30",
      seq: 30,
      status: "done",
      queuedAt: at(24, 14, 0),
      startedAt: at(24, 14, 0),
      endedAt: at(24, 14, 9),
      report: {
        outcome: "findings",
        title: "2 high-severity advisories; draft PR opened with the upgrades",
        summary: "axios and express-session. Tests pass on the branch; the session upgrade changes a cookie default — flagged in the PR.",
        body: "",
      },
      reportCount: 1,
    }),
    run(by(ID.dep), { id: "run_da_31", seq: 31, status: "queued", trigger: "manual", queuedAt: at(30, 10, 1), sessionID: null }),
    run(by(ID.comp), { id: "run_cp_8", seq: 8, status: "running", queuedAt: at(30, 10, 0, 9), startedAt: at(30, 10, 0, 9) }),
    run(by(ID.err), { id: "run_eb_204", seq: 204, status: "done", queuedAt: at(30, 9, 0), startedAt: at(30, 9, 0), endedAt: at(30, 9, 0, 40), report: nothing("Within budget"), ...read(at(30, 9, 1)) }),
    run(by(ID.err), { id: "run_eb_205", seq: 205, status: "queued", queuedAt: at(30, 10, 0), sessionID: null }),
    run(by(ID.rel), {
      id: "run_rn_5",
      seq: 5,
      status: "failed",
      queuedAt: at(24, 16, 0),
      startedAt: at(24, 16, 0),
      endedAt: at(24, 16, 0, 20),
      error: "GitHub token expired",
      ...read(at(24, 16, 30)),
    }),
  ];
};

const initialFollowups = (): FollowupRow[] => [
  {
    id: "fu_deploy",
    prompt: "Check whether the deploy finished",
    label: "Check whether the deploy finished",
    cron: "*/5 * * * *",
    recurring: true,
    sessionID: SES_BILLING,
    sessionName: "Deploy new billing service",
    nextFireAt: ROUTINES_T0 + 3 * MIN,
    routineId: null,
  },
  {
    id: "fu_billing",
    prompt: "Write up what changed in billing this week",
    label: "Write up what changed in billing this week",
    cron: "0 17 * * 5",
    recurring: true,
    sessionID: SES_BILLING,
    sessionName: "Deploy new billing service",
    nextFireAt: at(31, 17, 0),
    routineId: null,
  },
  {
    id: "fu_push",
    prompt: "Remind me to push the release",
    label: "Remind me to push the release",
    cron: "30 17 30 10 *",
    recurring: false,
    sessionID: SES_CSV,
    sessionName: "Add CSV export",
    nextFireAt: at(30, 17, 30),
    routineId: null,
  },
];

// ---------------------------------------------------------------------------
// The transcript of the Thu 30 9:02 run, and the "Analytics review" chat
// ---------------------------------------------------------------------------

const part = (messageID: string, id: string, rest: Record<string, unknown>) => ({ id: `${messageID}_${id}`, messageID, ...rest });
const doneTool = (messageID: string, id: string, tool: string, title: string, input: Record<string, unknown>, output: string) =>
  part(messageID, id, { type: "tool", tool, state: { status: "completed", title, input, output, time: { start: at(30, 9, 2), end: at(30, 9, 3) } } });

export const routineRunMessages = (): OpencodeMessage[] =>
  [
    {
      info: { id: "msg_ru1", sessionID: SES_RUN_DIGEST, role: "user", time: { created: at(30, 9, 2) } },
      parts: [part("msg_ru1", "text", { type: "text", text: DIGEST_PROMPT })],
    },
    {
      info: {
        id: "msg_ra1",
        sessionID: SES_RUN_DIGEST,
        role: "assistant",
        modelID: "claude-sonnet-5-5",
        providerID: "anthropic",
        time: { created: at(30, 9, 2, 5), completed: at(30, 9, 4, 14) },
      },
      parts: [
        doneTool("msg_ra1", "t1", "skill", "posthog-digest", { name: "posthog-digest" }, "Loaded skill posthog-digest"),
        doneTool("msg_ra1", "t2", "bash", "posthog query signups, activation", { command: "posthog query signups activation --day 2025-10-29", description: "signups, activation · Oct 29" }, "signups 412\nactivation 33%"),
        doneTool("msg_ra1", "t3", "bash", "posthog query $exception by browser", { command: "posthog query '$exception' --by browser --range 7d", description: "$exception by browser · 7d" }, "Safari 17 · 4.3%\nChrome 130 · 1.9%"),
        doneTool("msg_ra1", "t4", "bash", "git log", { command: "git log --since=“Oct 27” --oneline", description: "git log --since=“Oct 27” --oneline" }, "a41c9e2 payment form: date input\n…"),
        part("msg_ra1", "text", {
          type: "text",
          text: "Signups are well above baseline. The bigger issue is checkout errors: they started climbing Tuesday afternoon and every one of them is on Safari 17. Tuesday's deploy a41c9e2 changed the payment form's date input, which matches the error.",
        }),
        part("msg_ra1", "report", {
          type: "tool",
          tool: "routine_report",
          state: {
            status: "completed",
            title: "Report filed",
            input: {
              outcome: "findings",
              title: "Signups up 18% week over week; checkout errors doubled since Tuesday",
              summary: "412 signups (vs 349). Checkout error rate 2.1% → 4.3%, all on Safari 17 — started with Tuesday's deploy.",
              body: DIGEST_BODY,
              memory: MEMORY_NOW,
            },
            output: "Report filed. Memory updated.",
            time: { start: at(30, 9, 4), end: at(30, 9, 4, 14) },
          },
        }),
      ],
    },
  ] as unknown as OpencodeMessage[];

export const analyticsChatMessages = (): OpencodeMessage[] =>
  [
    {
      info: { id: "msg_ac_u0", sessionID: SES_ANALYTICS, role: "user", time: { created: ago(40) } },
      parts: [part("msg_ac_u0", "text", { type: "text", text: "Give me yesterday's analytics at a glance." })],
    },
    {
      info: { id: "msg_ac_a1", sessionID: SES_ANALYTICS, role: "assistant", modelID: "claude-opus-4-7", providerID: "anthropic", time: { created: ago(39), completed: ago(38) } },
      parts: [
        part("msg_ac_a1", "text", {
          type: "text",
          text: "Here's yesterday at a glance: 61 signups (+12% on the 4-week average), activation 34%, checkout error rate 2.0%. Nothing unusual.",
        }),
      ],
    },
    {
      info: { id: "msg_ac_u1", sessionID: SES_ANALYTICS, role: "user", time: { created: ago(8) } },
      parts: [
        part("msg_ac_u1", "text", {
          type: "text",
          text: "Perfect, that's exactly what I want. Can you do this every weekday at 9 and only ping me when something's off?",
        }),
      ],
    },
    {
      info: { id: "msg_ac_a2", sessionID: SES_ANALYTICS, role: "assistant", modelID: "claude-opus-4-7", providerID: "anthropic", time: { created: ago(7), completed: ago(6) } },
      parts: [
        part("msg_ac_a2", "text", {
          type: "text",
          text: "Done. I've turned what we just did into a routine. Each run starts from a clean session, compares against what it remembers from earlier runs, and only notifies you when a number moves more than 10% or a new error appears.",
        }),
        part("msg_ac_a2", "create", {
          type: "tool",
          tool: "routine_create",
          state: {
            status: "completed",
            title: "Daily analytics digest",
            input: {
              name: "Daily analytics digest",
              prompt: DIGEST_PROMPT,
              cron: "0 9 * * 1-5",
              access: "read",
              notify: "findings",
              icon: "chart",
              memory: "## Baselines (trailing 4 wks)\nsignups/day ≈ 50 · activation 34%\ncheckout error rate ≈ 2%\n- weekend dips; HN spikes",
            },
            output: `Routine "Daily analytics digest" created. Id ${ID.digest}. Runs 0 9 * * 1-5 (box time). It starts a fresh session each time; results appear on the Routines page.`,
            time: { start: ago(7), end: ago(6) },
          },
        }),
      ],
    },
  ] as unknown as OpencodeMessage[];

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const TZ = "Europe/Paris";
const isUnread = (r: RoutineRun) =>
  r.readAt == null &&
  (r.status === "failed" || r.status === "timed_out" || (r.status === "done" && r.report?.outcome === "findings"));
const when = (r: RoutineRun) => r.endedAt ?? r.startedAt ?? r.queuedAt;
const newestFirst = (a: RoutineRun, b: RoutineRun) => when(b) - when(a);

export function createRoutinesStore() {
  let routines = initialRoutines();
  let runs = initialRuns(routines);
  let followups = initialFollowups();
  const memory: Record<string, string> = { [ID.digest]: MEMORY_NOW };
  const stats: Record<string, { runCount: number; firstRunAt: number | null; avgTokens: number | null }> = {
    [ID.digest]: { runCount: 23, firstRunAt: at(1, 9, 0), avgTokens: 41_000 },
  };
  let idCounter = 0;
  const mint = (len: number) => {
    idCounter += 1;
    return (idCounter.toString(16).padStart(len, "0") + "fedcba9876543210").slice(0, len);
  };

  const find = (id: string): Routine => {
    const r = routines.find((x) => x.id === id);
    if (!r) throw new Error("No routine with that id");
    return r;
  };
  const sortedByName = () => routines;
  const lastRun = (id: string): RoutineRun | null =>
    runs.filter((r) => r.routineId === id).sort((a, b) => b.queuedAt - a.queuedAt || b.seq - a.seq)[0] ?? null;

  function summary(): RoutinesSummary {
    const findings = runs.filter(isUnread).sort(newestFirst).slice(0, 20);
    const needs = runs.filter((r) => r.status === "needs_input").sort(newestFirst);
    return {
      needsYou: needs.length,
      unread: runs.filter(isUnread).length,
      concurrency: 2,
      routines: sortedByName(),
      lastRuns: Object.fromEntries(routines.map((r) => [r.id, lastRun(r.id)])),
      needs,
      findings,
      running: runs.filter((r) => r.status === "running").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      waiting: runs.filter((r) => r.status === "queued").sort((a, b) => a.queuedAt - b.queuedAt),
      followups: followups.slice().sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity)),
      orphaned: [],
      tz: TZ,
      now: ROUTINES_T0,
    };
  }

  function get(id: string, opts?: { beforeSeq?: number; findingsOnly?: boolean }): RoutineDetail {
    const r = find(id);
    let list = runs.filter((x) => x.routineId === id).sort((a, b) => b.seq - a.seq);
    if (opts?.findingsOnly) list = list.filter((x) => x.report?.outcome === "findings");
    if (opts?.beforeSeq != null) list = list.filter((x) => x.seq < (opts.beforeSeq as number));
    const total = stats[id]?.runCount ?? runs.filter((x) => x.routineId === id).length;
    const page = list.slice(0, 30);
    return {
      routine: r,
      memory: memory[id] ?? "",
      runs: page,
      hasMore: opts?.beforeSeq == null && !opts?.findingsOnly && total > page.length,
      stats: stats[id] ?? { runCount: total, firstRunAt: runs.filter((x) => x.routineId === id).map((x) => x.queuedAt).sort()[0] ?? null, avgTokens: null },
    };
  }

  function nextOf(cron: string): number | null {
    // The demo does not run a scheduler: a created routine shows tomorrow at its cron's time.
    const f = cron.trim().split(/\s+/);
    const h = Number(f[1]);
    const m = Number(f[0]);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return at(31, 9, 0);
    return at(31, h, m);
  }

  const create = (input: RoutineInput): Promise<Routine> => {
    const r = routine({
      id: mint(8),
      name: input.name,
      prompt: input.prompt,
      icon: input.icon ?? "calendar-clock",
      cron: input.cron,
      directory: input.directory,
      projectName: input.directory.split("/").filter(Boolean).pop() ?? null,
      access: input.access ?? "read",
      model: input.model ?? null,
      notify: input.notify ?? "findings",
      enabled: input.enabled ?? true,
      createdFrom: input.createdFrom ?? null,
      createdAt: ROUTINES_T0,
      updatedAt: ROUTINES_T0,
    });
    r.nextRunAt = r.enabled ? nextOf(r.cron) : null;
    routines = [...routines, r];
    memory[r.id] = input.memory ?? "";
    return Promise.resolve(r);
  };

  // The ⏰ card of a chat: its follow-ups as scheduled jobs (where "Make it a routine" lives).
  function scheduleList(sessionId?: string): ScheduledJob[] {
    return followups
      .filter((f) => !sessionId || f.sessionID === sessionId)
      .map((f) => ({
        id: f.id,
        cron: f.cron,
        prompt: f.prompt,
        recurring: f.recurring,
        label: f.label,
        kind: "prompt" as const,
        sessionID: f.sessionID,
        directory: "/home/dev/projects/better-ui",
        createdAt: ROUTINES_T0,
        lastFiredMinute: null,
        ...(f.routineId ? { routineId: f.routineId } : {}),
      }));
  }

  return {
    summary: () => Promise.resolve(summary()),
    scheduleList: (sessionId?: string) => Promise.resolve(scheduleList(sessionId)),
    get: (id: string, opts?: { beforeSeq?: number; findingsOnly?: boolean }) => {
      try {
        return Promise.resolve(get(id, opts));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    create,
    update: (id: string, patch: Partial<RoutineInput>) => {
      const cur = find(id);
      const next: Routine = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.directory !== undefined ? { directory: patch.directory } : {}),
        ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
        ...(patch.access !== undefined ? { access: patch.access } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.notify !== undefined ? { notify: patch.notify } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: ROUTINES_T0,
      };
      next.nextRunAt = next.enabled && next.destination.type === "new-session" ? nextOf(next.cron) : null;
      routines = routines.map((r) => (r.id === id ? next : r));
      return Promise.resolve(next);
    },
    delete: (id: string) => {
      routines = routines.filter((r) => r.id !== id);
      runs = runs.filter((r) => r.routineId !== id);
      return Promise.resolve({ deleted: true });
    },
    runNow: (id: string) => {
      const r = find(id);
      const live = runs.find((x) => x.routineId === id && (x.status === "queued" || x.status === "running"));
      if (live) return Promise.resolve({ run: live, alreadyQueued: true });
      const created = run(r, {
        id: mint(10),
        seq: Math.max(0, ...runs.filter((x) => x.routineId === id).map((x) => x.seq)) + 1,
        status: "queued",
        trigger: "manual",
        queuedAt: ROUTINES_T0,
        sessionID: null,
      });
      runs = [...runs, created];
      return Promise.resolve({ run: created, alreadyQueued: false });
    },
    runGet: (runId: string) => {
      const r = runs.find((x) => x.id === runId);
      if (!r) return Promise.reject(new Error("No run with that id"));
      const siblings = runs.filter((x) => x.routineId === r.routineId).sort((a, b) => a.seq - b.seq);
      const i = siblings.findIndex((x) => x.id === runId);
      return Promise.resolve({
        run: r,
        routine: find(r.routineId),
        prevRunId: siblings[i - 1]?.id ?? null,
        nextRunId: siblings[i + 1]?.id ?? null,
      });
    },
    markRead: (ids: string[] | "all") => {
      let n = 0;
      runs = runs.map((r) => {
        const hit = ids === "all" ? isUnread(r) : ids.includes(r.id) && r.readAt == null;
        if (!hit) return r;
        n += 1;
        return { ...r, readAt: ROUTINES_T0 };
      });
      return Promise.resolve({ updated: n });
    },
    memorySet: (id: string, text: string) => {
      find(id);
      memory[id] = text;
      return Promise.resolve({ ok: true as const });
    },
    keepInSidebar: (_runId: string) => Promise.reject(new Error("Not available in the demo.")),
    convertPreview: (followupId: string) => {
      const f = followups.find((x) => x.id === followupId);
      if (!f) return Promise.reject(new Error("No follow-up with that id"));
      return Promise.resolve({
        instructions:
          "Write up what changed in the billing service this week: merged PRs touching services/billing, migrations run, and any Stripe webhook failures in Sentry. Compare against last week's write-up and call out anything still unresolved.",
        memory: [
          "- billing lives in services/billing; deploys via",
          "  scripts/deploy-billing.sh (from this chat, Oct 21)",
          "- Stripe webhook retries were flaky until the",
          "  Oct 28 fix: confirm they stay quiet",
          "- last write-up (Oct 24): 3 PRs, 1 migration",
        ].join("\n"),
        rewritten: true,
      });
    },
    convertCommit: (followupId: string, input: RoutineInput & { memory: string }) => {
      followups = followups.filter((f) => f.id !== followupId);
      return create(input);
    },
    moveToChat: (id: string, target: RoutineMoveTarget) => {
      const cur = find(id);
      const sessionID = target.type === "session" ? target.sessionID : cur.createdFrom?.sessionID ?? SES_ANALYTICS;
      const next: Routine = { ...cur, destination: { type: "session", sessionID, followupId: `fu_${id}`, enabledBeforeMove: cur.enabled }, nextRunAt: null };
      routines = routines.map((r) => (r.id === id ? next : r));
      const followup: FollowupRow = {
        id: `fu_${id}`,
        prompt: cur.prompt,
        label: cur.name,
        cron: cur.cron,
        recurring: true,
        sessionID,
        sessionName: routinesSessionList.find((s) => s.id === sessionID)?.title ?? null,
        nextFireAt: cur.nextRunAt,
        routineId: id,
      };
      followups = [...followups, followup];
      return Promise.resolve({ routine: next, followup });
    },
    moveBack: (id: string) => {
      const cur = find(id);
      const wasEnabled = cur.destination.type === "session" ? cur.destination.enabledBeforeMove : cur.enabled;
      const next: Routine = { ...cur, destination: { type: "new-session" }, enabled: wasEnabled, nextRunAt: wasEnabled ? nextOf(cur.cron) : null };
      routines = routines.map((r) => (r.id === id ? next : r));
      followups = followups.filter((f) => f.routineId !== id);
      return Promise.resolve(next);
    },
  };
}

// demoFixture.ts — fictional state for the renderer demo build (BET-302).
//
// `npm run dev` (or the mobile build) with `?demo` in the URL swaps the real
// httpApi for `demoApi` (see ./demoApi.ts) which reads its answers from the
// object exported here. The renderer renders the full desktop UI from this
// state — three projects, six-or-seven sessions, a realistic chat transcript,
// a pending question and a pending permission — without ever talking to a
// box, tmux, or opencode.
//
// ALL content in this file is fictional. Project names are exactly
// `ethernal`, `marketing`, `infra` so every screenshot / video frame renders
// the same brand ("the website spec section 6 shot list", `docs/specs/
// website-readme-revamp.md`). Real client project names, real hostnames, and
// real box tokens MUST NEVER appear here — the demo is what we ship on the
// homepage, so any non-fictional detail leaks into the marketing surface.
//
// The `tokens` block in the latest assistant step drives a realistic context
// bar; the transcript intentionally includes read/edit/bash/todowrite parts
// because that's the minimum to make a chat panel look lived-in. The
// transcript task is "add a CSV export endpoint to the billing service" —
// recognisable developer work, fictional, and not about building this website.

import type {
  AppConfig,
  OpencodeMessage,
  OpencodeModel,
  PermissionRequest,
  Project,
  QuestionRequest,
  OpencodeSessionListItem,
} from "../../shared/types.js";

// 32-lowercase-hex — the boxId shape httpApi + transport.mjs validate against.
// Same shape as src/server/auth.mjs isValidToken. Fictional, but well-formed so
// resolveTransportMode() resolves to "http" and the demo drops into the normal
// shell instead of the onboarding flow.
const BOX_ID = "9f3b1d4c8e7a2b5d0c6e4f7a3b9d2c1e";
const BOX_TOKEN = "a2c4e6f8b1d3c5a7e9f2b4d6c8e1a3f5";
const SERVER_URL = `https://${BOX_ID}.boxes.mantaui.com`;

// Git branch shown in the footer chip (App.tsx renders it from
// `branch` returned by opencodeVcsBranch). Pick something the reader can
// picture but obviously fictional.
const BRANCH = "feat/orders-csv-export";

// One fictional opencode chat session id. Any `ses_…`-shaped id works; the
// renderer only treats the string as opaque.
const SES_INFRA = "ses_3a7f2b1c9d8e4f6a";
const SES_ETHERNAL_RUN = "ses_2c8d4f6a1e9b3c5d";
const SES_ETHERNAL_IDLE = "ses_5e9c1b3a7d2f4e6c";
const SES_ETHERNAL_QUESTION = "ses_8b4d6c2e1a9f3d5b";
const SES_MARKETING_PERM = "ses_6f1a3c5e9b2d4f8c";

// =============================================================================
// AppConfig — what configGet returns. Includes a valid boxToken so the
// transport-mode resolver lands on "http" (App.tsx renders the normal shell,
// not the onboarding flow). chatAutoAllow is FALSE — that's what enables the
// permission card to stay visible (the bus-side bypass warning is gated on
// chatAutoAllow === true).
// =============================================================================
export const demoAppConfig: AppConfig = {
  // Project metadata is empty here because the renderer resolves per-window
  // cwd from `tmuxList().defaultCwd` (and the per-window paneCurrentPath);
  // the config carries only the on-disk persistable bits.
  projects: [
    { tmuxSession: "ethernal", defaultCwd: "/home/dev/projects/ethernal" },
    { tmuxSession: "marketing", defaultCwd: "/home/dev/projects/marketing-site" },
    { tmuxSession: "infra", defaultCwd: "/home/dev/projects/infra" },
  ],
  serverUrl: SERVER_URL,
  boxId: BOX_ID,
  boxToken: BOX_TOKEN,
  // Critical: leave false so the demo renders the actual permission card.
  // The spec explicitly forbids the "bypass permissions" banner, which the
  // App.tsx shell surfaces when this is true.
  chatAutoAllow: false,
  autoRenameSessions: true,
  allowAgentPush: true,
  worktreePerSession: true,
  worktreeCleanOnClose: false,
  downloadsDir: "",
  defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" },
  deactivatedMainModels: [],
  skillRegistryUrls: ["https://example.com/manta-skills-extra.json"],
  cacheTtl: "1h",
  launcherFlags: {},
  groqApiKey: "",
  voiceTranscriptionModel: "",
  voiceCommandModel: "",
  shareAnalytics: false,
  pluginsEnabled: false,
};

// =============================================================================
// Projects + windows — what tmuxList returns. Seven sessions across three
// projects; each session has an explicit `status` value the sidebar
// StatusIndicator consumes to render distinct affordances (pulsing blue /
// amber steady / pulsing red ? / pulsing red ! / subagent count).
// =============================================================================
export const demoProjects: Project[] = [
  {
    tmuxSession: "ethernal",
    defaultCwd: "/home/dev/projects/ethernal",
    attached: true,
    windows: [
      // Running with two subagents — sidebar shows pulsing blue dot + `·2`.
      {
        index: 0,
        name: "Add CSV export",
        active: false,
        paneCurrentPath: "/home/dev/projects/ethernal/services/billing",
        opencodeSessionId: SES_ETHERNAL_RUN,
        worktreePath:
          "/home/dev/projects/ethernal/services/billing.worktrees/csv-export",
      },
      // Idle, recently completed — sidebar shows amber steady dot + "now" age.
      {
        index: 1,
        name: "Refactor auth middleware",
        active: false,
        paneCurrentPath: "/home/dev/projects/ethernal/services/auth",
        opencodeSessionId: SES_ETHERNAL_IDLE,
      },
      // Pending question — sidebar shows pulsing red dot + `?` glyph.
      {
        index: 2,
        name: "Investigate 500s in /api/v1/orders",
        active: false,
        paneCurrentPath: "/home/dev/projects/ethernal/services/orders",
        opencodeSessionId: SES_ETHERNAL_QUESTION,
      },
    ],
  },
  {
    tmuxSession: "marketing",
    defaultCwd: "/home/dev/projects/marketing-site",
    attached: true,
    windows: [
      // Pending permission — sidebar shows pulsing red dot + `!` glyph.
      {
        index: 0,
        name: "Landing page copy",
        active: false,
        paneCurrentPath: "/home/dev/projects/marketing-site/app",
        opencodeSessionId: SES_MARKETING_PERM,
      },
      // Bare terminal — no opencodeSessionId → App.tsx renders Terminal, not
      // ChatPanel. Lets the screenshot showcase the terminal-mode branch
      // without writing extra code.
      {
        index: 1,
        name: "Build pipeline",
        active: false,
        paneCurrentPath: "/home/dev/projects/marketing-site",
        opencodeSessionId: null,
      },
    ],
  },
  {
    tmuxSession: "infra",
    defaultCwd: "/home/dev/projects/infra",
    attached: true,
    windows: [
      // Active session — chat-mode. Holds the rendered transcript + the
      // visible permission card + visible question card. Both blocks at once
      // satisfies "permission card and question card are both visible without
      // interaction" without forcing a navigation.
      {
        index: 0,
        name: "Deploy new billing service",
        active: true,
        paneCurrentPath: "/home/dev/projects/infra/terraform/billing",
        opencodeSessionId: SES_INFRA,
      },
    ],
  },
];

// =============================================================================
// Per-window status (sidebar dots + subagent counts). Mirrors the WindowStatusUI
// shape store.ts uses; demoApi.applyStatusBatch reads from here on first
// onStatusEvent subscribe (see demoApi.ts).
// =============================================================================
export const demoStatus: Record<
  string,
  Record<
    number,
    {
      running: boolean;
      subagents: number;
      attention: boolean;
      attentionKind?: "idle" | "question" | "permission";
      lastMessageAt?: number;
    }
  >
> = {
  ethernal: {
    0: { running: true, subagents: 2, attention: false },
    1: {
      running: false,
      subagents: 0,
      attention: true,
      attentionKind: "idle",
      // ~14m ago: amber "aging" stage (50–90% of 1h TTL).
      lastMessageAt: Date.now() - 14 * 60_000,
    },
    2: {
      running: false,
      subagents: 0,
      attention: true,
      attentionKind: "question",
    },
  },
  marketing: {
    0: {
      running: false,
      subagents: 0,
      attention: true,
      attentionKind: "permission",
    },
    1: { running: false, subagents: 0, attention: false },
  },
  infra: {
    0: {
      // Session is mid-flight and blocked on a question/permission pair —
      // `running` is still true (opencode keeps the session "busy" while
      // blocked), `subagents` is 0 (no spawned children yet on this turn).
      running: true,
      subagents: 0,
      attention: false,
    },
  },
};

// =============================================================================
// Active project/window — App.tsx + the store use these as the "now showing"
// session. `infra:0` is the chat panel we render with the demo transcript.
// =============================================================================
export const demoActiveProjectName = "infra";
export const demoActiveWindowIndex = 0;
export const demoActiveSessionId = SES_INFRA;
export const demoBranch = BRANCH;

// =============================================================================
// Opencode transcript — what opencodeMessages returns for the active session.
// One developer-recognisable task: add a CSV export endpoint to the billing
// service. Contains every part-type the ChatPanel renders:
//   - user text
//   - assistant text
//   - tool: todowrite (one item in progress)
//   - tool: read  (with file-line-numbered output)
//   - tool: edit (with a real-looking +38 −4 unified diff in metadata.diff)
//   - tool: bash  (with multi-line command output)
//
// The last assistant message has NO `time.completed` so
// `isAssistantTurnInProgress` returns true → replayChatAttention latches
// attention correctly, the running indicator / ✻ Ruminating… line is
// rendered, and the last step's token usage drives the context bar.
// =============================================================================
export const demoMessages: OpencodeMessage[] = [
  // User turn — the developer asked for a CSV export endpoint.
  {
    info: {
      id: "msg_u1",
      sessionID: SES_INFRA,
      role: "user",
      time: { created: Date.now() - 90_000 },
    },
    parts: [
      {
        type: "text",
        id: "prt_u1_text",
        messageID: "msg_u1",
        text: [
          "Add a `/api/v1/orders/export.csv` endpoint to the billing service.",
          "It should accept the same filters as the existing `GET /orders`",
          "(status, customer_id, created_after, created_before) and stream",
          "the result as CSV. Header row first, then one row per order.",
          "Use the streaming response helper from `app/utils/stream.py` so we",
          "don't load everything into memory — the export could be 100k+ rows.",
        ].join("\n"),
      },
    ],
  },
  // Assistant turn — in flight (no time.completed). Carries the tool calls
  // and a step-finish with realistic token usage.
  {
    info: {
      id: "msg_a1",
      sessionID: SES_INFRA,
      role: "assistant",
      modelID: "claude-opus-4-7",
      providerID: "anthropic",
      // No `time.completed` → session still in flight. `replayChatAttention`
      // and the running indicator both gate on this.
    },
    parts: [
      // Reasoning — hidden by default (Ctrl+O reveals).
      {
        type: "reasoning",
        id: "prt_a1_reasoning",
        messageID: "msg_a1",
        text:
          "The user wants a streaming CSV export. Plan:\n" +
          "1. Look at the existing /orders route to copy the filter parsing.\n" +
          "2. Check the streaming response helper signature.\n" +
          "3. Add the new route — header row first, then rows from the same query.\n" +
          "4. Add a test with a synthetic 200-row dataset.",
      },
      // TodoWrite — one item in_progress to satisfy "todo checklist with one
      // item in progress". Completed items collapse to a faint count so the
      // active row stays dominant.
      {
        type: "tool",
        id: "prt_a1_todo",
        messageID: "msg_a1",
        tool: "todowrite",
        state: {
          status: "completed",
          title: "plan",
          input: {
            todos: [
              {
                content: "Inspect existing /orders route + filter parser",
                status: "completed",
                priority: "high",
              },
              {
                content: "Confirm streaming response helper signature",
                status: "completed",
                priority: "high",
              },
              {
                content: "Add /api/v1/orders/export.csv endpoint",
                status: "in_progress",
                priority: "high",
              },
              {
                content: "Test with 200-row synthetic dataset",
                status: "pending",
                priority: "medium",
              },
              {
                content: "Update API docs",
                status: "pending",
                priority: "low",
              },
            ],
          },
        },
      },
      // Read — collapsed by default to "Read N lines (ctrl+o)". Verbose shows
      // line-numbered output.
      {
        type: "tool",
        id: "prt_a1_read",
        messageID: "msg_a1",
        tool: "read",
        state: {
          status: "completed",
          title: "app/routes/orders.py",
          input: { filePath: "/home/dev/projects/infra/services/billing/app/routes/orders.py" },
          output: [
            "<content>",
            "   1  from fastapi import APIRouter, Depends, Query",
            "   2  from sqlalchemy.ext.asyncio import AsyncSession",
            "   3  from app.db import get_session",
            "   4  from app.models import Order",
            "   5  from app.utils.stream import csv_stream",
            "   6",
            "   7  router = APIRouter(prefix=\"/api/v1/orders\")",
            "   8",
            "   9  @router.get(\"\")",
            "  10  async def list_orders(",
            "  11      status: str | None = Query(default=None),",
            "  12      customer_id: str | None = Query(default=None),",
            "  13      created_after: datetime | None = Query(default=None),",
            "  14      created_before: datetime | None = Query(default=None),",
            "  15      session: AsyncSession = Depends(get_session),",
            "  16  ):",
            "  17      query = Order.query(session)",
            "  18      if status: query = query.filter(Order.status == status)",
            "  19      if customer_id: query = query.filter(Order.customer_id == customer_id)",
            "  20      if created_after: query = query.filter(Order.created_at >= created_after)",
            "  21      if created_before: query = query.filter(Order.created_at <= created_before)",
            "  22      return [o.to_dict() for o in (await query.all()).scalars()]",
            "  23",
            "</content>",
          ].join("\n"),
        },
      },
      // Edit — the +38 −4 diff lives in metadata.diff so the EditBody /
      // UnifiedDiff renderer picks it up directly (ToolCall.tsx ToolHeader
      // extracts `filediff.additions / deletions` from metadata.filediff for
      // the "Added N, removed M" badge).
      {
        type: "tool",
        id: "prt_a1_edit",
        messageID: "msg_a1",
        tool: "edit",
        state: {
          status: "completed",
          title: "app/routes/orders.py",
          input: {
            filePath: "/home/dev/projects/infra/services/billing/app/routes/orders.py",
          },
          metadata: {
            filediff: { additions: 38, deletions: 4 },
            diff: [
              "--- a/app/routes/orders.py",
              "+++ b/app/routes/orders.py",
              "@@ -9,8 +9,46 @@ router = APIRouter(prefix=\"/api/v1/orders\")",
              " ",
              "@@ -9,8 +9,46 @@ router = APIRouter(prefix=\"/api/v1/orders\")",
              " ",
              " @router.get(\"\")",
              "-async def list_orders(",
              "+async def list_orders(",
              "     status: str | None = Query(default=None),",
              "     customer_id: str | None = Query(default=None),",
              "     created_after: datetime | None = Query(default=None),",
              "     created_before: datetime | None = Query(default=None),",
              "     session: AsyncSession = Depends(get_session),",
              "+) -> list[dict]:",
              "+    \"\"\"Return orders as a JSON array.\"\"\"",
              "     query = Order.query(session)",
              "     if status: query = query.filter(Order.status == status)",
              "     if customer_id: query = query.filter(Order.customer_id == customer_id)",
              "     if created_after: query = query.filter(Order.created_at >= created_after)",
              "     if created_before: query = query.filter(Order.created_at <= created_before)",
              "     return [o.to_dict() for o in (await query.all()).scalars()]",
              "+",
              "+",
              "+@router.get(\"/export.csv\")",
              "+async def export_orders_csv(",
              "+    status: str | None = Query(default=None),",
              "+    customer_id: str | None = Query(default=None),",
              "+    created_after: datetime | None = Query(default=None),",
              "+    created_before: datetime | None = Query(default=None),",
              "+    session: AsyncSession = Depends(get_session),",
              "+):",
              "+    \"\"\"Stream orders as CSV. Header row first.\"\"\"",
              "+    query = Order.query(session)",
              "+    if status: query = query.filter(Order.status == status)",
              "+    if customer_id: query = query.filter(Order.customer_id == customer_id)",
              "+    if created_after: query = query.filter(Order.created_at >= created_after)",
              "+    if created_before: query = query.filter(Order.created_at <= created_before)",
              "+    result = await query.stream()",
              "+    return csv_stream(",
              "+        result,",
              "+        header=[\"id\", \"customer_id\", \"status\", \"amount_cents\", \"created_at\"],",
              "+        row=lambda o: [o.id, o.customer_id, o.status, o.amount_cents, o.created_at.isoformat()],",
              "+    )",
            ].join("\n"),
          },
        },
      },
      // Bash — multi-line command + multi-line output. BashBody shows the
      // tail by default; verbose (Ctrl+O) shows everything.
      {
        type: "tool",
        id: "prt_a1_bash",
        messageID: "msg_a1",
        tool: "bash",
        state: {
          status: "running",
          title: "pytest tests/test_orders_export.py -x -q",
          input: {
            command: "pytest tests/test_orders_export.py -x -q",
          },
          // Live progress via metadata.output (resolveToolOutput's fallback
          // for `running` parts). Final `state.output` arrives when the
          // tool completes.
          metadata: {
            output: [
              "============================= test session starts ==============================",
              "platform linux -- Python 3.11.9, pytest-8.0.2, pluggy-1.5.0",
              "rootdir: /home/dev/projects/infra/services/billing",
              "collected 5 items",
              "",
              "tests/test_orders_export.py::test_header_row ............... ",
            ].join("\n"),
          },
        },
      },
      // Step-finish — drives the context bar. ~70k input tokens (mostly
      // cache.read from the system prompt + the long orders.py we just
      // read) gives ~35% on the default 200k Sonnet window.
      {
        type: "step-finish",
        id: "prt_a1_step_finish",
        messageID: "msg_a1",
        reason: "tool_use",
        // The renderer reads tokens from the message info, not the step-finish
        // part, so the matching `info.tokens` block is set below.
      },
      // Visible assistant text (the partial reply streaming in).
      {
        type: "text",
        id: "prt_a1_text",
        messageID: "msg_a1",
        text:
          "Added `/export.csv`. It reuses the same filter query as `GET /orders`, " +
          "streams rows via `csv_stream`, and writes the header first. " +
          "Running the test suite now — should turn green on the new `test_…` cases.",
      },
    ],
  },
];

// Attach cumulative tokens to the in-flight assistant message so the context
// bar (and `latestTokens` memo in ChatPanel) reads a realistic breakdown.
// `OpencodeMessageInfo` doesn't type the `tokens` field directly — the
// renderer reads it via `(info as unknown as { tokens?: TokenUsage }).tokens`
// at chatPanel.tsx:1446, so the same `as unknown as` cast lets us attach
// the live numbers without breaking the typed surface.
demoMessages[1].info = {
  ...demoMessages[1].info,
  ...({
    tokens: {
      input: 1234,
      output: 418,
      reasoning: 67,
      cache: { read: 68_921, write: 0 },
    },
  } as unknown as Record<string, unknown>),
};

// =============================================================================
// Pending question — what opencodeQuestions returns for the active session.
// `requestId` is the `que_…` form so the QuestionCard's reply button can
// call opencodeQuestionReply (a missing requestId would make the card
// unanswerable, per the spec). Hydrated through chatUtils.hydrateQuestion so
// the renderer sees both `id` (= callID) and `requestId` (= que_…).
// =============================================================================
export const demoQuestion: QuestionRequest = {
  id: "call_q_export_format",
  sessionID: SES_INFRA,
  requestId: "que_demo_question_001",
  questions: [
    {
      question: "Which CSV column ordering should `/export.csv` use?",
      header: "Column order",
      options: [
        {
          label: "Match the JSON shape",
          description: "id, customer_id, status, amount_cents, created_at — same as `GET /orders`",
        },
        {
          label: "Customer-friendly",
          description: "id, created_at, status, amount_cents, customer_id — groups by reading order",
        },
        {
          label: "Custom (specify in notes)",
          description: "Use the explicit column list from the free-text field",
        },
      ],
    },
  ],
  tool: { messageID: "msg_a1", callID: "call_q_export_format" },
};

// =============================================================================
// Pending permission — what opencodePermissions returns for the active
// session. The renderer's PermissionCard renders this verbatim with the
// "Once / Always / Reject" buttons. `patterns` and `always` drive the
// "always" grant scope preview.
// =============================================================================
export const demoPermission: PermissionRequest = {
  id: "call_p_run_migrations",
  sessionID: SES_INFRA,
  permission: "bash",
  patterns: ["alembic upgrade head"],
  always: ["alembic upgrade *"],
  metadata: {
    tool: "bash",
    args: { command: "alembic upgrade head" },
  },
  tool: { messageID: "msg_a1", callID: "call_p_run_migrations" },
};

// =============================================================================
// Opencode session list — what opencodeListSessions returns. Drives the
// backfillLastMessageTimes fan-out (the most recent active chat session's
// `time.updated` becomes its sidebar age label).
// =============================================================================
export const demoSessionList: OpencodeSessionListItem[] = [
  {
    id: SES_INFRA,
    slug: "deploy-billing",
    title: "Deploy new billing service",
    directory: "/home/dev/projects/infra/terraform/billing",
    time: { created: Date.now() - 90_000, updated: Date.now() - 30_000 },
    model: { id: "claude-opus-4-7", providerID: "anthropic" },
    tokens: { input: 70_155, output: 485 },
  },
  {
    id: SES_ETHERNAL_RUN,
    slug: "csv-export",
    title: "Add CSV export",
    directory: "/home/dev/projects/ethernal/services/billing",
    time: { created: Date.now() - 600_000, updated: Date.now() - 5_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
  {
    id: SES_ETHERNAL_IDLE,
    slug: "refactor-auth",
    title: "Refactor auth middleware",
    directory: "/home/dev/projects/ethernal/services/auth",
    time: { created: Date.now() - 3_600_000, updated: Date.now() - 14 * 60_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
  {
    id: SES_ETHERNAL_QUESTION,
    slug: "orders-500s",
    title: "Investigate 500s in /api/v1/orders",
    directory: "/home/dev/projects/ethernal/services/orders",
    time: { created: Date.now() - 1_800_000, updated: Date.now() - 60_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
  {
    id: SES_MARKETING_PERM,
    slug: "landing-copy",
    title: "Landing page copy iteration",
    directory: "/home/dev/projects/marketing-site/app",
    time: { created: Date.now() - 720_000, updated: Date.now() - 45_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
];

// =============================================================================
// Opencode models — what opencodeModels returns. Used by ChatPanel's model
// picker. Trimmed to two providers for the demo.
// =============================================================================
export const demoModels: OpencodeModel[] = [
  {
    id: "claude-opus-4-7",
    providerID: "anthropic",
    name: "Claude Opus 4.7",
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 32_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  },
  {
    id: "claude-sonnet-4-6",
    providerID: "anthropic",
    name: "Claude Sonnet 4.6",
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 16_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  },
];

// =============================================================================
// Aggregate demo state — single import for demoApi.ts. Keeps the fixture file
// discoverable from one place: `import { demoState } from "./demoFixture"`,
// then read `demoState.config`, `demoState.projects`, etc.
// =============================================================================
export const demoState = {
  config: demoAppConfig,
  projects: demoProjects,
  status: demoStatus,
  activeProjectName: demoActiveProjectName,
  activeWindowIndex: demoActiveWindowIndex,
  activeSessionId: demoActiveSessionId,
  branch: demoBranch,
  messages: demoMessages,
  question: demoQuestion,
  permission: demoPermission,
  sessions: demoSessionList,
  models: demoModels,
};

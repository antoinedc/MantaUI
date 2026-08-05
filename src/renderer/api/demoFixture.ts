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
  AvailableLauncher,
  OpencodeMessage,
  OpencodeModel,
  PermissionRequest,
  Project,
  QuestionRequest,
  OpencodeSessionListItem,
  ServedPageMeta,
  WorktreeInfo,
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

// Fixed reference timestamp — anchors every relative offset in the fixture
// so two consecutive renders of the hero video are byte-comparable (per the
// BET-322 acceptance test) and the screenshot harness's existing drift
// gate (BET-303 → BET-341) stays byte-identical across PR-time runs.
// `Date.now()` would shift every offset on every run.
export const DEMO_T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z.

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
      lastMessageAt: DEMO_T0 - 14 * 60_000,
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
      time: { created: DEMO_T0 - 90_000 },
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
  // ===== BET-660 artifact demo content =====
  // User turn — a pasted external link (the RFC 4180 card), user-"sent" files
  // (a CSV + PDF in the Files tab) and two user screenshots (Images tab).
  {
    info: { id: "msg_u_art", sessionID: SES_INFRA, role: "user", time: { created: DEMO_T0 - 20 * 60_000 } },
    parts: [
      {
        type: "text",
        id: "prt_u_art",
        messageID: "msg_u_art",
        text: "here's the RFC https://datatracker.ietf.org/doc/html/rfc4180 — the quoting rules are what always breaks naive parsers",
      },
      {
        type: "file",
        id: "prt_u_csv",
        messageID: "msg_u_art",
        mime: "text/csv",
        size: 1_258_291,
        url: "file:///home/dev/projects/infra/services/billing/uploads/q3-revenue.csv",
        filename: "q3-revenue.csv",
      },
      {
        type: "file",
        id: "prt_u_pdf",
        messageID: "msg_u_art",
        mime: "application/pdf",
        size: 5_033_164,
        url: "file:///home/dev/projects/infra/services/billing/uploads/brand-guidelines.pdf",
        filename: "brand-guidelines.pdf",
      },
      {
        type: "file",
        id: "prt_u_img1",
        messageID: "msg_u_art",
        mime: "image/png",
        size: 1_431_656,
        url: "file:///home/dev/projects/infra/services/billing/uploads/Screenshot 2026-08-05 at 09.12.41.png",
        filename: "Screenshot 2026-08-05 at 09.12.41.png",
      },
      {
        type: "file",
        id: "prt_u_img2",
        messageID: "msg_u_art",
        mime: "image/png",
        size: 1_208_314,
        url: "file:///home/dev/projects/infra/services/billing/uploads/Screenshot 2026-08-05 at 09.15.02.png",
        filename: "Screenshot 2026-08-05 at 09.15.02.png",
      },
    ],
  },
  // Assistant turn — agent-"generated" output: a generated CSV, an agent UI
  // screenshot pair, and the two hosted pages the Links tab renders (their
  // URLs appear here so deriveArtifacts can match context onto them).
  {
    info: { id: "msg_a_art", sessionID: SES_INFRA, role: "assistant", modelID: "claude-opus-4-7", providerID: "anthropic", time: { created: DEMO_T0 - 10 * 60_000 } },
    parts: [
      {
        type: "file",
        id: "prt_a_csv",
        messageID: "msg_a_art",
        mime: "text/csv",
        size: 862_208,
        url: "file:///home/dev/projects/infra/services/billing/uploads/cohort-analysis.csv",
        filename: "cohort-analysis.csv",
      },
      {
        type: "file",
        id: "prt_a_img1",
        messageID: "msg_a_art",
        mime: "image/png",
        size: 988_160,
        url: "file:///home/dev/projects/infra/services/billing/uploads/export-preview.png",
        filename: "export-preview.png",
      },
      {
        type: "file",
        id: "prt_a_img2",
        messageID: "msg_a_art",
        mime: "image/png",
        size: 1_056_768,
        url: "file:///home/dev/projects/infra/services/billing/uploads/api-docs-diff.png",
        filename: "api-docs-diff.png",
      },
      {
        type: "text",
        id: "prt_a_art_text",
        messageID: "msg_a_art",
        text:
          "Both are up — the split view keeps the transcript readable at narrow widths: " +
          `${SERVER_URL}/pages/artifacts-panel and ${SERVER_URL}/pages/composer-v2.`,
      },
    ],
  },
  // A second, older "Yesterday" group: one agent-generated report + migration
  // notes + two agent screenshots, so Images and Files both span two day groups.
  {
    info: { id: "msg_a_art2", sessionID: SES_INFRA, role: "assistant", modelID: "claude-opus-4-7", providerID: "anthropic", time: { created: DEMO_T0 - 86_400_000 - 40 * 60_000 } },
    parts: [
      {
        type: "file",
        id: "prt_a_retention",
        messageID: "msg_a_art2",
        mime: "application/pdf",
        size: 1_153_433,
        url: "file:///home/dev/projects/infra/services/billing/uploads/retention-report.pdf",
        filename: "retention-report.pdf",
      },
      {
        type: "file",
        id: "prt_a_notes",
        messageID: "msg_a_art2",
        mime: "text/markdown",
        size: 12_288,
        url: "file:///home/dev/projects/infra/services/billing/uploads/migration-notes.md",
        filename: "migration-notes.md",
      },
      {
        type: "file",
        id: "prt_a_oldimg",
        messageID: "msg_a_art2",
        mime: "image/png",
        size: 1_675_568,
        url: "file:///home/dev/projects/infra/services/billing/uploads/cohort-grid.png",
        filename: "cohort-grid.png",
      },
      {
        type: "file",
        id: "prt_a_oldimg2",
        messageID: "msg_a_art2",
        mime: "image/png",
        size: 1_310_720,
        url: "file:///home/dev/projects/infra/services/billing/uploads/Screenshot 2026-08-03 at 16.40.12.png",
        filename: "Screenshot 2026-08-03 at 16.40.12.png",
      },
      {
        type: "text",
        id: "prt_a_art2_text",
        messageID: "msg_a_art2",
        text:
          "Three densities side by side — compact is the one that survives at 1280px: " +
          `${SERVER_URL}/pages/sidebar-density.`,
      },
    ],
  },
];

// Hosted pages the artifacts panel's Links tab renders. sessionID matches the
// active demo session so deriveArtifacts includes them. Expiry anchors to the
// capture's real "now" (evaluated at module load) — NOT DEMO_T0 — because the
// panel computes pageState(expiresAt, Date.now()) against the LIVE clock, and a
// DEMO_T0-anchored expiry (Nov 2023) would render every page "expired" in a
// real-time capture. Anchoring to now keeps the live/soon/expired pill states
// faithful to the mockup's `.mk-links`: one live (23h), one soon (2h), one dead.
export const demoPages: ServedPageMeta[] = [
  {
    subdomain: "artifacts-panel",
    url: `${SERVER_URL}/pages/artifacts-panel`,
    expiresAt: Date.now() + 23 * 3_600_000,
    createdAt: Date.now() - 3_600_000,
    sessionID: SES_INFRA,
  },
  {
    subdomain: "composer-v2",
    url: `${SERVER_URL}/pages/composer-v2`,
    expiresAt: Date.now() + 2 * 3_600_000,
    createdAt: Date.now() - 2 * 3_600_000,
    sessionID: SES_INFRA,
  },
  {
    subdomain: "sidebar-density",
    url: `${SERVER_URL}/pages/sidebar-density`,
    expiresAt: Date.now() - 1_000,
    createdAt: Date.now() - 86_400_000 - 30 * 60_000,
    sessionID: SES_INFRA,
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
//
// Timestamps are anchored to `DEMO_T0` (a fixed reference moment, NOT
// `Date.now()`) so the hero-video render is deterministic across runs. The
// screenshot harness already exercises this property (`prefers-reduced-motion`
// + the byte-equal drift gate in scripts/shots.mjs); keeping the fixture
// deterministic lets the video reproduce the same stills it composes from.
// =============================================================================
export const demoSessionList: OpencodeSessionListItem[] = [
  {
    id: SES_INFRA,
    slug: "deploy-billing",
    title: "Deploy new billing service",
    directory: "/home/dev/projects/infra/terraform/billing",
    time: { created: DEMO_T0 - 90_000, updated: DEMO_T0 - 30_000 },
    model: { id: "claude-opus-4-7", providerID: "anthropic" },
    tokens: { input: 70_155, output: 485 },
  },
  {
    id: SES_ETHERNAL_RUN,
    slug: "csv-export",
    title: "Add CSV export",
    directory: "/home/dev/projects/ethernal/services/billing",
    time: { created: DEMO_T0 - 600_000, updated: DEMO_T0 - 5_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
  {
    id: SES_ETHERNAL_IDLE,
    slug: "refactor-auth",
    title: "Refactor auth middleware",
    directory: "/home/dev/projects/ethernal/services/auth",
    time: { created: DEMO_T0 - 3_600_000, updated: DEMO_T0 - 14 * 60_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
  {
    id: SES_ETHERNAL_QUESTION,
    slug: "orders-500s",
    title: "Investigate 500s in /api/v1/orders",
    directory: "/home/dev/projects/ethernal/services/orders",
    time: { created: DEMO_T0 - 1_800_000, updated: DEMO_T0 - 60_000 },
    model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
  },
  {
    id: SES_MARKETING_PERM,
    slug: "landing-copy",
    title: "Landing page copy iteration",
    directory: "/home/dev/projects/marketing-site/app",
    time: { created: DEMO_T0 - 720_000, updated: DEMO_T0 - 45_000 },
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
  // Third model exists so the visual gate can capture the effort picker's
  // OPEN state (BET-511): the two default models expose no `variants`, which
  // leaves the effort button permanently disabled. This one carries a variant
  // list, so selecting it enables the picker and its dropdown can be opened by
  // a real user gesture. It is NOT the default active model, so existing
  // captures (whose effort pill stays "High" [disabled]) are unchanged — it
  // only renders inside the model-picker dropdown once that is opened.
  {
    id: "claude-opus-4-7-thinking",
    providerID: "anthropic",
    name: "Claude Opus 4.7 Rationale",
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 32_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [{ id: "balanced" }, { id: "maximum" }],
  },
  // The `-fast` twin of the model above, so the composer's ⚡ fast-mode toggle
  // has something to switch to once that model is selected. It is deliberately
  // NOT listed in the model dropdown (ModelPicker hides a `-fast` id whose base
  // is present) — reaching it IS the toggle. It carries only "balanced", which
  // also exercises the disabled-at-this-effort branch: pick "maximum" on the
  // base model and the toggle greys out.
  {
    id: "claude-opus-4-7-thinking-fast",
    providerID: "anthropic",
    name: "Claude Opus 4.7 Rationale Fast",
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 32_000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [{ id: "balanced" }],
  },
];

// AI-CLI TUI launchers the box reports (src/server/launcherRegistry.mjs,
// filtered to the renderer-visible fields). TWO entries on purpose: `claude`
// has a flag so it renders in Settings' "CLI launch options" card, `codex`
// has none so it is filtered out of that card while still appearing in the
// session menu — one fixture exercising both branches of the filter.
export const demoLaunchers: AvailableLauncher[] = [
  {
    id: "claude",
    label: "Claude Code",
    flags: [
      {
        key: "skipPermissions",
        label: "Skip all permission prompts",
        type: "boolean",
        default: true,
      },
    ],
  },
  { id: "codex", label: "Codex", flags: [] },
];

// =============================================================================
// Folder picker listing (BET-562). The folder picker modal is opened in the
// demo empty state by clicking the "Home" chip; `fsListDirs`/`gitListWorktrees`
// are NOT covered by the httpApi-shaped Proxy fallback (which resolves null
// and would leave the list as a raw "Cannot read properties of null" error),
// so the demo stubs a fictional home-directory listing. Fictional names only —
// node_modules and the dot-folder are exercised deliberately so the dimmed
// rows (isDimmedDir) appear.
//
// The `~/projects` nesting exists so the captured state can descend ONE level
// out of "~" (a real user gesture: clicking a folder row). The empty-state
// path is literally "~", which Playwright serialises as `textbox: ~` — and
// `~` is YAML's null literal, so Playwright's aria snapshot rejects it with
// "Node value should be a string or a sequence". Descending to `~/projects`
// puts a real path in the field and makes the structure round-trip (BET-562).
// =============================================================================
export const demoHomeDirs = [
  "~/backups",
  "~/docker",
  "~/docs",
  "~/infra",
  "~/marketing",
  "~/node_modules",
  "~/projects",
  "~/scripts",
  "~/.config",
];

export const demoProjectsDirs = [
  "~/projects/ethernal",
  "~/projects/marketing",
  "~/projects/infra",
];

export function demoFsListDirs(partial: string): string[] {
  if (!partial) return [];
  const p = partial.endsWith("/") ? partial : `${partial}/`;
  if (p === "~/") return demoHomeDirs;
  if (p === "~/projects/") return demoProjectsDirs;
  return [...demoHomeDirs, ...demoProjectsDirs].filter((d) => d.startsWith(partial));
}

export function demoGitListWorktrees(_cwd: string): WorktreeInfo[] {
  return [];
}

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
  pages: demoPages,
  question: demoQuestion,
  permission: demoPermission,
  sessions: demoSessionList,
  models: demoModels,
  launchers: demoLaunchers,
};

// =============================================================================
// Time-varying fixture — `demoStateAt(t)` returns a snapshot of the demo
// state evaluated at `t` seconds from the start of the hero video. A still
// is one evaluation of this; six beats per BET-304's description:
//
//   1. Desktop. User submits a task. Agent begins, tool calls streaming.
//   2. The laptop closes. Desktop frame dims out.
//   3. Hold on nothing for a beat — do not rush this; it's the whole argument.
//   4. Phone lights up with a push notification: permission needed.
//   5. Tap Allow on the phone. Transcript continues on the phone.
//   6. Desktop reopens, already caught up. Tests pass. Work is done.
//
// `t` is in seconds. The whole sequence runs roughly 50s. We extend the
// existing fixture rather than writing a second one (per BET-304); the static
// `demoState` above is just `demoStateAt(0)`.
//
// `applyDemoStateAt(t)` mutates the module-level `demoState` in-place so the
// existing demoApi (which captures `demoState.*` lazily via the Proxy) sees
// the new values on its next call. Returns the (mutated) `demoState` for
// callers that want to chain.
//
// All timestamps are derived from `DEMO_T0` (no `Date.now()` leakage) so two
// consecutive renders are byte-comparable (per the BET-322 acceptance test).
// =============================================================================

// Snapshot type — extends the static `demoState` shape with the time-varying
// fields whose types can be null in certain beats (active session is null on
// the "hold on nothing" beat; question/permission are null when resolved).
// The cast at the end of `demoStateAt` keeps the surface a superset of
// `demoState`'s shape so demoApi can keep its un-narrowed property accesses.
type DemoStateSnapshot = {
  config: typeof demoState.config;
  projects: typeof demoState.projects;
  status: typeof demoState.status;
  activeProjectName: string | null;
  activeWindowIndex: number | null;
  activeSessionId: string | null;
  branch: string;
  messages: typeof demoState.messages;
  pages: typeof demoState.pages;
  question: typeof demoQuestion | null;
  permission: typeof demoPermission | null;
  sessions: typeof demoState.sessions;
  models: typeof demoState.models;
};

// Six-beat timeline (seconds). Boundaries chosen so each beat gets roughly
// 6–10s — long enough for the visual to register, short enough to keep the
// total under the 50–70s budget.
export const HERO_BEATS = {
  // Beat 1 — desktop active, agent mid-stream (Bash running, permission pending).
  BEAT_1_END: 10,
  // Beat 2 — laptop closes, desktop dimming.
  BEAT_2_END: 14,
  // Beat 3 — hold on nothing.
  BEAT_3_END: 24,
  // Beat 4 — phone lights up with push notification: permission needed.
  BEAT_4_END: 28,
  // Beat 5 — tap Allow, transcript continues on phone.
  BEAT_5_END: 36,
  // Beat 6 — desktop reopens, agent done, tests pass. Total ~50s.
  BEAT_6_END: 50,
};

// The two `PermissionRequest` clones we swap between. Beat 1 + 5: pending
// permission. Beat 6: resolved (null) — the assistant completed and the
// permission is no longer pending. Beat 3 / 4: irrelevant (no card visible).
const PERMISSION_PENDING = demoPermission;

function beatState(t: number): {
  activeProjectName: string | null;
  activeWindowIndex: number | null;
  activeSessionId: string | null;
  // Whether the desktop frame is "lit" (alpha 1) or dimming.
  desktopLit: number;
  // Whether the phone frame is visible (alpha > 0).
  phoneLit: number;
  // Whether the phone shows the session-list or the active chat session.
  phoneScreen: "list" | "session";
  // The currently-rendered permission request (or null when resolved).
  currentPermission: typeof demoPermission | null;
  // The currently-rendered question request (or null when resolved).
  currentQuestion: typeof demoQuestion | null;
  // Whether the in-flight assistant message is still running (no
  // `time.completed`) or has finished (time.completed set). Drives the
  // running dot + "Ruminating…" line.
  assistantRunning: boolean;
} {
  // Default: Beat 1 / desktop / running / pending permission.
  if (t < HERO_BEATS.BEAT_1_END) {
    return {
      activeProjectName: demoActiveProjectName,
      activeWindowIndex: demoActiveWindowIndex,
      activeSessionId: demoActiveSessionId,
      desktopLit: 1,
      phoneLit: 0,
      phoneScreen: "list",
      currentPermission: PERMISSION_PENDING,
      currentQuestion: demoQuestion,
      assistantRunning: true,
    };
  }
  // Beat 2 — laptop closes. Desktop dimming, otherwise same as beat 1.
  if (t < HERO_BEATS.BEAT_2_END) {
    return {
      activeProjectName: demoActiveProjectName,
      activeWindowIndex: demoActiveWindowIndex,
      activeSessionId: demoActiveSessionId,
      desktopLit: 0.15, // dim — visible only as a hint of "the box is still working"
      phoneLit: 0,
      phoneScreen: "list",
      currentPermission: PERMISSION_PENDING,
      currentQuestion: demoQuestion,
      assistantRunning: true,
    };
  }
  // Beat 3 — hold on nothing. No active UI.
  if (t < HERO_BEATS.BEAT_3_END) {
    return {
      activeProjectName: null,
      activeWindowIndex: null,
      activeSessionId: null,
      desktopLit: 0,
      phoneLit: 0,
      phoneScreen: "list",
      currentPermission: null,
      currentQuestion: null,
      assistantRunning: true,
    };
  }
  // Beat 4 — phone lights up. Show the active session on phone with the
  // permission card visible (the push notification beats 4's visual).
  if (t < HERO_BEATS.BEAT_4_END) {
    return {
      activeProjectName: demoActiveProjectName,
      activeWindowIndex: demoActiveWindowIndex,
      activeSessionId: demoActiveSessionId,
      desktopLit: 0,
      phoneLit: 1,
      phoneScreen: "session",
      currentPermission: PERMISSION_PENDING,
      currentQuestion: demoQuestion,
      assistantRunning: true,
    };
  }
  // Beat 5 — tap Allow on phone; transcript continues on the phone.
  if (t < HERO_BEATS.BEAT_5_END) {
    return {
      activeProjectName: demoActiveProjectName,
      activeWindowIndex: demoActiveWindowIndex,
      activeSessionId: demoActiveSessionId,
      desktopLit: 0,
      phoneLit: 1,
      phoneScreen: "session",
      currentPermission: null, // user tapped Allow
      currentQuestion: demoQuestion,
      assistantRunning: true,
    };
  }
  // Beat 6 — desktop reopens. Caught up. Tests pass. Agent finished.
  return {
    activeProjectName: demoActiveProjectName,
    activeWindowIndex: demoActiveWindowIndex,
    activeSessionId: demoActiveSessionId,
    desktopLit: 1,
    phoneLit: 0,
    phoneScreen: "session",
    currentPermission: null,
    currentQuestion: null,
    assistantRunning: false,
  };
}

export function demoStateAt(t: number): DemoStateSnapshot {
  const beat = beatState(t);
  // The status block is keyed by project → window → status fields. We mutate
  // a shallow clone so we never trash the source `demoStatus` between calls.
  const status: typeof demoStatus = JSON.parse(JSON.stringify(demoStatus));
  if (beat.activeSessionId) {
    // Find the (project, window) that owns the active session. The infra
    // session is the one with the question + permission cards in the
    // fixture; mirror that session's state.
    const [projName, winIdx] =
      beat.activeSessionId === SES_INFRA
        ? ["infra", 0]
        : beat.activeSessionId === SES_ETHERNAL_RUN
          ? ["ethernal", 0]
          : beat.activeSessionId === SES_MARKETING_PERM
            ? ["marketing", 0]
            : ["infra", 0];
    const ownerStatus = status[projName]?.[winIdx];
    if (ownerStatus) {
      ownerStatus.running = beat.assistantRunning;
      ownerStatus.attention =
        beat.currentPermission !== null || beat.currentQuestion !== null;
      ownerStatus.attentionKind = beat.currentPermission
        ? "permission"
        : beat.currentQuestion
          ? "question"
          : "idle";
      // lastMessageAt advances with `t` so the sidebar's "now" label feels
      // live during the video. Anchored on DEMO_T0 so the value is stable
      // across renders.
      ownerStatus.lastMessageAt = DEMO_T0 - Math.round(t * 1000);
    }
  }
  return {
    config: demoState.config,
    projects: demoState.projects,
    status,
    activeProjectName: beat.activeProjectName,
    activeWindowIndex: beat.activeWindowIndex,
    activeSessionId: beat.activeSessionId,
    branch: demoState.branch,
    messages: demoState.messages,
    pages: demoState.pages,
    question: beat.currentQuestion,
    permission: beat.currentPermission,
    sessions: demoState.sessions,
    models: demoState.models,
  };
}

// Mutate the module-level `demoState` in place so the demoApi (which closes
// over `demoState` lazily via the module reference) sees the time-varying
// values on its next call. The status block is rebuilt as a fresh object so
// deep-equal checks in the renderer pick up the change.
//
// Returns the same `demoState` object so callers can chain.
export function applyDemoStateAt(t: number): typeof demoState {
  const next = demoStateAt(t);
  demoState.status = next.status as typeof demoState.status;
  // The static `demoState` types `activeProjectName` / `activeWindowIndex` /
  // `activeSessionId` as non-nullable (their demoState-at-t=0 values), but
  // the time-varying fixture legitimately returns null on the "hold on
  // nothing" beat. The renderer treats null as "no active session" via the
  // same path the httpApi takes when a session is killed mid-flight.
  demoState.activeProjectName =
    (next.activeProjectName as typeof demoState.activeProjectName) ?? null;
  demoState.activeWindowIndex =
    (next.activeWindowIndex as typeof demoState.activeWindowIndex) ?? null;
  demoState.activeSessionId =
    (next.activeSessionId as typeof demoState.activeSessionId) ?? null;
  demoState.question = next.question as typeof demoState.question;
  demoState.permission = next.permission as typeof demoState.permission;
  // Stamp a `time.completed` on the in-flight assistant message when the
  // assistant is no longer running. The renderer checks this to decide
  // whether to render the "Ruminating…" line / pulsing running dot.
  if (!next.activeSessionId) {
    // No active session; leave the message alone.
  } else if (demoMessages[1].info) {
    const info = demoMessages[1].info as { time?: { completed?: number } };
    if (next.activeProjectName === demoActiveProjectName) {
      info.time = info.time ?? {};
      if (next.activeSessionId === demoActiveSessionId) {
        info.time.completed = next.activeSessionId
          ? (beatState(t).assistantRunning ? undefined : DEMO_T0)
          : undefined;
      } else {
        info.time.completed = undefined;
      }
    } else {
      info.time = { completed: DEMO_T0 };
    }
  }
  return demoState;
}

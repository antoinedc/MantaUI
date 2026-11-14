// demoBackground.ts — the `background` demo state's job fixture.
//
// Six running jobs of the default demo conversation, one per state the parent's
// background-job card (BackgroundCards.tsx RunCard) can show with the box's
// progress `view` (spec 2026-11-14 B6): working with steps, without steps,
// needs a decision, quiet for a while, details open, plan grew. Served ONLY in
// the `background` state, so no other baseline moves.
//
// Every time is an anchor against DEMO_T0, the renderer's pinned demo clock
// (pinDemoClock), and `asOf` is DEMO_T0 itself, so the client clock's skew is 0
// and elapsed / quiet / time left render the same on every capture.

import type { DelegateJob, DelegateJobProgressView } from "../../shared/types";
import { DEMO_T0, demoActiveSessionId } from "./demoFixture";

const MIN = 60_000;

const STEP_TEXTS = [
  "Read the billing service layout",
  "Add the CSV serializer",
  "Wire the /export route",
  "Write the export tests",
  "Update the OpenAPI schema",
  "Run the full suite",
  "Open the pull request",
];

const DOCS_STEP_TEXTS = [
  "Inventory the old docs pages",
  "Set up the new site scaffold",
  "Port the guides",
  "Port the API reference",
  "Port the changelog",
  "Redirect the old URLs",
  "Verify every link",
];

const MIGRATION_STEP_TEXTS = [
  "Read the migration plan",
  "Back up the invoice table",
  "Choose the column policy",
  "Apply the migration",
  "Verify the row counts",
];

type Steps = NonNullable<DelegateJobProgressView["steps"]>;

/** A checklist of `total` items: the first `done` finished, the next current, the rest pending. */
const checklistOf = (done: number, total: number, texts: string[]): Steps["items"] =>
  texts.slice(0, total).map((text, i) => ({ text, status: i < done ? "done" : i === done ? "current" : "pending" }));

const base: DelegateJobProgressView = {
  rev: { epoch: 1, n: 1 },
  asOf: DEMO_T0,
  state: "working",
  headline: "",
  headlineSource: "none",
  steps: null,
  bar: null,
  live: null,
  startedAt: DEMO_T0 - 12 * MIN,
  endedAt: null,
  lastProgressAt: DEMO_T0 - MIN,
  ceilingAt: DEMO_T0 + 4 * 60 * MIN,
  milestones: [],
  files: null,
  usage: null,
  model: null,
};

const stepsOf = (done: number, total: number, over: Partial<Steps> = {}, texts: string[] = STEP_TEXTS): Steps => ({
  done,
  total,
  current: texts[done] ?? null,
  items: checklistOf(done, total, texts),
  source: "checklist",
  planRevision: 1,
  grewAt: null,
  ...over,
});

const job = (id: string, name: string, view: DelegateJobProgressView, n: number): DelegateJob =>
  ({
    id,
    name,
    prompt: "",
    model: null,
    parentSessionID: demoActiveSessionId,
    parentDirectory: "/home/dev/projects/infra/terraform/billing",
    childSessionID: `ses_demo_bg_${n}`,
    tmuxSession: null,
    windowIndex: null,
    worktree: null,
    branch: null,
    baseSha: null,
    status: "running",
    activity: null,
    createdAt: DEMO_T0,
    startedAt: view.startedAt ?? DEMO_T0,
    finishedAt: null,
    result: null,
    error: null,
    filesChanged: null,
    origin: "delegate",
    engine: "v2",
    completionOwner: "manta",
    launchState: "running",
    attempt: 1,
    view,
  }) as DelegateJob;

export const demoBackgroundJobs: DelegateJob[] = [
  job(
    "job-steps",
    "csv-export-endpoint",
    { ...base, headline: "Writing the export tests", headlineSource: "model", steps: stepsOf(3, 7), bar: 3 / 7 },
    1,
  ),
  job("job-plain", "audit-retry-config", { ...base, headline: "Reading the retry config loader", headlineSource: "model" }, 2),
  job(
    "job-blocked",
    "migrate-invoice-table",
    {
      ...base,
      state: "needs-decision",
      headline: "Drop the legacy column or keep it nullable?",
      headlineSource: "model",
      steps: stepsOf(2, 5, {}, MIGRATION_STEP_TEXTS),
      bar: 2 / 5,
    },
    3,
  ),
  job(
    "job-quiet",
    "rotate-service-keys",
    {
      ...base,
      headline: "Running the full integration suite",
      headlineSource: "model",
      steps: stepsOf(5, 7),
      bar: 5 / 7,
      lastProgressAt: DEMO_T0 - 6 * MIN,
      live: { tool: "bash", target: "npm run test:integration", startedAt: DEMO_T0 - 6 * MIN },
    },
    4,
  ),
  job(
    "job-details",
    "billing-ledger-split",
    {
      ...base,
      headline: "Splitting the ledger writer",
      headlineSource: "model",
      steps: stepsOf(4, 7),
      bar: 4 / 7,
      startedAt: DEMO_T0 - 3 * 60 * MIN - 38 * MIN,
      ceilingAt: DEMO_T0 + 22 * MIN,
      live: { tool: "edit", target: "src/ledger/writer.ts", startedAt: DEMO_T0 - 20_000 },
      milestones: [
        { at: DEMO_T0 - 30_000, text: "Found the double-write in the ledger path" },
        { at: DEMO_T0 - 41 * MIN, text: "Reproduced the rounding drift with a failing test" },
        { at: DEMO_T0 - 2 * 60 * MIN, text: "Mapped every caller of the old writer" },
      ],
      files: { changed: 9 },
      usage: { tokens: 412_800, costUsd: 3.18, costPartial: false },
    },
    5,
  ),
  job(
    "job-grew",
    "docs-site-migration",
    {
      ...base,
      headline: "Porting the API reference pages",
      headlineSource: "model",
      steps: stepsOf(3, 7, { planRevision: 2, grewAt: DEMO_T0 - 30_000 }, DOCS_STEP_TEXTS),
      bar: 3 / 7,
    },
    6,
  ),
];

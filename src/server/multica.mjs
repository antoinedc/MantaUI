// multica.mjs — thin read wrapper over the `multica` CLI (BET-1164, issue 1/3).
//
// The "On-call CTO" board read. Multica is an EXTERNAL integration, not a
// native Manta engine — this module is the one place the box shells out to the
// `multica` CLI to answer "what's on the board", "what did we ship", "what are
// the task runs / PRs for issue X". It is deliberately THIN: every heavy
// decision is delegated to the CLI/REST and this module only shapes the result
// for the cto agent.
//
// Design (mirrors the rest of src/server): pure-ish decision logic + injected
// I/O. The default `runCli` spawns `multica`; tests inject a fake so they never
// touch a live workspace or require the CLI to be installed.
//
// Read-only everywhere. Never mutates the board.
//
// No read throws on a quiet/failed board: an unreadable list degrades to an
// empty board, and a per-issue helper that fails returns null for that part —
// the cto agent still gets what loaded.

import { spawn } from "node:child_process";

const RUN_TIMEOUT_MS = 20_000;

export function workspaceEnv(workspaceId, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (typeof workspaceId === "string" && workspaceId) env.MULTICA_WORKSPACE_ID = workspaceId;
  return env;
}

/**
 * Default CLI runner. Spawns `multica` with the workspace env injected, a
 * bounded timeout, and streams stdout back. Rejects with a trimmed error on a
 * non-zero exit or a spawn failure — callers wrap this best-effort.
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.workspaceId]
 * @param {string} [opts.bin]
 * @returns {Promise<string>} stdout
 */
export function defaultRunCli(args, { workspaceId, bin = "multica", timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let p;
    try {
      p = spawn(bin, args, { env: workspaceEnv(workspaceId), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`multica timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref();
    p.stdout.on("data", (b) => (out += b.toString()));
    p.stderr.on("data", (b) => (err += b.toString()));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(err.trim() || `multica exited ${code}`));
      }
    });
  });
}

function parseJson(stdout, fallback) {
  if (!stdout) return fallback;
  try {
    const v = JSON.parse(stdout);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

async function runBestEffort(runCli, args) {
  try {
    const stdout = await runCli(args);
    return parseJson(stdout, null);
  } catch {
    return null; // per-part failure never fails the whole read
  }
}

/**
 * The board read, shaped for the cto agent.
 *
 * With an `issue` key (e.g. "BET-123") returns that issue's detail plus its
 * task-runs and linked pull requests (each best-effort — a failure yields null
 * for that part). Without one returns a board overview: the open issues
 * grouped by status. Always resolves; failures degrade to empty data.
 *
 * @param {object} [input]
 * @param {string} [input.query]   informational intent (the cto agent's framing)
 * @param {string|null} [input.issue]  optional issue key
 * @param {number} [input.limit]   how many issues the overview reads (default 50)
 * @param {object} [deps]
 * @param {(args: string[], opts?: object) => Promise<string>} [deps.runCli]
 * @param {string} [deps.workspaceId]
 * @returns {Promise<object>}
 */
export async function queryMultica({ query, issue, limit = 50 } = {}, deps = {}) {
  const runCli = deps.runCli ?? defaultRunCli;
  const workspaceId = deps.workspaceId ?? process.env.MULTICA_WORKSPACE_ID;

  if (issue) {
    const [detail, runs, prs, children] = await Promise.all([
      runBestEffort(runCli, ["issue", "get", issue, "--output", "json"]),
      runBestEffort(runCli, ["issue", "runs", issue, "--output", "json"]),
      runBestEffort(runCli, ["issue", "pull-requests", issue, "--output", "json"]),
      runBestEffort(runCli, ["issue", "children", issue, "--output", "json"]),
    ]);
    return {
      ok: true,
      issue: issue,
      query: query ?? "",
      detail: summarizeIssue(detail),
      taskRuns: Array.isArray(runs) ? runs : null,
      pullRequests: Array.isArray(prs) ? prs : null,
      children: Array.isArray(children) ? children : null,
    };
  }

  const list = await runBestEffort(runCli, [
    "issue", "list", "--output", "json", "--limit", String(limit),
  ]);
  const issues = Array.isArray(list?.issues) ? list.issues : Array.isArray(list) ? list : [];
  const grouped = {};
  for (const it of issues) {
    const key = it?.status_category ?? it?.status ?? "unknown";
    grouped[key] = grouped[key] ?? [];
    grouped[key].push(summarizeIssue(it));
  }
  return {
    ok: true,
    issues: issues.map(summarizeIssue),
    byStatus: grouped,
    count: issues.length,
  };
}

// Reduce an issue to the fields the cto agent needs; drop anything heavy or
// secret-laden. Pure.
export function summarizeIssue(issue) {
  if (!issue || typeof issue !== "object") return null;
  return {
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
    status: issue.status ?? null,
    status_category: issue.status_category ?? null,
    priority: issue.priority ?? null,
    assignee: issue.assignee_id ?? null,
    assignee_type: issue.assignee_type ?? null,
    updated_at: issue.updated_at ?? null,
    created_at: issue.created_at ?? null,
    labels: Array.isArray(issue.labels) ? issue.labels : null,
    description: typeof issue.description === "string" ? issue.description.slice(0, 400) : null,
    pr_url: issue.pr_url ?? null,
  };
}
